import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { PaymentService } from '../payment/payment.service';
import { OutboxService } from '../platform/outbox.service';
import { coverView, CoverView, eatDate, Frequency, moneyView, premiumPosition, PremiumPosition } from './tracks';

export type InsurerSource = 'insurer_portal' | 'insurer_file' | 'insurer_api';
export interface InsurerActor {
  insurerId: string;
  userId: string;
  source: InsurerSource;
}

export interface PolicyTracksView {
  policyLinkId: string;
  policyNumber: string;
  insurer: { code: string; name: string };
  money: ReturnType<typeof moneyView>;
  premium: PremiumPosition | { state: 'no_plan'; label: string };
  cover: CoverView;
}

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const SOURCES: InsurerSource[] = ['insurer_portal', 'insurer_file', 'insurer_api'];
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * The three tracks of each confirmed policy. Premium plans and cover changes
 * are written only from insurer sources (portal, file or API, E7); customers
 * and payments only read them.
 */
@Injectable()
export class PolicyTracksService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentService,
  ) {}

  /** The insurer sets or replaces the premium plan for a confirmed policy. */
  async setPremiumSchedule(linkId: string, actor: InsurerActor, plan: { frequency: Frequency; amountMinor: bigint; startsOn: string }): Promise<void> {
    if (!['daily', 'weekly', 'monthly', 'annual'].includes(plan.frequency)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'premium.frequency_invalid', 'Unknown premium frequency.');
    if (plan.amountMinor <= 0n || plan.amountMinor % 100n !== 0n) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'premium.amount_invalid', 'Premiums are whole shillings above zero.');
    if (!isDate(plan.startsOn)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'premium.start_invalid', 'Give the start date as YYYY-MM-DD.');
    this.checkSource(actor);
    await this.inTransaction(async (tx) => {
      await this.lockInsurerLink(tx, linkId, actor);
      try {
        await tx.query(
          `insert into policy.premium_schedule (policy_link_id, frequency, amount_minor, starts_on, source, recorded_by)
           values ($1, $2, $3, $4, $5, $6)`,
          [linkId, plan.frequency, plan.amountMinor.toString(), plan.startsOn, actor.source, actor.userId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw fail(HttpStatus.CONFLICT, 'premium.schedule_exists', 'A plan already starts on that date.');
        throw err;
      }
      await this.outbox.enqueue(tx, { topic: 'premium_schedule.set', aggregateType: 'policy_link', aggregateId: linkId, payload: { frequency: plan.frequency, amountMinor: plan.amountMinor.toString(), startsOn: plan.startsOn } });
      await this.audit(tx, actor.userId, 'premium_schedule.set', linkId);
    });
  }

  /** Records what the insurer says about cover. The database checks the change is allowed. */
  async recordCoverEvent(
    linkId: string,
    actor: InsurerActor,
    event: { status: 'active' | 'lapsed' | 'ended'; coveredUntil?: string; effectiveOn: string; insurerReference?: string },
  ): Promise<void> {
    if (!['active', 'lapsed', 'ended'].includes(event.status)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'cover.status_invalid', 'Unknown cover status.');
    if (!isDate(event.effectiveOn)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'cover.date_invalid', 'Give the effective date as YYYY-MM-DD.');
    if (event.status === 'active' && !isDate(event.coveredUntil)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'cover.until_required', 'Active cover needs a covered-until date.');
    this.checkSource(actor);
    await this.inTransaction(async (tx) => {
      await this.lockInsurerLink(tx, linkId, actor);
      const { rows } = await tx.query<{ next: number }>('select coalesce(max(seq), 0) + 1 as next from policy.cover_event where policy_link_id = $1', [linkId]);
      try {
        await tx.query(
          `insert into policy.cover_event (policy_link_id, seq, status, covered_until, effective_on, source, recorded_by, insurer_reference)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [linkId, rows[0].next, event.status, event.status === 'active' ? event.coveredUntil : null, event.effectiveOn, actor.source, actor.userId, event.insurerReference ?? null],
        );
      } catch (err) {
        if ((err as { code?: string }).code === 'P0001') throw fail(HttpStatus.CONFLICT, 'cover.transition_not_allowed', (err as Error).message);
        throw err;
      }
      await this.outbox.enqueue(tx, { topic: `cover.${event.status}`, aggregateType: 'policy_link', aggregateId: linkId, payload: { status: event.status, coveredUntil: event.coveredUntil ?? null, effectiveOn: event.effectiveOn } });
      await this.audit(tx, actor.userId, `cover.${event.status}`, linkId);
    });
  }

  async listForCustomer(customerId: string, now = new Date()): Promise<PolicyTracksView[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      "select id from policy.policy_link where customer_id = $1 and status = 'confirmed' order by requested_at",
      [customerId],
    );
    return Promise.all(rows.map((r) => this.tracks(r.id, now)));
  }

  async getForCustomer(customerId: string, linkId: string, now = new Date()): Promise<PolicyTracksView> {
    const owned = /^[0-9a-f-]{36}$/.test(linkId)
      ? await this.pool.query("select 1 from policy.policy_link where id = $1 and customer_id = $2 and status = 'confirmed'", [linkId, customerId])
      : { rowCount: 0 };
    if (!owned.rowCount) throw fail(HttpStatus.NOT_FOUND, 'policy.link_not_found', 'Policy not found.');
    return this.tracks(linkId, now);
  }

  private async tracks(linkId: string, now: Date): Promise<PolicyTracksView> {
    const today = eatDate(now);
    const link = (
      await this.pool.query<{ policy_number: string; code: string; name: string }>(
        'select l.policy_number, i.code, i.name from policy.policy_link l join insurer.insurer i on i.id = l.insurer_id where l.id = $1',
        [linkId],
      )
    ).rows[0];

    const lastPayment = await this.payments.latestForPolicy(linkId);

    // The plan in effect today, or the next one if none has started yet.
    const plan = (
      await this.pool.query<{ frequency: Frequency; amount_minor: string; starts_on: string; created_at: Date }>(
        `select frequency, amount_minor::text, to_char(starts_on, 'YYYY-MM-DD') as starts_on, created_at
           from policy.premium_schedule where policy_link_id = $1
          order by (starts_on <= $2::date) desc, case when starts_on <= $2::date then starts_on end desc, starts_on asc
          limit 1`,
        [linkId, today],
      )
    ).rows[0];

    let premium: PolicyTracksView['premium'] = { state: 'no_plan', label: `Waiting for ${link.name} to share your premium plan.` };
    if (plan) {
      // Confirmed, ledger-backed payments made for this plan.
      const since = new Date(Math.min(plan.created_at.getTime(), Date.parse(`${plan.starts_on}T00:00:00+03:00`)));
      const paid = await this.payments.confirmedTotalForPolicy(linkId, since);
      premium = premiumPosition({ frequency: plan.frequency, amountMinor: BigInt(plan.amount_minor), startsOn: plan.starts_on }, paid, link.name, today);
    }

    const cover = (
      await this.pool.query<{ status: 'active' | 'lapsed' | 'ended'; covered_until: string | null; effective_on: string; recorded_at: Date }>(
        `select status, to_char(covered_until, 'YYYY-MM-DD') as covered_until, to_char(effective_on, 'YYYY-MM-DD') as effective_on, recorded_at
           from policy.cover_event where policy_link_id = $1 order by seq desc limit 1`,
        [linkId],
      )
    ).rows[0];

    return {
      policyLinkId: linkId,
      policyNumber: link.policy_number,
      insurer: { code: link.code, name: link.name },
      money: moneyView(lastPayment, link.name),
      premium,
      cover: coverView(cover ? { status: cover.status, coveredUntil: cover.covered_until, effectiveOn: cover.effective_on, recordedAt: cover.recorded_at } : null, link.name, today),
    };
  }

  private checkSource(actor: InsurerActor) {
    if (!SOURCES.includes(actor.source) || !actor.userId) throw fail(HttpStatus.FORBIDDEN, 'insurer.source_required', 'Only an insurer source can change this.');
  }

  private async lockInsurerLink(tx: PoolClient, linkId: string, actor: InsurerActor) {
    const { rows } = await tx.query<{ insurer_id: string; status: string }>('select insurer_id, status from policy.policy_link where id = $1 for update', [linkId]);
    if (!rows[0] || rows[0].insurer_id !== actor.insurerId) throw fail(HttpStatus.NOT_FOUND, 'policy.link_not_found', 'Link not found.');
    if (rows[0].status !== 'confirmed') throw fail(HttpStatus.CONFLICT, 'policy.link_not_confirmed', 'Confirm the policy link first.');
  }

  private async audit(tx: PoolClient, userId: string, action: string, linkId: string) {
    await tx.query(
      "insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('insurer_user', $1, $2, 'policy_link', $3)",
      [userId, action, linkId],
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

