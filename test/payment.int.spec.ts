import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_SYNTHETIC_CODE } from '../src/modules/identity/auth.service';
import { SHARE_WITH_INSURER_CONSENT } from '../src/modules/identity/consent';
import { CONFIRM_STK_JOB } from '../src/modules/inbox/inbox.service';
import { PaymentWorker } from '../src/modules/payment/payment.worker';
import { SIMULATED_CALLBACK_JOB } from '../src/modules/payment/simulated.gateway';
import { PolicyLinkService } from '../src/modules/policy/policy-link.service';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
let worker: PaymentWorker;
let pwaniId: string;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `pay-${Date.now()}-${n++}`;
const SECRET = process.env.MPESA_CALLBACK_SECRET!;

async function signIn(phone: string): Promise<string> {
  const otp = await http().post('/auth/otp').send({ phone }).expect(202);
  const res = await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200);
  return res.body.accessToken;
}

/** A signed-in customer with a policy the (fictional) insurer has confirmed. */
async function customerWithPolicy(phone: string, policyNumber: string) {
  const token = await signIn(phone);
  const link = await http()
    .post('/me/policy-links')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send({ insurerCode: 'PWANI', policyNumber, consent: true, consentTextVersion: SHARE_WITH_INSURER_CONSENT.version })
    .expect(201);
  await app.get(PolicyLinkService).decide(link.body.id, 'confirmed', { insurerId: pwaniId, userId: 'synthetic-pwani-user' });
  return { token, linkId: link.body.id as string };
}

const pay = (token: string, body: Record<string, unknown>) =>
  http().post('/me/payments').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send(body);

async function checkoutIdFor(paymentId: string): Promise<string> {
  const { rows } = await pool.query('select checkout_request_id from payment.stk_request where payment_intent_id = $1', [paymentId]);
  return rows[0].checkout_request_id;
}

/** Makes this payment's queued jobs due now and runs the worker until they are done. */
async function settle(checkoutRequestId: string) {
  for (let i = 0; i < 5; i++) {
    const due = await pool.query(
      `update platform.job set run_at = now() where status = 'queued' and kind = any($1)
         and (payload->>'checkoutRequestId' = $2 or payload->'Body'->'stkCallback'->>'CheckoutRequestID' = $2)
       returning id`,
      [[CONFIRM_STK_JOB, SIMULATED_CALLBACK_JOB], checkoutRequestId],
    );
    if (due.rowCount === 0) return;
    await worker.runOnce();
  }
}

async function balance(code: string): Promise<bigint> {
  const { rows } = await pool.query(
    `select coalesce(sum(l.amount_minor), 0)::text as s from ledger.journal_line l
       join ledger.ledger_account a on a.id = l.account_id where a.book = 'collections' and a.code = $1`,
    [code],
  );
  return BigInt(rows[0].s);
}

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  worker = app.get(PaymentWorker);
  pwaniId = (await pool.query("select id from insurer.insurer where code = 'PWANI'")).rows[0].id;
});

afterAll(async () => {
  await app?.close();
});

describe('M-Pesa premium payments (simulated gateway)', () => {
  it('sends a prompt to the insurer paybill, confirms by status query, posts one ledger entry and issues a receipt', async () => {
    const { token, linkId } = await customerWithPolicy('0700000301', 'SYN-PM-PAY-0301');
    const before = await balance('insurer:PWANI:mpesa_received');

    const started = await pay(token, { policyLinkId: linkId, amountMinor: '250000' }).expect(201);
    expect(started.body).toMatchObject({ status: 'prompt_sent', amountMinor: '250000', currency: 'KES', policyNumber: 'SYN-PM-PAY-0301', receipt: null });

    const checkoutId = await checkoutIdFor(started.body.id);
    await settle(checkoutId);

    const receipt = await http().get(`/me/payments/${started.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(receipt.body.status).toBe('confirmed');
    expect(receipt.body.receipt.mpesaReceipt).toMatch(/^SIM[0-9A-F]{7}$/);

    expect((await balance('insurer:PWANI:mpesa_received')) - before).toBe(250000n);
    const result = await pool.query('select confirmed_via, amount_minor::text, journal_entry_id from payment.payment_result where payment_intent_id = $1', [started.body.id]);
    expect(result.rows[0]).toMatchObject({ confirmed_via: 'status_query', amount_minor: '250000' });
    expect(result.rows[0].journal_entry_id).toBeTruthy();
    const outbox = await pool.query('select topic from platform.outbox_event where aggregate_id = $1', [started.body.id]);
    expect(outbox.rows.map((r) => r.topic)).toEqual(['payment.confirmed']);
    const audit = await pool.query('select action from governance.audit_event where subject_id = $1 order by occurred_at', [started.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['payment.started', 'payment.confirmed']);

    // Paying never changes the policy link or anything about cover.
    const link = await pool.query('select status, version from policy.policy_link where id = $1', [linkId]);
    expect(link.rows[0]).toEqual({ status: 'confirmed', version: 2 });
  });

  it('records a cancelled prompt as failed with a reason the customer understands, and no ledger entry', async () => {
    const { token, linkId } = await customerWithPolicy('0700000309', 'SYN-PM-PAY-0309');
    const started = await pay(token, { policyLinkId: linkId, amountMinor: 100000 }).expect(201);
    await settle(await checkoutIdFor(started.body.id));
    const res = await http().get(`/me/payments/${started.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toMatchObject({ status: 'failed', failure: { code: 'cancelled', message: 'You cancelled the M-Pesa prompt.' }, receipt: null });
    const entries = await pool.query("select 1 from ledger.journal_entry where idempotency_key = $1", [`payment:${started.body.id}`]);
    expect(entries.rowCount).toBe(0);
    // The policy is free for a new prompt once the last one has ended.
    await pay(token, { policyLinkId: linkId, amountMinor: 100000 }).expect(201);
  });

  it('keeps one open prompt per policy, so a double tap cannot charge twice', async () => {
    const { token, linkId } = await customerWithPolicy('0700000302', 'SYN-PM-PAY-0302');
    await pay(token, { policyLinkId: linkId, amountMinor: 50000 }).expect(201);
    const second = await pay(token, { policyLinkId: linkId, amountMinor: 50000 }).expect(409);
    expect(second.body.code).toBe('payment.prompt_open');
  });

  it('ignores repeated callbacks and never posts the same payment twice', async () => {
    const { token, linkId } = await customerWithPolicy('0700000303', 'SYN-PM-PAY-0303');
    const before = await balance('insurer:PWANI:mpesa_received');
    const started = await pay(token, { policyLinkId: linkId, amountMinor: 70000 }).expect(201);
    const checkoutId = await checkoutIdFor(started.body.id);
    await settle(checkoutId);

    const stored = (await pool.query('select payload from inbox.provider_callback where provider_reference = $1', [checkoutId])).rows[0].payload;
    for (let i = 0; i < 3; i++) {
      await http().post(`/hooks/mpesa/stk-callback/${SECRET}`).send(stored).expect(200, { ResultCode: 0, ResultDesc: 'Accepted' });
    }
    await app.get(PaymentWorker).runOnce();

    expect((await balance('insurer:PWANI:mpesa_received')) - before).toBe(70000n);
    const callbacks = await pool.query('select 1 from inbox.provider_callback where provider_reference = $1', [checkoutId]);
    expect(callbacks.rowCount).toBe(1);
  });

  it('confirms with a status query when the callback never arrives, and sends a paid result without a receipt to review', async () => {
    const { token, linkId } = await customerWithPolicy('0700000304', 'SYN-PM-PAY-0304');
    const started = await pay(token, { policyLinkId: linkId, amountMinor: 30000 }).expect(201);
    const checkoutId = await checkoutIdFor(started.body.id);
    await pool.query("delete from platform.job where kind = $1 and payload->'Body'->'stkCallback'->>'CheckoutRequestID' = $2", [SIMULATED_CALLBACK_JOB, checkoutId]);

    await settle(checkoutId); // only the safety-net status query runs
    const res = await http().get(`/me/payments/${started.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.status).toBe('needs_review');
    expect(res.body.failure.code).toBe('receipt_missing');
    const entries = await pool.query('select 1 from ledger.journal_entry where idempotency_key = $1', [`payment:${started.body.id}`]);
    expect(entries.rowCount).toBe(0);
  });

  it('does not trust a callback whose amount disagrees with the request', async () => {
    const { token, linkId } = await customerWithPolicy('0700000305', 'SYN-PM-PAY-0305');
    const started = await pay(token, { policyLinkId: linkId, amountMinor: 40000 }).expect(201);
    const checkoutId = await checkoutIdFor(started.body.id);
    const forged = {
      Body: {
        stkCallback: {
          CheckoutRequestID: checkoutId,
          ResultCode: 0,
          CallbackMetadata: { Item: [{ Name: 'Amount', Value: 4 }, { Name: 'MpesaReceiptNumber', Value: 'SIMFAKE01' }] },
        },
      },
    };
    await http().post(`/hooks/mpesa/stk-callback/${SECRET}`).send(forged).expect(200);
    await settle(checkoutId);
    const res = await http().get(`/me/payments/${started.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toMatchObject({ status: 'needs_review', failure: { code: 'amount_mismatch' } });
  });

  it('refuses unconfirmed policies, other customers, bad amounts and wrong callback secrets', async () => {
    const token = await signIn('0700000306');
    const pending = await http()
      .post('/me/policy-links')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key())
      .send({ insurerCode: 'PWANI', policyNumber: 'SYN-PM-PAY-0306', consent: true, consentTextVersion: SHARE_WITH_INSURER_CONSENT.version })
      .expect(201);
    expect((await pay(token, { policyLinkId: pending.body.id, amountMinor: 10000 }).expect(409)).body.code).toBe('payment.policy_not_confirmed');

    const other = await customerWithPolicy('0700000307', 'SYN-PM-PAY-0307');
    expect((await pay(token, { policyLinkId: other.linkId, amountMinor: 10000 }).expect(404)).body.code).toBe('policy.link_not_found');

    for (const amountMinor of [0, 50, '12.5', 15000100, -100]) {
      await pay(other.token, { policyLinkId: other.linkId, amountMinor }).expect(422);
    }
    expect((await pay(other.token, { policyLinkId: other.linkId, amountMinor: 10050 }).expect(422)).body.code).toBe('payment.amount_not_whole');

    await http().post('/hooks/mpesa/stk-callback/wrong-secret-0000000000').send({}).expect(404);
    await http().post('/me/payments').set('Idempotency-Key', key()).send({}).expect(401);
  });

  it('keeps the collections book balanced', async () => {
    const { rows } = await pool.query("select coalesce(sum(l.amount_minor), 0)::text as s from ledger.journal_line l join ledger.journal_entry e on e.id = l.entry_id where e.book = 'collections'");
    expect(rows[0].s).toBe('0');
  });
});
