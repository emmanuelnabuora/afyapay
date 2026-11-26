import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { SHARE_WITH_INSURER_CONSENT } from '../identity/consent';
import { OutboxService } from '../platform/outbox.service';

export type LinkStatus = 'pending_insurer' | 'confirmed' | 'rejected' | 'unlinked';

export interface PolicyLinkView {
  id: string;
  insurer: { code: string; name: string };
  policyNumber: string;
  status: LinkStatus;
  requestedAt: Date;
  decidedAt: Date | null;
  rejectionReason: string | null;
}

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);

export function normalisePolicyNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9/-]{3,40}$/.test(v) ? v : null;
}

@Injectable()
export class PolicyLinkService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly outbox: OutboxService,
  ) {}

  async listInsurers(): Promise<Array<{ code: string; name: string; stage: string }>> {
    const { rows } = await this.pool.query('select code, name, stage from insurer.insurer order by name');
    return rows;
  }

  consentText(insurerName: string) {
    return { version: SHARE_WITH_INSURER_CONSENT.version, text: SHARE_WITH_INSURER_CONSENT.text.split('{insurer}').join(insurerName) };
  }

  /**
   * The customer asks to link a policy. They must accept the current consent
   * wording first; the link then waits for the insurer to confirm it.
   */
  async requestLink(customerId: string, body: { insurerCode?: unknown; policyNumber?: unknown; consent?: unknown; consentTextVersion?: unknown }): Promise<PolicyLinkView> {
    const policyNumber = normalisePolicyNumber(body.policyNumber);
    if (!policyNumber) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'policy.number_invalid', 'Enter the policy number exactly as it appears on your insurer’s documents.');
    if (body.consent !== true || body.consentTextVersion !== SHARE_WITH_INSURER_CONSENT.version) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'consent.required', `Accept consent ${SHARE_WITH_INSURER_CONSENT.version} to link a policy.`);
    }

    return this.inTransaction(async (tx) => {
      const ins = await tx.query<{ id: string; code: string; name: string }>('select id, code, name from insurer.insurer where code = $1', [body.insurerCode]);
      if (!ins.rows[0]) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'insurer.unknown', 'Choose an insurer from the list.');
      const insurer = ins.rows[0];

      await tx.query(
        `insert into identity.consent_record (customer_id, purpose, insurer_id, granted, text_version)
         values ($1, 'share_with_insurer', $2, true, $3)`,
        [customerId, insurer.id, SHARE_WITH_INSURER_CONSENT.version],
      );

      let linkId: string;
      try {
        const inserted = await tx.query<{ id: string }>(
          'insert into policy.policy_link (customer_id, insurer_id, policy_number) values ($1, $2, $3) returning id',
          [customerId, insurer.id, policyNumber],
        );
        linkId = inserted.rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          // Do not reveal whether someone else holds this policy number.
          throw fail(HttpStatus.CONFLICT, 'policy.link_exists', 'This policy is already linked or waiting for the insurer. Contact support if it is yours.');
        }
        throw err;
      }

      await this.outbox.enqueue(tx, {
        topic: 'policy_link.requested',
        aggregateType: 'policy_link',
        aggregateId: linkId,
        payload: { insurerCode: insurer.code, policyNumber },
      });
      await this.audit(tx, 'customer', customerId, 'policy_link.requested', linkId);
      return (await this.getView(tx, linkId))!;
    });
  }

  async listForCustomer(customerId: string): Promise<PolicyLinkView[]> {
    const { rows } = await this.pool.query<{ id: string }>('select id from policy.policy_link where customer_id = $1 order by requested_at desc', [customerId]);
    const client = await this.pool.connect();
    try {
      const views = await Promise.all(rows.map((r) => this.getView(client, r.id)));
      return views.filter((v): v is PolicyLinkView => v !== null);
    } finally {
      client.release();
    }
  }

  /**
   * The insurer confirms or rejects a pending link. Called from the insurer
   * portal or statement import (E7); never from a customer request.
   */
  async decide(linkId: string, decision: 'confirmed' | 'rejected', insurerActor: { insurerId: string; userId: string }, reason?: string): Promise<PolicyLinkView> {
    return this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ status: LinkStatus; insurer_id: string }>('select status, insurer_id from policy.policy_link where id = $1 for update', [linkId]);
      const link = rows[0];
      if (!link || link.insurer_id !== insurerActor.insurerId) throw fail(HttpStatus.NOT_FOUND, 'policy.link_not_found', 'Link not found.');
      if (link.status !== 'pending_insurer') throw fail(HttpStatus.CONFLICT, 'policy.link_already_decided', `This link is already ${link.status}.`);
      if (decision === 'rejected' && !reason) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'policy.rejection_reason_required', 'Give a reason the customer can act on.');

      await tx.query(
        `update policy.policy_link
            set status = $2, decided_at = now(), decided_by = $3, rejection_reason = $4, version = version + 1
          where id = $1`,
        [linkId, decision, insurerActor.userId, decision === 'rejected' ? reason : null],
      );
      await this.outbox.enqueue(tx, { topic: `policy_link.${decision}`, aggregateType: 'policy_link', aggregateId: linkId, payload: { decision } });
      await this.audit(tx, 'insurer_user', insurerActor.userId, `policy_link.${decision}`, linkId);
      return (await this.getView(tx, linkId))!;
    });
  }

  private async getView(db: Pool | PoolClient, linkId: string): Promise<PolicyLinkView | null> {
    const { rows } = await db.query(
      `select l.id, i.code, i.name, l.policy_number, l.status, l.requested_at, l.decided_at, l.rejection_reason
         from policy.policy_link l join insurer.insurer i on i.id = l.insurer_id
        where l.id = $1`,
      [linkId],
    );
    const r = rows[0];
    return r
      ? { id: r.id, insurer: { code: r.code, name: r.name }, policyNumber: r.policy_number, status: r.status, requestedAt: r.requested_at, decidedAt: r.decided_at, rejectionReason: r.rejection_reason }
      : null;
  }

  private async audit(tx: PoolClient, actorType: string, actorId: string, action: string, linkId: string) {
    await tx.query(
      "insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ($1, $2, $3, 'policy_link', $4)",
      [actorType, actorId, action, linkId],
    );
  }

  private async inTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
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
