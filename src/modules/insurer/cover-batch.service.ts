import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PolicyTracksService } from '../policy/policy-tracks.service';
import { normalisePolicyNumber } from '../policy/policy-link.service';
import { readRows, UploadedFile } from '../reconciliation/file-rows';
import { InsurerClaims } from './insurer-auth.service';
import { InsurerScope } from './insurer-scope';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);

/** Batches larger than this wait for a second person with the approver role. */
export const BULK_SECOND_APPROVER_OVER = 50;
export const MAX_BATCH_ITEMS = 5000;
const COLUMNS = ['policy_number', 'status', 'covered_until', 'effective_on', 'reference'];

interface Item {
  lineNo: number;
  policyNumber: string;
  status: string;
  coveredUntil: string | null;
  effectiveOn: string | null;
  reference: string | null;
}

/**
 * Cover changes from a file. Small batches apply at once; batches over the
 * threshold are proposed by one person and applied only when a different
 * approver accepts them. Each item goes through the same checks as a single
 * cover event, so a bad line fails alone and the rest still apply.
 */
@Injectable()
export class CoverBatchService {
  constructor(
    private readonly scope: InsurerScope,
    private readonly tracks: PolicyTracksService,
  ) {}

  async propose(user: InsurerClaims, file: UploadedFile | undefined) {
    const { rows } = await readRows(file);
    if (rows.length < 2) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'cover_batch.empty', 'The file has no cover lines.');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const missing = COLUMNS.filter((c) => c !== 'reference' && !header.includes(c));
    if (missing.length) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'cover_batch.columns_missing', `The file needs these columns: ${COLUMNS.join(', ')}. Missing: ${missing.join(', ')}.`);
    const col = (r: string[], name: string) => (header.indexOf(name) >= 0 ? (r[header.indexOf(name)] ?? '').trim() : '');
    const items: Item[] = rows.slice(1).map((r, i) => ({
      lineNo: i + 2,
      policyNumber: normalisePolicyNumber(col(r, 'policy_number')) ?? col(r, 'policy_number').toUpperCase(),
      status: col(r, 'status').toLowerCase(),
      coveredUntil: col(r, 'covered_until') || null,
      effectiveOn: col(r, 'effective_on') || null,
      reference: col(r, 'reference') || null,
    }));
    if (items.length > MAX_BATCH_ITEMS) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'cover_batch.too_large', `Split batches over ${MAX_BATCH_ITEMS} lines.`);
    const needsSecond = items.length > BULK_SECOND_APPROVER_OVER;

    return this.scope.run(user.ins, async (tx) => {
      const { rows: b } = await tx.query<{ id: string }>(
        'insert into policy.cover_batch (insurer_id, file_name, item_count, needs_second_approver, proposed_by) values ($1, $2, $3, $4, $5) returning id',
        [user.ins, (file?.originalname ?? 'cover.csv').slice(0, 200), items.length, needsSecond, user.sub],
      );
      const batchId = b[0].id;
      await tx.query(
        `insert into policy.cover_batch_item (batch_id, insurer_id, line_no, policy_number, status, covered_until, effective_on, insurer_reference)
         select $1, $2, l, p, s, case when cu ~ '^\\d{4}-\\d{2}-\\d{2}$' then cu::date end, case when eo ~ '^\\d{4}-\\d{2}-\\d{2}$' then eo::date end, r
           from unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) as t(l, p, s, cu, eo, r)`,
        [batchId, user.ins, items.map((i) => i.lineNo), items.map((i) => i.policyNumber), items.map((i) => i.status), items.map((i) => i.coveredUntil ?? ''), items.map((i) => i.effectiveOn ?? ''), items.map((i) => i.reference)],
      );
      await this.audit(tx, user, 'cover_batch.proposed', batchId);
      if (!needsSecond) await this.apply(tx, user, batchId);
      return this.view(tx, batchId);
    });
  }

  /** A second person with the approver role accepts the batch, which then applies. */
  async approve(user: InsurerClaims, batchId: string, body: { note?: unknown }) {
    return this.decide(user, batchId, async (tx) => {
      await this.apply(tx, user, batchId, typeof body.note === 'string' ? body.note.slice(0, 500) : null);
      await this.audit(tx, user, 'cover_batch.approved', batchId);
    });
  }

  async reject(user: InsurerClaims, batchId: string, body: { note?: unknown }) {
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    if (note.length < 5) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'cover_batch.note_required', 'Say why the batch is rejected.');
    return this.decide(user, batchId, async (tx) => {
      await tx.query("update policy.cover_batch set status = 'rejected', decided_by = $2, decision_note = $3, decided_at = now() where id = $1", [batchId, user.sub, note]);
      await this.audit(tx, user, 'cover_batch.rejected', batchId);
    });
  }

  async list(user: InsurerClaims) {
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('select id from policy.cover_batch order by created_at desc limit 100');
      const out = [];
      for (const r of rows) out.push(await this.view(tx, r.id)); // one query at a time on a transaction
      return out;
    });
  }

  async get(user: InsurerClaims, batchId: string) {
    if (!/^[0-9a-f-]{36}$/.test(batchId)) throw fail(HttpStatus.NOT_FOUND, 'cover_batch.not_found', 'Batch not found.');
    return this.scope.run(user.ins, async (tx) => {
      const v = await this.view(tx, batchId, true);
      if (!v) throw fail(HttpStatus.NOT_FOUND, 'cover_batch.not_found', 'Batch not found.');
      return v;
    });
  }

  private async decide(user: InsurerClaims, batchId: string, fn: (tx: PoolClient) => Promise<void>) {
    if (!/^[0-9a-f-]{36}$/.test(batchId)) throw fail(HttpStatus.NOT_FOUND, 'cover_batch.not_found', 'Batch not found.');
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ status: string; proposed_by: string; needs_second_approver: boolean }>('select status, proposed_by, needs_second_approver from policy.cover_batch where id = $1 for update', [batchId]);
      const b = rows[0];
      if (!b) throw fail(HttpStatus.NOT_FOUND, 'cover_batch.not_found', 'Batch not found.');
      if (b.status !== 'proposed') throw fail(HttpStatus.CONFLICT, 'cover_batch.already_decided', `This batch is already ${b.status}.`);
      if (b.proposed_by === user.sub) throw fail(HttpStatus.FORBIDDEN, 'cover_batch.second_person', 'Someone other than the proposer must approve or reject this batch.');
      await fn(tx);
      return this.view(tx, batchId);
    });
  }

  /** Applies every item, each in its own savepoint so one bad line cannot undo the rest. */
  private async apply(tx: PoolClient, user: InsurerClaims, batchId: string, note: string | null = null) {
    const { rows: items } = await tx.query<{ id: string; line_no: number; policy_number: string; status: string; covered_until: string | null; effective_on: string | null; insurer_reference: string | null }>(
      `select id, line_no, policy_number, status, to_char(covered_until, 'YYYY-MM-DD') as covered_until, to_char(effective_on, 'YYYY-MM-DD') as effective_on, insurer_reference
         from policy.cover_batch_item where batch_id = $1 order by line_no`,
      [batchId],
    );
    const links = new Map(
      (await tx.query<{ id: string; policy_number: string }>("select id, policy_number from policy.policy_link where status = 'confirmed' and policy_number = any($1)", [items.map((i) => i.policy_number)])).rows.map((r) => [r.policy_number, r.id]),
    );
    let applied = 0;
    const results: Array<{ id: string; ok: boolean; error: string | null }> = [];
    for (const item of items) {
      const linkId = links.get(item.policy_number);
      let error: string | null = null;
      if (!linkId) error = `Line ${item.line_no}: no confirmed policy ${item.policy_number}.`;
      else if (!['active', 'lapsed', 'ended'].includes(item.status)) error = `Line ${item.line_no}: status must be active, lapsed or ended.`;
      else {
        await tx.query('savepoint cover_item');
        try {
          await this.tracks.recordCoverEvent(
            linkId,
            { insurerId: user.ins, userId: user.sub, source: 'insurer_file' },
            { status: item.status as 'active' | 'lapsed' | 'ended', coveredUntil: item.covered_until ?? undefined, effectiveOn: item.effective_on ?? '', insurerReference: item.insurer_reference ?? undefined },
            tx,
          );
          await tx.query('release savepoint cover_item');
        } catch (err) {
          await tx.query('rollback to savepoint cover_item');
          const body = (err as HttpException).getResponse?.() as { message?: string } | undefined;
          error = `Line ${item.line_no}: ${body?.message ?? (err as Error).message}`;
        }
      }
      if (!error) applied++;
      results.push({ id: item.id, ok: !error, error });
    }
    await tx.query(
      'insert into policy.cover_batch_result (item_id, insurer_id, applied, error) select i, $1, a, e from unnest($2::uuid[], $3::boolean[], $4::text[]) as t(i, a, e)',
      [user.ins, results.map((r) => r.id), results.map((r) => r.ok), results.map((r) => r.error)],
    );
    await tx.query(
      "update policy.cover_batch set status = 'applied', decided_by = $2, decision_note = $3, applied_count = $4, failed_count = $5, decided_at = now() where id = $1",
      [batchId, user.sub, note, applied, items.length - applied],
    );
  }

  private async view(tx: PoolClient, batchId: string, withItems = false) {
    const { rows } = await tx.query('select id, file_name, item_count, needs_second_approver, status, proposed_by, decided_by, decision_note, applied_count, failed_count, created_at, decided_at from policy.cover_batch where id = $1', [batchId]);
    const b = rows[0];
    if (!b) return null;
    const view: Record<string, unknown> = {
      id: b.id, fileName: b.file_name, items: b.item_count, needsSecondApprover: b.needs_second_approver, status: b.status,
      proposedBy: b.proposed_by, decidedBy: b.decided_by, decisionNote: b.decision_note, applied: b.applied_count, failed: b.failed_count, createdAt: b.created_at, decidedAt: b.decided_at,
    };
    if (withItems || b.failed_count) {
      const errs = await tx.query("select r.error from policy.cover_batch_result r join policy.cover_batch_item i on i.id = r.item_id where i.batch_id = $1 and not r.applied order by i.line_no limit 500", [batchId]);
      view.errors = errs.rows.map((r) => r.error);
    }
    return view;
  }

  private async audit(tx: PoolClient, user: InsurerClaims, action: string, batchId: string) {
    await tx.query("insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('insurer_user', $1, $2, 'cover_batch', $3)", [user.sub, action, batchId]);
  }
}
