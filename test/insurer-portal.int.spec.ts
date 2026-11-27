import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_SYNTHETIC_CODE } from '../src/modules/identity/auth.service';
import { SHARE_WITH_INSURER_CONSENT } from '../src/modules/identity/consent';
import { PRE_LAUNCH_STAFF_EMAIL_CODE } from '../src/modules/insurer/insurer-auth.service';
import { currentStep, totpAt } from '../src/modules/insurer/totp';
import { eatDate } from '../src/modules/policy/tracks';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `ip-${Date.now()}-${n++}`;
const today = eatDate();

async function emailTicket(email: string) {
  const ch = await http().post('/insurer-auth/email-code').send({ email }).expect(202);
  return (await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body as { mfaTicket: string; enrolled: boolean };
}

/** Full first sign-in: email code, authenticator set-up, authenticator code. */
async function staffSignIn(email: string): Promise<{ token: string; secret: string }> {
  const t = await emailTicket(email);
  expect(t.enrolled).toBe(false);
  const enrol = await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
  expect(enrol.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/AfyaPay%20insurer%20portal/);
  const res = await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200);
  return { token: res.body.accessToken, secret: enrol.body.secret };
}

async function customerLink(phone: string, insurerCode: string, policyNumber: string): Promise<string> {
  const otp = await http().post('/auth/otp').send({ phone }).expect(202);
  const token = (await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
  const link = await http()
    .post('/me/policy-links')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send({ insurerCode, policyNumber, consent: true, consentTextVersion: SHARE_WITH_INSURER_CONSENT.version })
    .expect(201);
  return link.body.id;
}

let pwaniOperator: string;
let pwaniViewer: string;
let jamiiOperator: string;

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  pwaniOperator = (await staffSignIn('operator.pwani@sandbox.test')).token;
  pwaniViewer = (await staffSignIn('viewer.pwani@sandbox.test')).token;
  jamiiOperator = (await staffSignIn('operator.jamii@sandbox.test')).token;
});

afterAll(async () => {
  await app?.close();
});

const as = (token: string) => ({ get: (u: string) => http().get(u).set('Authorization', `Bearer ${token}`), post: (u: string) => http().post(u).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()) });

describe('insurer staff sign-in', () => {
  it('needs an authenticator code: the email code alone gives no access', async () => {
    const t = await emailTicket('approver.pwani@sandbox.test');
    await http().get('/insurer/me').set('Authorization', `Bearer ${t.mfaTicket}`).expect(401);
    await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: '000000' }).expect(409); // not set up yet
    const enrol = await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
    await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: '000000' }).expect(401);
    const code = totpAt(enrol.body.secret, currentStep());
    const ok = await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code }).expect(200);
    const me = (await as(ok.body.accessToken).get('/insurer/me').expect(200)).body;
    expect(me.role).toBe('approver');
    expect(me.insurer).toEqual({ code: 'PWANI', name: expect.stringContaining('Pwani Mutual') });

    // A used code cannot be used again, and a second set-up is refused.
    const again = await emailTicket('approver.pwani@sandbox.test');
    expect(again.enrolled).toBe(true);
    await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: again.mfaTicket, code }).expect(401);
    await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: again.mfaTicket }).expect(409);
    await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: again.mfaTicket, code: totpAt(enrol.body.secret, currentStep() + 1) }).expect(200);
  });

  it('stores no password and keeps the authenticator secret encrypted', async () => {
    const cols = await pool.query("select column_name from information_schema.columns where table_schema = 'insurer' and table_name = 'insurer_user'");
    expect(cols.rows.map((r) => r.column_name).filter((c: string) => /pass/i.test(c))).toEqual([]);
    const { rows } = await pool.query("select totp_secret_enc from insurer.insurer_user where email = 'operator.pwani@sandbox.test'");
    expect(rows[0].totp_secret_enc).toMatch(/^v1\./);
  });

  it('refuses non-synthetic addresses, wrong codes and customer tokens', async () => {
    await http().post('/insurer-auth/email-code').send({ email: 'someone@insurer.co.ke' }).expect(422);
    const ch = await http().post('/insurer-auth/email-code').send({ email: 'viewer.jamii@sandbox.test' }).expect(202);
    await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: '111111' }).expect(400);
    // An unknown address gets the same first answer, then no ticket.
    const unknown = await http().post('/insurer-auth/email-code').send({ email: 'nobody@sandbox.test' }).expect(202);
    await http().post('/insurer-auth/email-code/verify').send({ challengeId: unknown.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(403);

    const otp = await http().post('/auth/otp').send({ phone: '0700000601' }).expect(202);
    const customerToken = (await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
    await as(customerToken).get('/insurer/policy-links').expect(401);
  });
});

describe('insurer portal', () => {
  it('lets an operator confirm a link, set the plan and report cover, which the customer then sees', async () => {
    const linkId = await customerLink('0700000602', 'PWANI', 'SYN-PM-IP-0602');
    const pending = await as(pwaniOperator).get('/insurer/policy-links?status=pending_insurer').expect(200);
    const row = pending.body.find((l: { id: string }) => l.id === linkId);
    expect(row).toMatchObject({ policyNumber: 'SYN-PM-IP-0602', status: 'pending_insurer' });
    expect(row.customerPhone).not.toContain('700000602');

    await as(pwaniOperator).post(`/insurer/policy-links/${linkId}/decision`).send({ decision: 'confirmed' }).expect(200);
    await as(pwaniOperator).post(`/insurer/policy-links/${linkId}/premium-schedule`).send({ frequency: 'monthly', amountMinor: '250000', startsOn: today }).expect(201);
    await as(pwaniOperator).post(`/insurer/policy-links/${linkId}/cover-events`).send({ status: 'active', coveredUntil: today, effectiveOn: today, insurerReference: 'SYN-COVER-1' }).expect(201);
    await as(pwaniOperator).post(`/insurer/policy-links/${linkId}/cover-events`).send({ status: 'ended', effectiveOn: today }).expect(201);
    await as(pwaniOperator).post(`/insurer/policy-links/${linkId}/cover-events`).send({ status: 'lapsed', effectiveOn: today }).expect(409);

    const audit = await pool.query("select actor_type, action from governance.audit_event where subject_id = $1 order by seq", [linkId]);
    expect(audit.rows).toEqual([
      { actor_type: 'customer', action: 'policy_link.requested' },
      { actor_type: 'insurer_user', action: 'policy_link.confirmed' },
      { actor_type: 'insurer_user', action: 'premium_schedule.set' },
      { actor_type: 'insurer_user', action: 'cover.active' },
      { actor_type: 'insurer_user', action: 'cover.ended' },
    ]);
    const sources = await pool.query('select source, recorded_by from policy.cover_event where policy_link_id = $1', [linkId]);
    expect(new Set(sources.rows.map((r) => r.source))).toEqual(new Set(['insurer_portal']));
  });

  it('lets viewers look but not change anything', async () => {
    const linkId = await customerLink('0700000603', 'PWANI', 'SYN-PM-IP-0603');
    await as(pwaniViewer).get('/insurer/policy-links').expect(200);
    await as(pwaniViewer).get('/insurer/payments').expect(200);
    const res = await as(pwaniViewer).post(`/insurer/policy-links/${linkId}/decision`).send({ decision: 'confirmed' }).expect(403);
    expect(res.body.code).toBe('staff.role_required');
  });

  it('never shows or changes another insurer’s policies', async () => {
    const pwaniLink = await customerLink('0700000604', 'PWANI', 'SYN-PM-IP-0604');
    const jamiiList = await as(jamiiOperator).get('/insurer/policy-links').expect(200);
    expect(jamiiList.body.map((l: { id: string }) => l.id)).not.toContain(pwaniLink);
    await as(jamiiOperator).post(`/insurer/policy-links/${pwaniLink}/decision`).send({ decision: 'confirmed' }).expect(404);
    await as(jamiiOperator).post(`/insurer/policy-links/${pwaniLink}/cover-events`).send({ status: 'active', coveredUntil: today, effectiveOn: today }).expect(404);
    const status = await pool.query('select status from policy.policy_link where id = $1', [pwaniLink]);
    expect(status.rows[0].status).toBe('pending_insurer');
  });
});

describe('row-level security in the database', () => {
  const asPortal = async <T>(insurerId: string | null, sql: string, params: unknown[] = []): Promise<T[]> => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role afyapay_portal');
      if (insurerId) await c.query("select set_config('app.insurer_id', $1, true)", [insurerId]);
      const { rows } = await c.query(sql, params);
      return rows as T[];
    } finally {
      await c.query('rollback');
      c.release();
    }
  };

  it('limits the portal role to one insurer even when the query asks for everything', async () => {
    await customerLink('0700000605', 'PWANI', 'SYN-PM-IP-0605');
    const ids = Object.fromEntries((await pool.query('select code, id from insurer.insurer')).rows.map((r) => [r.code, r.id]));
    const seenByJamii = await asPortal<{ insurer_id: string }>(ids.JAMII, 'select distinct insurer_id from policy.policy_link');
    expect(seenByJamii.every((r) => r.insurer_id === ids.JAMII)).toBe(true);
    const seenByPwani = await asPortal<{ insurer_id: string }>(ids.PWANI, 'select distinct insurer_id from policy.policy_link');
    expect(seenByPwani.map((r) => r.insurer_id)).toEqual([ids.PWANI]);

    for (const table of ['policy.policy_link', 'payment.payment_intent', 'payment.payment_result', 'policy.cover_event', 'policy.premium_schedule', 'identity.customer']) {
      expect(await asPortal(null, `select 1 from ${table}`)).toEqual([]); // no insurer set: nothing
    }
  });

  it('gives the portal role no access to tables it does not need', async () => {
    const ids = Object.fromEntries((await pool.query('select code, id from insurer.insurer')).rows.map((r) => [r.code, r.id]));
    for (const sql of ['select * from insurer.insurer_user', 'select * from ledger.journal_entry', 'select * from identity.session', 'select phone_e164, status from identity.customer', 'select * from inbox.provider_callback']) {
      await expect(asPortal(ids.PWANI, sql)).rejects.toThrow(/permission denied/);
    }
  });
});
