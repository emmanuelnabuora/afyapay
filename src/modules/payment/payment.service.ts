import { timingSafeEqual } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { callbackItem, CONFIRM_STK_JOB, InboxService } from '../inbox/inbox.service';
import { LedgerService } from '../ledger/ledger.service';
import { JobQueueService } from '../platform/job-queue.service';
import { OutboxService } from '../platform/outbox.service';
import { CollectionMode, GatewayResolver } from './gateway.resolver';
import { describeResult, RESULT_CODES } from './mpesa.gateway';

export type PaymentStatus = 'created' | 'prompt_sent' | 'confirmed' | 'failed' | 'expired' | 'needs_review';

export interface PaymentView {
  id: string;
  policyLinkId: string;
  policyNumber: string;
  insurer: { code: string; name: string };
  amountMinor: string; // BIGINT as a string so no precision is lost in JSON
  currency: 'KES';
  status: PaymentStatus;
  failure: { code: string; message: string } | null;
  receipt: { mpesaReceipt: string | null; confirmedAt: Date } | null;
  createdAt: Date;
}

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);

/** How long a prompt may stay unanswered before we stop asking M-Pesa about it. */
export const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
/** First safety-net status query, in case the callback never arrives. */
export const SAFETY_NET_DELAY_MS = 90 * 1000;

export function parseAmountMinor(input: unknown): bigint | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input);
  if (!/^[0-9]{1,12}$/.test(s)) return null;
  return BigInt(s);
}

/**
 * MPESA_CALLBACK_SECRET_PREVIOUS is accepted too while a rotation is under way,
 * so callbacks for prompts sent before the change still arrive.
 */
export function callbackSecretMatches(given: string): boolean {
  const a = Buffer.from(given);
  return [process.env.MPESA_CALLBACK_SECRET, process.env.MPESA_CALLBACK_SECRET_PREVIOUS].some((expected) => {
    if (!expected || expected.length < 16) return false;
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Premium payments by M-Pesa STK push. The prompt pays the insurer's own
 * paybill directly; AfyaPay only records the request and its confirmed result.
 * A payment changes the premium position, never the policy's cover.
 */
@Injectable()
export class PaymentService {
  private readonly log = new Logger('PaymentService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly gateways: GatewayResolver,
    private readonly inbox: InboxService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobQueueService,
  ) {}

  async start(customerId: string, body: { policyLinkId?: unknown; amountMinor?: unknown }): Promise<PaymentView> {
    const amountMinor = parseAmountMinor(body.amountMinor);
    if (amountMinor === null || amountMinor < 100n || amountMinor > 15_000_000n) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'payment.amount_invalid', 'Enter an amount between KES 1 and KES 150,000.');
    }
    if (amountMinor % 100n !== 0n) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'payment.amount_not_whole', 'M-Pesa takes whole shillings only.');
    }
    if (typeof body.policyLinkId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.policyLinkId)) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'payment.policy_required', 'Choose a linked policy to pay for.');
    }

    // 1. Record the intent first, so a crash after the prompt still leaves a trace.
    const intent = await this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ status: string; insurer_id: string; policy_number: string; phone_e164: string; account_id: string | null; shortcode: string; mode: CollectionMode; passkey_ref: string | null }>(
        `select l.status, l.insurer_id, l.policy_number, c.phone_e164,
                a.id as account_id, a.shortcode, a.mode, a.passkey_ref
           from policy.policy_link l
           join identity.customer c on c.id = l.customer_id
           left join insurer.collection_account a on a.insurer_id = l.insurer_id and a.active
          where l.id = $1 and l.customer_id = $2`,
        [body.policyLinkId, customerId],
      );
      const link = rows[0];
      if (!link) throw fail(HttpStatus.NOT_FOUND, 'policy.link_not_found', 'Policy not found.');
      if (link.status !== 'confirmed') throw fail(HttpStatus.CONFLICT, 'payment.policy_not_confirmed', 'You can pay once your insurer has confirmed this policy.');
      if (!link.account_id) throw fail(HttpStatus.CONFLICT, 'payment.insurer_not_ready', 'This insurer is not taking M-Pesa payments through AfyaPay yet.');

      let id: string;
      try {
        const inserted = await tx.query<{ id: string }>(
          `insert into payment.payment_intent (customer_id, policy_link_id, insurer_id, collection_account_id, amount_minor)
           values ($1, $2, $3, $4, $5) returning id`,
          [customerId, body.policyLinkId, link.insurer_id, link.account_id, amountMinor.toString()],
        );
        id = inserted.rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw fail(HttpStatus.CONFLICT, 'payment.prompt_open', 'An M-Pesa prompt for this policy is already open. Answer it on your phone or wait a few minutes.');
        }
        throw err;
      }
      await this.audit(tx, 'customer', customerId, 'payment.started', id);
      return { id, ...link };
    });

    // 2. Ask M-Pesa to prompt the customer. Money goes to the insurer's shortcode.
    try {
      const res = await this.gateways.for(intent.mode).stkPush({
        shortcode: intent.shortcode,
        passkeyRef: intent.passkey_ref,
        amountMinor,
        phoneE164: intent.phone_e164,
        accountReference: intent.policy_number,
        description: 'Premium',
        callbackUrl: this.callbackUrl(),
      });
      await this.inTransaction(async (tx) => {
        await tx.query(
          'insert into payment.stk_request (payment_intent_id, merchant_request_id, checkout_request_id, response_code) values ($1, $2, $3, $4)',
          [intent.id, res.merchantRequestId, res.checkoutRequestId, res.responseCode],
        );
        await tx.query("update payment.payment_intent set status = 'prompt_sent', updated_at = now(), version = version + 1 where id = $1", [intent.id]);
        await this.outbox.enqueue(tx, { topic: 'payment.prompt_sent', aggregateType: 'payment_intent', aggregateId: intent.id, payload: {} });
      });
      await this.jobs.enqueue(
        CONFIRM_STK_JOB,
        { checkoutRequestId: res.checkoutRequestId },
        { runAt: new Date(Date.now() + SAFETY_NET_DELAY_MS), maxAttempts: 8, dedupeKey: `confirm-net:${res.checkoutRequestId}` },
      );
    } catch (err) {
      this.log.warn(`STK push failed for intent ${intent.id}: ${(err as Error).message}`);
      await this.inTransaction(async (tx) => {
        const res = await tx.query(
          "update payment.payment_intent set status = 'failed', failure_code = 'prompt_not_sent', updated_at = now(), version = version + 1 where id = $1 and status = 'created'",
          [intent.id],
        );
        if (res.rowCount) {
          await this.outbox.enqueue(tx, { topic: 'payment.failed', aggregateType: 'payment_intent', aggregateId: intent.id, payload: { failureCode: 'prompt_not_sent' } });
        }
      });
    }
    return (await this.view(this.pool, intent.id))!;
  }

  /**
   * Confirms a payment by asking M-Pesa directly. Runs from the job queue after
   * a callback arrives and as a safety net when none does. Safe to repeat.
   * Returns 'pending' when M-Pesa has no final answer yet, so the job retries.
   */
  async confirm(checkoutRequestId: string): Promise<'done' | 'pending'> {
    return this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; status: PaymentStatus; amount_minor: string; created_at: Date; customer_id: string; shortcode: string; mode: CollectionMode; passkey_ref: string | null; insurer_code: string; insurer_name: string; policy_number: string }>(
        `select p.id, p.status, p.amount_minor, p.created_at, p.customer_id, a.shortcode, a.mode, a.passkey_ref,
                i.code as insurer_code, i.name as insurer_name, l.policy_number
           from payment.stk_request s
           join payment.payment_intent p on p.id = s.payment_intent_id
           join insurer.collection_account a on a.id = p.collection_account_id
           join insurer.insurer i on i.id = p.insurer_id
           join policy.policy_link l on l.id = p.policy_link_id
          where s.checkout_request_id = $1
          for update of p`,
        [checkoutRequestId],
      );
      const p = rows[0];
      if (!p) {
        this.log.warn(`Callback for an unknown checkout request ${checkoutRequestId.slice(0, 40)}`);
        return 'done';
      }
      if (p.status !== 'prompt_sent') return 'done'; // already settled

      const status = await this.gateways.for(p.mode).queryStatus(p.shortcode, p.passkey_ref, checkoutRequestId);
      if (status.state === 'pending') {
        if (Date.now() - p.created_at.getTime() < PROMPT_TIMEOUT_MS) return 'pending';
        await this.setStatus(tx, p.id, 'expired', 'no_response');
        await this.outbox.enqueue(tx, { topic: 'payment.failed', aggregateType: 'payment_intent', aggregateId: p.id, payload: { failureCode: 'no_response' } });
        await this.audit(tx, 'system', 'payment-worker', 'payment.expired', p.id);
        return 'done';
      }

      if (status.resultCode !== 0) {
        const { code } = describeResult(status.resultCode);
        await tx.query(
          "insert into payment.payment_result (payment_intent_id, result_code, result_desc, confirmed_via) values ($1, $2, $3, 'status_query')",
          [p.id, status.resultCode, status.resultDesc.slice(0, 500)],
        );
        await this.setStatus(tx, p.id, 'failed', code);
        await this.outbox.enqueue(tx, { topic: 'payment.failed', aggregateType: 'payment_intent', aggregateId: p.id, payload: { failureCode: code } });
        await this.audit(tx, 'system', 'payment-worker', 'payment.failed', p.id);
        return 'done';
      }

      // Paid, per M-Pesa's own status query. The receipt and amount come from the
      // stored callback; if they are missing or disagree, a person checks it.
      const callback = await this.inbox.stkCallback(checkoutRequestId);
      // The status query can beat the callback; give the receipt time to arrive.
      if (!callback && Date.now() - p.created_at.getTime() < PROMPT_TIMEOUT_MS) return 'pending';
      const receipt = callbackItem(callback, 'MpesaReceiptNumber');
      const paidShillings = callbackItem(callback, 'Amount');
      const expected = BigInt(p.amount_minor);
      const paidMinor = typeof paidShillings === 'number' && Number.isInteger(paidShillings) ? BigInt(paidShillings) * 100n : null;
      if (typeof receipt !== 'string' || paidMinor !== expected) {
        await this.setStatus(tx, p.id, 'needs_review', receipt === undefined ? 'receipt_missing' : 'amount_mismatch');
        await this.audit(tx, 'system', 'payment-worker', 'payment.needs_review', p.id);
        return 'done';
      }

      // Memo entry only: the money sits in the insurer's paybill, not with AfyaPay.
      const entry = await this.ledger.post(tx, {
        book: 'collections',
        description: `M-Pesa ${receipt} for ${p.insurer_code} policy ${p.policy_number}`,
        idempotencyKey: `payment:${p.id}`,
        lines: [
          { accountCode: `insurer:${p.insurer_code}:mpesa_received`, accountName: `${p.insurer_name}: received in M-Pesa paybill`, amountMinor: expected },
          { accountCode: `insurer:${p.insurer_code}:premium_collected`, accountName: `${p.insurer_name}: premium collected for customers`, amountMinor: -expected },
        ],
      });
      await tx.query(
        `insert into payment.payment_result (payment_intent_id, result_code, result_desc, mpesa_receipt, amount_minor, confirmed_via, journal_entry_id)
         values ($1, 0, $2, $3, $4, 'status_query', $5)`,
        [p.id, status.resultDesc.slice(0, 500), receipt.slice(0, 40), expected.toString(), entry.entryId],
      );
      await this.setStatus(tx, p.id, 'confirmed', null);
      await tx.query(
        "update inbox.provider_callback set processed_at = now() where provider = 'mpesa' and kind = 'stk_callback' and provider_reference = $1",
        [checkoutRequestId],
      );
      await this.outbox.enqueue(tx, {
        topic: 'payment.confirmed',
        aggregateType: 'payment_intent',
        aggregateId: p.id,
        payload: { insurerCode: p.insurer_code, policyNumber: p.policy_number, amountMinor: expected.toString(), currency: 'KES', mpesaReceipt: receipt },
      });
      await this.audit(tx, 'system', 'payment-worker', 'payment.confirmed', p.id);
      return 'done';
    });
  }

  async listForCustomer(customerId: string): Promise<PaymentView[]> {
    const { rows } = await this.pool.query<{ id: string }>('select id from payment.payment_intent where customer_id = $1 order by created_at desc limit 50', [customerId]);
    const views = await Promise.all(rows.map((r) => this.view(this.pool, r.id)));
    return views.filter((v): v is PaymentView => v !== null);
  }

  async getForCustomer(customerId: string, id: string): Promise<PaymentView> {
    const v = /^[0-9a-f-]{36}$/.test(id) ? await this.view(this.pool, id, customerId) : null;
    if (!v) throw fail(HttpStatus.NOT_FOUND, 'payment.not_found', 'Payment not found.');
    return v;
  }

  /** What a customer message about this payment needs to say. */
  async messageFacts(intentId: string): Promise<{ customerId: string; amountMinor: bigint; insurerName: string; failureCode: string | null; mpesaReceipt: string | null } | null> {
    const { rows } = await this.pool.query<{ customer_id: string; amount_minor: string; name: string; failure_code: string | null; mpesa_receipt: string | null }>(
      `select p.customer_id, p.amount_minor::text, i.name, p.failure_code, r.mpesa_receipt
         from payment.payment_intent p join insurer.insurer i on i.id = p.insurer_id
         left join payment.payment_result r on r.payment_intent_id = p.id
        where p.id = $1`,
      [intentId],
    );
    const r = rows[0];
    return r ? { customerId: r.customer_id, amountMinor: BigInt(r.amount_minor), insurerName: r.name, failureCode: r.failure_code, mpesaReceipt: r.mpesa_receipt } : null;
  }

  /** The latest payment for a policy, for the money track. */
  async latestForPolicy(policyLinkId: string): Promise<{ status: PaymentStatus; amountMinor: bigint; failureMessage: string | null; at: Date } | null> {
    const { rows } = await this.pool.query<{ status: PaymentStatus; amount_minor: string; failure_code: string | null; updated_at: Date }>(
      'select status, amount_minor::text, failure_code, updated_at from payment.payment_intent where policy_link_id = $1 order by created_at desc limit 1',
      [policyLinkId],
    );
    const r = rows[0];
    return r ? { status: r.status, amountMinor: BigInt(r.amount_minor), failureMessage: r.failure_code ? failureMessage(r.failure_code) : null, at: r.updated_at } : null;
  }

  /** Total of confirmed, ledger-backed payments for a policy since a moment, in minor units. */
  async confirmedTotalForPolicy(policyLinkId: string, since: Date): Promise<bigint> {
    const { rows } = await this.pool.query<{ s: string }>(
      `select coalesce(sum(r.amount_minor), 0)::text as s
         from payment.payment_result r join payment.payment_intent p on p.id = r.payment_intent_id
        where p.policy_link_id = $1 and r.result_code = 0 and r.journal_entry_id is not null and r.created_at >= $2`,
      [policyLinkId, since],
    );
    return BigInt(rows[0].s);
  }

  private async view(db: Pool | PoolClient, id: string, customerId?: string): Promise<PaymentView | null> {
    const { rows } = await db.query(
      `select p.id, p.policy_link_id, l.policy_number, i.code, i.name, p.amount_minor::text as amount_minor, p.status, p.failure_code,
              p.created_at, r.mpesa_receipt, r.created_at as confirmed_at
         from payment.payment_intent p
         join policy.policy_link l on l.id = p.policy_link_id
         join insurer.insurer i on i.id = p.insurer_id
         left join payment.payment_result r on r.payment_intent_id = p.id and r.result_code = 0
        where p.id = $1 and ($2::uuid is null or p.customer_id = $2)`,
      [id, customerId ?? null],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      policyLinkId: r.policy_link_id,
      policyNumber: r.policy_number,
      insurer: { code: r.code, name: r.name },
      amountMinor: r.amount_minor,
      currency: 'KES',
      status: r.status,
      failure: r.failure_code ? { code: r.failure_code, message: failureMessage(r.failure_code) } : null,
      receipt: r.status === 'confirmed' ? { mpesaReceipt: r.mpesa_receipt, confirmedAt: r.confirmed_at } : null,
      createdAt: r.created_at,
    };
  }

  private callbackUrl(): string {
    const base = process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000';
    return `${base.replace(/\/$/, '')}/v1/hooks/mpesa/stk-callback/${process.env.MPESA_CALLBACK_SECRET ?? ''}`;
  }

  private async setStatus(tx: PoolClient, id: string, status: PaymentStatus, failureCode: string | null) {
    await tx.query('update payment.payment_intent set status = $2, failure_code = $3, updated_at = now(), version = version + 1 where id = $1', [id, status, failureCode]);
  }

  private async audit(tx: PoolClient, actorType: string, actorId: string, action: string, id: string) {
    await tx.query(
      "insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ($1, $2, $3, 'payment_intent', $4)",
      [actorType, actorId, action, id],
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

const FAILURE_MESSAGES: Record<string, string> = {
  prompt_not_sent: 'We could not send the M-Pesa prompt. Nothing was charged. Try again.',
  no_response: 'The M-Pesa prompt timed out. Nothing was charged. Try again.',
  receipt_missing: 'We are checking this payment with M-Pesa. You will get an update.',
  amount_mismatch: 'We are checking this payment with M-Pesa. You will get an update.',
};

export function failureMessage(code: string): string {
  if (FAILURE_MESSAGES[code]) return FAILURE_MESSAGES[code];
  return Object.values(RESULT_CODES).find((k) => k.code === code)?.message ?? 'M-Pesa did not complete the payment.';
}
