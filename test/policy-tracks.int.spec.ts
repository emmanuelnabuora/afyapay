import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
import { InsurerActor, PolicyTracksService } from '../src/modules/policy/policy-tracks.service';
import { eatDate } from '../src/modules/policy/tracks';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
let tracks: PolicyTracksService;
let pwani: InsurerActor;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `tr-${Date.now()}-${n++}`;
const today = eatDate();
const plusDays = (d: number) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

async function signIn(phone: string): Promise<string> {
  const otp = await http().post('/auth/otp').send({ phone }).expect(202);
  const res = await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200);
  return res.body.accessToken;
}

async function linkPolicy(token: string, policyNumber: string, confirm = true): Promise<string> {
  const link = await http()
    .post('/me/policy-links')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send({ insurerCode: 'PWANI', policyNumber, consent: true, consentTextVersion: SHARE_WITH_INSURER_CONSENT.version })
    .expect(201);
  if (confirm) await app.get(PolicyLinkService).decide(link.body.id, 'confirmed', { insurerId: pwani.insurerId, userId: pwani.userId });
  return link.body.id;
}

const tracksOf = async (token: string, linkId: string) =>
  (await http().get(`/me/policies/${linkId}`).set('Authorization', `Bearer ${token}`).expect(200)).body.policy;

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  tracks = app.get(PolicyTracksService);
  const id = (await pool.query("select id from insurer.insurer where code = 'PWANI'")).rows[0].id;
  pwani = { insurerId: id, userId: 'synthetic-pwani-user', source: 'insurer_portal' };
});

afterAll(async () => {
  await app?.close();
});

describe('three tracks per policy', () => {
  it('starts with no payments, no plan and no cover, and says so plainly', async () => {
    const token = await signIn('0700000401');
    const linkId = await linkPolicy(token, 'SYN-PM-TRK-0401');
    const list = await http().get('/me/policies').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.testMode).toBe(true);
    expect(list.body.policies).toHaveLength(1);
    expect(list.body.policies[0]).toMatchObject({
      policyLinkId: linkId,
      money: { state: 'none' },
      premium: { state: 'no_plan' },
      cover: { state: 'not_active', label: 'Not covered yet. Pwani Mutual (fictional) activates cover.' },
    });
  });

  it('moves the premium position with a confirmed payment and leaves cover alone', async () => {
    const token = await signIn('0700000402');
    const linkId = await linkPolicy(token, 'SYN-PM-TRK-0402');
    await tracks.setPremiumSchedule(linkId, pwani, { frequency: 'monthly', amountMinor: 300000n, startsOn: today });

    const started = await http().post('/me/payments').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send({ policyLinkId: linkId, amountMinor: 100000 }).expect(201);
    expect((await tracksOf(token, linkId)).money).toMatchObject({ state: 'payment_pending', label: 'Waiting for M-Pesa' });

    const checkout = (await pool.query('select checkout_request_id from payment.stk_request where payment_intent_id = $1', [started.body.id])).rows[0].checkout_request_id;
    for (let i = 0; i < 4; i++) {
      await pool.query(
        `update platform.job set run_at = now() where status = 'queued' and kind = any($1)
           and (payload->>'checkoutRequestId' = $2 or payload->'Body'->'stkCallback'->>'CheckoutRequestID' = $2)`,
        [[CONFIRM_STK_JOB, SIMULATED_CALLBACK_JOB], checkout],
      );
      await app.get(PaymentWorker).runOnce();
    }

    const t = await tracksOf(token, linkId);
    expect(t.money).toMatchObject({ state: 'payment_succeeded', label: 'KES 1,000 paid to Pwani Mutual (fictional)', source: 'mpesa' });
    expect(t.premium).toMatchObject({ state: 'part_paid', label: 'Saved towards your premium: KES 1,000 of KES 3,000', paidThisPeriodMinor: '100000' });
    expect(t.cover.state).toBe('not_active');
    expect((await pool.query('select 1 from policy.cover_event where policy_link_id = $1', [linkId])).rowCount).toBe(0);
  });

  it('shows cover only from insurer events, through allowed changes', async () => {
    const token = await signIn('0700000403');
    const linkId = await linkPolicy(token, 'SYN-PM-TRK-0403');

    await expect(tracks.recordCoverEvent(linkId, pwani, { status: 'lapsed', effectiveOn: today })).rejects.toMatchObject({ status: 409 });
    await tracks.recordCoverEvent(linkId, pwani, { status: 'active', coveredUntil: plusDays(30), effectiveOn: today, insurerReference: 'SYN-REF-1' });
    let t = await tracksOf(token, linkId);
    expect(t.cover).toMatchObject({ state: 'active', label: `Covered until ${plusDays(30)}. Confirmed by Pwani Mutual (fictional) on ${today}.`, source: 'insurer' });

    await tracks.recordCoverEvent(linkId, pwani, { status: 'lapsed', effectiveOn: today });
    await expect(tracks.recordCoverEvent(linkId, pwani, { status: 'lapsed', effectiveOn: today })).rejects.toMatchObject({ status: 409 });
    t = await tracksOf(token, linkId);
    expect(t.cover).toMatchObject({ state: 'lapsed', label: `Cover lapsed on ${today}, per Pwani Mutual (fictional)` });

    await tracks.recordCoverEvent(linkId, pwani, { status: 'active', coveredUntil: plusDays(30), effectiveOn: today });
    await tracks.recordCoverEvent(linkId, pwani, { status: 'ended', effectiveOn: today });
    await expect(tracks.recordCoverEvent(linkId, pwani, { status: 'active', coveredUntil: plusDays(30), effectiveOn: today })).rejects.toMatchObject({ status: 409 });

    const events = await pool.query('select seq, status from policy.cover_event where policy_link_id = $1 order by seq', [linkId]);
    expect(events.rows).toEqual([
      { seq: 1, status: 'active' },
      { seq: 2, status: 'lapsed' },
      { seq: 3, status: 'active' },
      { seq: 4, status: 'ended' },
    ]);
    const outbox = await pool.query("select topic from platform.outbox_event where aggregate_id = $1 and topic like 'cover.%' order by created_at", [linkId]);
    expect(outbox.rows.map((r) => r.topic)).toEqual(['cover.active', 'cover.lapsed', 'cover.active', 'cover.ended']);
  });

  it('refuses other insurers, unconfirmed links, non-insurer sources and edits to cover history', async () => {
    const token = await signIn('0700000404');
    const linkId = await linkPolicy(token, 'SYN-PM-TRK-0404');
    const pendingId = await linkPolicy(token, 'SYN-PM-TRK-0405', false);
    const jamii = (await pool.query("select id from insurer.insurer where code = 'JAMII'")).rows[0].id;

    await expect(tracks.recordCoverEvent(linkId, { ...pwani, insurerId: jamii }, { status: 'active', coveredUntil: plusDays(5), effectiveOn: today })).rejects.toMatchObject({ status: 404 });
    await expect(tracks.recordCoverEvent(pendingId, pwani, { status: 'active', coveredUntil: plusDays(5), effectiveOn: today })).rejects.toMatchObject({ status: 409 });
    await expect(tracks.recordCoverEvent(linkId, { ...pwani, source: 'payment' as never }, { status: 'active', coveredUntil: plusDays(5), effectiveOn: today })).rejects.toMatchObject({ status: 403 });
    await expect(tracks.setPremiumSchedule(linkId, { ...pwani, source: 'customer' as never }, { frequency: 'monthly', amountMinor: 100n, startsOn: today })).rejects.toMatchObject({ status: 403 });

    // The database refuses the same things on its own.
    await expect(
      pool.query("insert into policy.cover_event (policy_link_id, seq, status, covered_until, effective_on, source, recorded_by) values ($1, 1, 'active', $2, $2, 'payment', 'x')", [linkId, today]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      pool.query("insert into policy.cover_event (policy_link_id, seq, status, covered_until, effective_on, source, recorded_by) values ($1, 1, 'active', $2, $2, 'insurer_file', 'x')", [pendingId, today]),
    ).rejects.toThrow(/confirmed/);

    await tracks.recordCoverEvent(linkId, pwani, { status: 'active', coveredUntil: plusDays(5), effectiveOn: today });
    await expect(pool.query("update policy.cover_event set status = 'lapsed' where policy_link_id = $1", [linkId])).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from policy.cover_event where policy_link_id = $1', [linkId])).rejects.toThrow(/append-only/);

    // Customers cannot see someone else's policy.
    const other = await signIn('0700000406');
    await http().get(`/me/policies/${linkId}`).set('Authorization', `Bearer ${other}`).expect(404);
    await http().get('/me/policies').expect(401);
  });

  it('has no payment, inbox or ledger code that touches cover', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const m of ['payment', 'inbox', 'ledger', 'reconciliation']) walk(join(__dirname, '..', 'src', 'modules', m));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect({ file: f, touchesCover: /cover_event|recordCoverEvent|PolicyTracksService/.test(src) }).toEqual({ file: f, touchesCover: false });
    }
  });
});
