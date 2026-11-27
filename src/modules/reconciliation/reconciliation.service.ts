import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { InsurerClaims } from '../insurer/insurer-auth.service';
import { InsurerScope } from '../insurer/insurer-scope';
import { DEFAULT_MAPPING, Mapping, normaliseRef, parseStatement } from './statement-parser';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);

/** Time an insurer has to resolve an exception. */
export const EXCEPTION_SLA_HOURS = 48;
export const MAX_STATEMENT_LINES = 20_000;
/** A statement date may differ from the M-Pesa confirmation date by this many days (cut-off times differ). */
export const DATE_TOLERANCE_DAYS = 1;

type ExceptionKind = 'unparseable_line' | 'duplicate_line' | 'unknown_receipt' | 'amount_mismatch' | 'policy_mismatch' | 'date_mismatch' | 'missing_from_statement';

interface PaymentFact {
  id: string;
  amount_minor: string;
  policy_number: string;
  paid_on: string;
}

const days = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const shillings = (minor: bigint) => `KES ${(minor / 100n).toString()}${minor % 100n ? `.${String(minor % 100n).padStart(2, '0')}` : ''}`;

export interface StatementSummary {
  id: string;
  fileName: string;
  lineCount: number;
  matched: number;
  alreadyMatched: number;
  exceptions: number;
  missingFromStatement: number;
  periodFrom: string | null;
  periodTo: string | null;
}

/**
 * Matches an insurer's statement against payments M-Pesa confirmed to that
 * insurer's paybill. Everything runs in InsurerScope, so it can only see and
 * write the signed-in insurer's rows.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly scope: InsurerScope) {}

  async getMapping(user: InsurerClaims): Promise<Mapping> {
    return this.scope.run(user.ins, (tx) => this.mapping(tx));
  }

  async setMapping(user: InsurerClaims, body: Record<string, unknown>): Promise<Mapping> {
    const col = (v: unknown, name: string) => {
      if (typeof v !== 'string' || !v.trim() || v.length > 60) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'mapping.invalid', `Give the column header for ${name}.`);
      return v.trim();
    };
    const m: Mapping = {
      receiptCol: col(body.receiptCol, 'the M-Pesa receipt'),
      policyCol: col(body.policyCol, 'the policy number'),
      amountCol: col(body.amountCol, 'the amount'),
      dateCol: col(body.dateCol, 'the payment date'),
      dateFormat: body.dateFormat === 'DD/MM/YYYY' ? 'DD/MM/YYYY' : body.dateFormat === undefined || body.dateFormat === 'YYYY-MM-DD' ? 'YYYY-MM-DD' : (() => { throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'mapping.date_format', 'Date format must be YYYY-MM-DD or DD/MM/YYYY.'); })(),
    };
    return this.scope.run(user.ins, async (tx) => {
      await tx.query(
        `insert into reconciliation.statement_mapping (insurer_id, receipt_col, policy_col, amount_col, date_col, date_format, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (insurer_id) do update set receipt_col = excluded.receipt_col, policy_col = excluded.policy_col, amount_col = excluded.amount_col,
           date_col = excluded.date_col, date_format = excluded.date_format, updated_by = excluded.updated_by, updated_at = now()`,
        [user.ins, m.receiptCol, m.policyCol, m.amountCol, m.dateCol, m.dateFormat, user.sub],
      );
      await this.audit(tx, user, 'statement_mapping.set', user.ins, 'insurer');
      return m;
    });
  }

  async upload(user: InsurerClaims, file: { originalname: string; buffer: Buffer } | undefined): Promise<StatementSummary> {
    if (!file?.buffer?.length) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'statement.file_required', 'Attach the statement as a CSV file.');
    const name = (file.originalname || 'statement.csv').slice(0, 200);
    if (!/\.csv$/i.test(name)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'statement.csv_only', 'Upload a CSV file. Save Excel statements as CSV first; PDF statements go to manual review.');
    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const text = file.buffer.toString('utf8');

    return this.scope.run(user.ins, async (tx) => {
      const dup = await tx.query('select id from reconciliation.statement where file_sha256 = $1', [sha]);
      if (dup.rowCount) throw fail(HttpStatus.CONFLICT, 'statement.duplicate', 'This exact file was already uploaded.');

      const mapping = await this.mapping(tx);
      const { lines, missingColumns } = parseStatement(text, mapping);
      if (missingColumns.length) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'statement.columns_missing', `The file has no column named: ${missingColumns.join(', ')}. Check the column mapping.`);
      if (lines.length === 0) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'statement.empty', 'The file has no payment lines.');
      if (lines.length > MAX_STATEMENT_LINES) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'statement.too_large', `Split statements over ${MAX_STATEMENT_LINES} lines.`);

      const receipts = [...new Set(lines.filter((l) => l.ok).map((l) => (l as { receipt: string }).receipt))];
      const facts = new Map<string, PaymentFact>();
      const found = await tx.query<PaymentFact & { mpesa_receipt: string }>(
        `select r.mpesa_receipt, p.id, p.amount_minor::text, l.policy_number,
                to_char((r.created_at at time zone 'Africa/Nairobi')::date, 'YYYY-MM-DD') as paid_on
           from payment.payment_result r
           join payment.payment_intent p on p.id = r.payment_intent_id
           join policy.policy_link l on l.id = p.policy_link_id
          where r.result_code = 0 and r.mpesa_receipt = any($1)`,
        [receipts],
      );
      for (const f of found.rows) facts.set(f.mpesa_receipt, f);
      const matchedBefore = new Set(
        (await tx.query<{ id: string }>("select payment_intent_id as id from reconciliation.statement_line where outcome = 'matched' and payment_intent_id = any($1)", [found.rows.map((f) => f.id)])).rows.map((r) => r.id),
      );

      // Decide each line.
      const seen = new Set<string>();
      const rows: Array<{ lineNo: number; receipt: string | null; policy: string | null; amount: string | null; paidOn: string | null; outcome: string; intentId: string | null; exception?: { kind: ExceptionKind; detail: string } }> = [];
      for (const l of lines) {
        if (!l.ok) {
          rows.push({ lineNo: l.lineNo, receipt: l.receipt, policy: null, amount: null, paidOn: null, outcome: 'exception', intentId: null, exception: { kind: 'unparseable_line', detail: `Line ${l.lineNo}: ${l.error}.` } });
          continue;
        }
        const base = { lineNo: l.lineNo, receipt: l.receipt, policy: l.policyNumber, amount: l.amountMinor.toString(), paidOn: l.paidOn };
        if (seen.has(l.receipt)) {
          rows.push({ ...base, outcome: 'exception', intentId: null, exception: { kind: 'duplicate_line', detail: `Line ${l.lineNo}: receipt ${l.receipt} appears more than once in this file.` } });
          continue;
        }
        seen.add(l.receipt);
        const f = facts.get(l.receipt);
        if (!f) {
          rows.push({ ...base, outcome: 'exception', intentId: null, exception: { kind: 'unknown_receipt', detail: `Line ${l.lineNo}: no payment made through AfyaPay has M-Pesa receipt ${l.receipt}.` } });
          continue;
        }
        const problems: Array<{ kind: ExceptionKind; text: string }> = [];
        if (BigInt(f.amount_minor) !== l.amountMinor) problems.push({ kind: 'amount_mismatch', text: `amount ${shillings(l.amountMinor)} in the statement, ${shillings(BigInt(f.amount_minor))} paid` });
        if (normaliseRef(f.policy_number) !== l.policyNumber) problems.push({ kind: 'policy_mismatch', text: `policy ${l.policyNumber} in the statement, ${f.policy_number} on the payment` });
        if (Math.abs(days(f.paid_on) - days(l.paidOn)) > DATE_TOLERANCE_DAYS) problems.push({ kind: 'date_mismatch', text: `date ${l.paidOn} in the statement, ${f.paid_on} confirmed by M-Pesa` });
        if (problems.length) {
          rows.push({ ...base, outcome: 'exception', intentId: f.id, exception: { kind: problems[0].kind, detail: `Line ${l.lineNo}, receipt ${l.receipt}: ${problems.map((p) => p.text).join('; ')}.` } });
        } else {
          rows.push({ ...base, outcome: matchedBefore.has(f.id) ? 'already_matched' : 'matched', intentId: f.id });
        }
      }

      const okDates = rows.map((r) => r.paidOn).filter((d): d is string => d !== null).sort();
      const periodFrom = okDates[0] ?? null;
      const periodTo = okDates[okDates.length - 1] ?? null;
      const counts = { matched: rows.filter((r) => r.outcome === 'matched').length, already: rows.filter((r) => r.outcome === 'already_matched').length, exceptions: rows.filter((r) => r.exception).length };

      const st = await tx.query<{ id: string }>(
        `insert into reconciliation.statement (insurer_id, file_name, file_sha256, uploaded_by, line_count, matched_count, exception_count, period_from, period_to)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [user.ins, name, sha, user.sub, rows.length, counts.matched + counts.already, counts.exceptions, periodFrom, periodTo],
      );
      const statementId = st.rows[0].id;
      const inserted = await tx.query<{ id: string; line_no: number }>(
        `insert into reconciliation.statement_line (statement_id, insurer_id, line_no, mpesa_receipt, policy_number, amount_minor, paid_on, outcome, payment_intent_id)
         select $1, $2, * from unnest($3::int[], $4::text[], $5::text[], $6::bigint[], $7::date[], $8::text[], $9::uuid[])
         returning id, line_no`,
        [statementId, user.ins, rows.map((r) => r.lineNo), rows.map((r) => r.receipt), rows.map((r) => r.policy), rows.map((r) => r.amount), rows.map((r) => r.paidOn), rows.map((r) => r.outcome), rows.map((r) => r.intentId)],
      );
      const lineIds = new Map(inserted.rows.map((r) => [r.line_no, r.id]));
      const exc = rows.filter((r) => r.exception);
      if (exc.length) {
        await tx.query(
          `insert into reconciliation.exception (insurer_id, kind, statement_line_id, payment_intent_id, detail, due_at)
           select $1, k, l, p, d, now() + make_interval(hours => $2) from unnest($3::text[], $4::uuid[], $5::uuid[], $6::text[]) as t(k, l, p, d)`,
          [user.ins, EXCEPTION_SLA_HOURS, exc.map((r) => r.exception!.kind), exc.map((r) => lineIds.get(r.lineNo)), exc.map((r) => r.intentId), exc.map((r) => r.exception!.detail)],
        );
      }

      // A newly matched payment clears its open "missing from statement" exception.
      const nowMatched = rows.filter((r) => r.outcome === 'matched').map((r) => r.intentId);
      if (nowMatched.length) {
        await tx.query(
          `update reconciliation.exception set status = 'resolved', resolved_at = now(), resolved_by = 'system',
                  resolution_note = $2
            where kind = 'missing_from_statement' and status = 'open' and payment_intent_id = any($1)`,
          [nowMatched, `Matched in statement ${name}.`],
        );
      }

      // Payments confirmed within the statement's dates that it does not list.
      let missing = 0;
      if (periodFrom && periodTo) {
        const res = await tx.query(
          `insert into reconciliation.exception (insurer_id, kind, payment_intent_id, detail, due_at)
           select $1, 'missing_from_statement', p.id,
                  'M-Pesa receipt ' || r.mpesa_receipt || ' for KES ' || (p.amount_minor / 100)::text || ' on ' ||
                  to_char((r.created_at at time zone 'Africa/Nairobi')::date, 'YYYY-MM-DD') || ' is not in statement ' || $4 || '.',
                  now() + make_interval(hours => $5)
             from payment.payment_result r join payment.payment_intent p on p.id = r.payment_intent_id
            where r.result_code = 0
              and (r.created_at at time zone 'Africa/Nairobi')::date between $2::date and $3::date
              and not exists (select 1 from reconciliation.statement_line s where s.payment_intent_id = p.id and s.outcome in ('matched', 'already_matched'))
              and not (r.mpesa_receipt = any($6))
           on conflict (payment_intent_id) where kind = 'missing_from_statement' and status = 'open' do nothing`,
          [user.ins, periodFrom, periodTo, name, EXCEPTION_SLA_HOURS, receipts],
        );
        missing = res.rowCount ?? 0;
      }

      await this.audit(tx, user, 'statement.uploaded', statementId, 'statement');
      return { id: statementId, fileName: name, lineCount: rows.length, matched: counts.matched, alreadyMatched: counts.already, exceptions: counts.exceptions, missingFromStatement: missing, periodFrom, periodTo };
    });
  }

  async listStatements(user: InsurerClaims) {
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query(
        `select id, file_name, line_count, matched_count, exception_count, to_char(period_from, 'YYYY-MM-DD') as period_from,
                to_char(period_to, 'YYYY-MM-DD') as period_to, uploaded_by, created_at
           from reconciliation.statement order by created_at desc limit 200`,
      );
      return rows.map((r) => ({ id: r.id, fileName: r.file_name, lineCount: r.line_count, matched: r.matched_count, exceptions: r.exception_count, periodFrom: r.period_from, periodTo: r.period_to, uploadedBy: r.uploaded_by, uploadedAt: r.created_at }));
    });
  }

  async listExceptions(user: InsurerClaims, status?: unknown) {
    const s = status === 'resolved' ? 'resolved' : status === 'all' ? null : 'open';
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query(
        `select id, kind, detail, status, owner_user_id, due_at, due_at < now() and status = 'open' as overdue, resolution_note, resolved_by, resolved_at, created_at,
                statement_line_id, payment_intent_id
           from reconciliation.exception where ($1::text is null or status = $1) order by due_at limit 1000`,
        [s],
      );
      return rows.map((r) => ({
        id: r.id, kind: r.kind, detail: r.detail, status: r.status, owner: r.owner_user_id, dueAt: r.due_at, overdue: r.overdue,
        resolution: r.resolution_note ? { note: r.resolution_note, by: r.resolved_by, at: r.resolved_at } : null,
        statementLineId: r.statement_line_id, paymentId: r.payment_intent_id, createdAt: r.created_at,
      }));
    });
  }

  /** Takes ownership of an open exception. */
  async assign(user: InsurerClaims, id: string) {
    return this.changeException(user, id, async (tx) => {
      await tx.query("update reconciliation.exception set owner_user_id = $2 where id = $1 and status = 'open'", [id, user.sub]);
      await this.audit(tx, user, 'exception.assigned', id, 'reconciliation_exception');
    });
  }

  async resolve(user: InsurerClaims, id: string, body: { note?: unknown }) {
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
    if (note.length < 5) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'exception.note_required', 'Say how the exception was resolved.');
    return this.changeException(user, id, async (tx) => {
      await tx.query(
        "update reconciliation.exception set status = 'resolved', resolution_note = $2, resolved_by = $3, resolved_at = now(), owner_user_id = coalesce(owner_user_id, $3) where id = $1",
        [id, note, user.sub],
      );
      await this.audit(tx, user, 'exception.resolved', id, 'reconciliation_exception');
    });
  }

  /** Confirmed collections per East Africa day, in exact cents. */
  async dailyCollections(user: InsurerClaims, query: { from?: unknown; to?: unknown }) {
    const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query(
        `select to_char((r.created_at at time zone 'Africa/Nairobi')::date, 'YYYY-MM-DD') as day, count(*)::int as payments, sum(p.amount_minor)::text as total_minor
           from payment.payment_result r join payment.payment_intent p on p.id = r.payment_intent_id
          where r.result_code = 0
            and ($1::date is null or (r.created_at at time zone 'Africa/Nairobi')::date >= $1::date)
            and ($2::date is null or (r.created_at at time zone 'Africa/Nairobi')::date <= $2::date)
          group by 1 order by 1 desc limit 366`,
        [date(query.from), date(query.to)],
      );
      return rows.map((r) => ({ day: r.day, payments: r.payments, totalMinor: r.total_minor, currency: 'KES' }));
    });
  }

  /** Open exceptions by age, and how many are past their due time. */
  async exceptionAgeing(user: InsurerClaims) {
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ bucket: string; n: number }>(
        `select case when now() - created_at < interval '1 day' then 'under_1_day'
                     when now() - created_at < interval '3 days' then '1_to_3_days'
                     when now() - created_at < interval '7 days' then '3_to_7_days'
                     else 'over_7_days' end as bucket, count(*)::int as n
           from reconciliation.exception where status = 'open' group by 1`,
      );
      const overdue = await tx.query<{ n: number }>("select count(*)::int as n from reconciliation.exception where status = 'open' and due_at < now()");
      const by = Object.fromEntries(rows.map((r) => [r.bucket, r.n]));
      return { under_1_day: by.under_1_day ?? 0, '1_to_3_days': by['1_to_3_days'] ?? 0, '3_to_7_days': by['3_to_7_days'] ?? 0, over_7_days: by.over_7_days ?? 0, overdue: overdue.rows[0].n };
    });
  }

  private async changeException(user: InsurerClaims, id: string, fn: (tx: PoolClient) => Promise<void>) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw fail(HttpStatus.NOT_FOUND, 'exception.not_found', 'Exception not found.');
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ status: string }>('select status from reconciliation.exception where id = $1 for update', [id]);
      if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'exception.not_found', 'Exception not found.');
      if (rows[0].status !== 'open') throw fail(HttpStatus.CONFLICT, 'exception.already_resolved', 'This exception is already resolved.');
      await fn(tx);
      const r = await tx.query('select id, status, owner_user_id as owner, resolution_note, resolved_by, resolved_at from reconciliation.exception where id = $1', [id]);
      return r.rows[0];
    });
  }

  private async mapping(tx: PoolClient): Promise<Mapping> {
    const { rows } = await tx.query('select receipt_col, policy_col, amount_col, date_col, date_format from reconciliation.statement_mapping');
    const r = rows[0];
    return r ? { receiptCol: r.receipt_col, policyCol: r.policy_col, amountCol: r.amount_col, dateCol: r.date_col, dateFormat: r.date_format } : DEFAULT_MAPPING;
  }

  private async audit(tx: PoolClient, user: InsurerClaims, action: string, subjectId: string, subjectType: string) {
    await tx.query("insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('insurer_user', $1, $2, $3, $4)", [user.sub, action, subjectType, subjectId]);
  }
}
