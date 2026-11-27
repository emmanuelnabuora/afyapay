import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { decryptField, lookupHashes, maskNationalId, normaliseNationalId } from '../../common/field-crypto';
import { PG_POOL } from '../../database/database.module';
import { normaliseKenyanMobile } from '../identity/phone';
import { normalisePolicyNumber } from '../policy/policy-link.service';
import type { StaffUser } from './staff-auth.guard';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "+254712345678" -> "+254 7** *** 678": enough to confirm with a caller, not enough to call them. */
export function maskForStaff(e164: string): string {
  return `${e164.slice(0, 4)} ${e164.slice(4, 5)}** *** ${e164.slice(-3)}`;
}

/**
 * Support looks a customer up by exact phone number, national ID number,
 * policy number or id;
 * there is no partial search, so the lookup cannot list customers. The phone
 * number is shown masked. Seeing it in full needs an approval from someone
 * else with the compliance or super administrator role, works only for the
 * person who asked and the field asked for, and lasts 30 minutes. The national
 * ID number is the same. Every lookup and view is audited.
 */
@Injectable()
export class CustomerLookupService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async lookup(actor: StaffUser, query: { phone?: unknown; policyNumber?: unknown; customerId?: unknown; insurerCode?: unknown; nationalId?: unknown }) {
    let ids: string[] = [];
    let by: string;
    if (typeof query.phone === 'string' && query.phone) {
      const e164 = normaliseKenyanMobile(query.phone);
      if (!e164) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'lookup.phone_invalid', 'Enter a full Kenyan mobile number.');
      ids = (await this.pool.query<{ id: string }>('select id from identity.customer where phone_e164 = $1', [e164])).rows.map((r) => r.id);
      by = 'phone';
    } else if (typeof query.policyNumber === 'string' && query.policyNumber) {
      const num = normalisePolicyNumber(query.policyNumber);
      if (!num) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'lookup.policy_invalid', 'Enter the full policy number.');
      const ins = typeof query.insurerCode === 'string' && query.insurerCode ? query.insurerCode.toUpperCase() : null;
      ids = (
        await this.pool.query<{ id: string }>(
          'select distinct l.customer_id as id from policy.policy_link l join insurer.insurer i on i.id = l.insurer_id where l.policy_number = $1 and ($2::text is null or i.code = $2) limit 20',
          [num, ins],
        )
      ).rows.map((r) => r.id);
      by = 'policy_number';
    } else if (typeof query.nationalId === 'string' && query.nationalId) {
      const nid = normaliseNationalId(query.nationalId);
      if (!nid) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'lookup.national_id_invalid', 'Enter the full national ID number: 7 or 8 digits.');
      ids = (await this.pool.query<{ id: string }>('select customer_id as id from identity.national_id where id_hmac = any($1)', [lookupHashes(nid, 'national-id')])).rows.map((r) => r.id);
      by = 'national_id';
    } else if (typeof query.customerId === 'string' && UUID.test(query.customerId)) {
      ids = (await this.pool.query<{ id: string }>('select id from identity.customer where id = $1', [query.customerId])).rows.map((r) => r.id);
      by = 'customer_id';
    } else {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'lookup.query_required', 'Look up by full phone number, national ID number, policy number or customer id.');
    }
    const customers = [];
    for (const id of ids) customers.push(await this.view(id));
    await this.tx((tx) => this.audit(tx, actor, 'customer.looked_up', 'customer_lookup', by, { by, found: ids }));
    return { customers };
  }

  async requestUnmask(actor: StaffUser, customerId: string, body: { reason?: unknown; field?: unknown }) {
    if (!UUID.test(customerId)) throw fail(HttpStatus.NOT_FOUND, 'customer.not_found', 'Customer not found.');
    const field = body.field ?? 'phone';
    if (field !== 'phone' && field !== 'national_id') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'unmask.field_invalid', 'field is phone or national_id.');
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 10 || reason.length > 500) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'unmask.reason_required', 'Say why you need the full number, such as the support case, in 10 to 500 characters.');
    return this.tx(async (tx) => {
      const c = await tx.query('select 1 from identity.customer where id = $1', [customerId]);
      if (!c.rowCount) throw fail(HttpStatus.NOT_FOUND, 'customer.not_found', 'Customer not found.');
      if (field === 'national_id' && !(await tx.query('select 1 from identity.national_id where customer_id = $1', [customerId])).rowCount) {
        throw fail(HttpStatus.NOT_FOUND, 'national_id.none', 'This customer has not added a national ID number.');
      }
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        "insert into governance.approval_request (kind, payload, reason, proposed_by) values ('customer_unmask', $1, $2, $3) returning id, created_at",
        [{ customerId, field }, reason, actor.id],
      );
      await this.audit(tx, actor, 'approval.proposed', 'approval_request', rows[0].id, { kind: 'customer_unmask', customerId, field });
      return { requestId: rows[0].id, field, status: 'proposed', createdAt: rows[0].created_at };
    });
  }

  /** The full number, for the person who asked, within 30 minutes of the approval. */
  async unmaskedPhone(actor: StaffUser, customerId: string, requestId: unknown) {
    if (!UUID.test(customerId) || typeof requestId !== 'string' || !UUID.test(requestId)) throw fail(HttpStatus.FORBIDDEN, 'unmask.not_approved', 'Ask for approval to see the full number first.');
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ ok: boolean }>("select governance.unmask_allowed($1, $2, $3, 'phone') as ok", [requestId, actor.id, customerId]);
      if (!rows[0].ok) throw fail(HttpStatus.FORBIDDEN, 'unmask.not_approved', 'There is no approval for you to see this number now. Approvals last 30 minutes.');
      const c = await tx.query<{ phone_e164: string }>('select phone_e164 from identity.customer where id = $1', [customerId]);
      await this.audit(tx, actor, 'customer.phone_unmasked', 'customer', customerId, { requestId });
      return { customerId, phone: c.rows[0].phone_e164 };
    });
  }

  /** The full national ID number, on the same terms as the phone number. */
  async unmaskedNationalId(actor: StaffUser, customerId: string, requestId: unknown) {
    if (!UUID.test(customerId) || typeof requestId !== 'string' || !UUID.test(requestId)) throw fail(HttpStatus.FORBIDDEN, 'unmask.not_approved', 'Ask for approval to see the full number first.');
    return this.tx(async (tx) => {
      const { rows } = await tx.query<{ ok: boolean }>("select governance.unmask_allowed($1, $2, $3, 'national_id') as ok", [requestId, actor.id, customerId]);
      if (!rows[0].ok) throw fail(HttpStatus.FORBIDDEN, 'unmask.not_approved', 'There is no approval for you to see this number now. Approvals last 30 minutes.');
      const n = await tx.query<{ id_enc: string }>('select id_enc from identity.national_id where customer_id = $1', [customerId]);
      if (!n.rows[0]) throw fail(HttpStatus.NOT_FOUND, 'national_id.none', 'This customer has not added a national ID number.');
      await this.audit(tx, actor, 'customer.national_id_unmasked', 'customer', customerId, { requestId });
      return { customerId, nationalId: decryptField(n.rows[0].id_enc) };
    });
  }

  private async view(id: string) {
    const c = (
      await this.pool.query(
        'select c.id, c.phone_e164, c.status, c.created_at, n.last_two, n.id_length from identity.customer c left join identity.national_id n on n.customer_id = c.id where c.id = $1',
        [id],
      )
    ).rows[0];
    const links = await this.pool.query(
      `select l.id, i.code as insurer, l.policy_number, l.status, l.requested_at, l.decided_at
         from policy.policy_link l join insurer.insurer i on i.id = l.insurer_id where l.customer_id = $1 order by l.requested_at`,
      [id],
    );
    const payments = await this.pool.query(
      `select p.id, l.policy_number, p.amount_minor::text as amount_minor, p.currency, p.status, p.created_at,
              (select r.mpesa_receipt from payment.payment_result r where r.payment_intent_id = p.id and r.result_code = 0 limit 1) as receipt
         from payment.payment_intent p join policy.policy_link l on l.id = p.policy_link_id
        where p.customer_id = $1 order by p.created_at desc limit 20`,
      [id],
    );
    const consents = await this.pool.query(
      `select distinct on (purpose, insurer_id) purpose, i.code as insurer, granted, text_version, recorded_at
         from identity.consent_record c left join insurer.insurer i on i.id = c.insurer_id
        where customer_id = $1 order by purpose, insurer_id, recorded_at desc`,
      [id],
    );
    return {
      id: c.id,
      phoneMasked: maskForStaff(c.phone_e164),
      nationalIdMasked: c.last_two ? maskNationalId(c.last_two, c.id_length) : null,
      status: c.status,
      createdAt: c.created_at,
      policies: links.rows.map((r) => ({ id: r.id, insurer: r.insurer, policyNumber: r.policy_number, status: r.status, requestedAt: r.requested_at, decidedAt: r.decided_at })),
      recentPayments: payments.rows.map((r) => ({ id: r.id, policyNumber: r.policy_number, amountMinor: r.amount_minor, currency: r.currency, status: r.status, receipt: r.receipt, createdAt: r.created_at })),
      consents: consents.rows.map((r) => ({ purpose: r.purpose, insurer: r.insurer, granted: r.granted, textVersion: r.text_version, recordedAt: r.recorded_at })),
    };
  }

  private async audit(tx: PoolClient, actor: StaffUser, action: string, subjectType: string, subjectId: string, after: unknown) {
    await tx.query("insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id, after_state) values ('staff_user', $1, $2, $3, $4, $5)", [actor.id, action, subjectType, subjectId, JSON.stringify(after)]);
  }

  private async tx<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      const result = await fn(tx);
      await tx.query('commit');
      return result;
    } catch (err) {
      await tx.query('rollback');
      throw err;
    } finally {
      tx.release();
    }
  }
}
