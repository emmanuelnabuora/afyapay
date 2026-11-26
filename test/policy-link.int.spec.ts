import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_SYNTHETIC_CODE } from '../src/modules/identity/auth.service';
import { SHARE_WITH_INSURER_CONSENT } from '../src/modules/identity/consent';
import { PolicyLinkService } from '../src/modules/policy/policy-link.service';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
let links: PolicyLinkService;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `pl-${Date.now()}-${n++}`;

async function signIn(phone: string): Promise<string> {
  const otp = await http().post('/auth/otp').send({ phone }).expect(202);
  const res = await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200);
  return res.body.accessToken;
}

const linkBody = (policyNumber: string, extra: Record<string, unknown> = {}) => ({
  insurerCode: 'PWANI',
  policyNumber,
  consent: true,
  consentTextVersion: SHARE_WITH_INSURER_CONSENT.version,
  ...extra,
});

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  links = app.get(PolicyLinkService);
});

afterAll(async () => {
  await app?.close();
});

describe('policy linking', () => {
  it('lists the fictional sandbox insurers and the consent wording', async () => {
    const token = await signIn('0700000201');
    const insurers = await http().get('/insurers').set('Authorization', `Bearer ${token}`).expect(200);
    expect(insurers.body.map((i: { code: string }) => i.code).sort()).toEqual(['JAMII', 'PWANI']);
    const consent = await http().get('/insurers/PWANI/consent').set('Authorization', `Bearer ${token}`).expect(200);
    expect(consent.body.version).toBe(SHARE_WITH_INSURER_CONSENT.version);
    expect(consent.body.text).toContain('Pwani Mutual (fictional)');
  });

  it('creates a pending link with recorded consent, an outbox event and an audit entry', async () => {
    const token = await signIn('0700000202');
    const res = await http().post('/me/policy-links').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send(linkBody(' syn-pm-hl-100001 ')).expect(201);
    expect(res.body).toMatchObject({ policyNumber: 'SYN-PM-HL-100001', status: 'pending_insurer', insurer: { code: 'PWANI' } });

    const consent = await pool.query("select granted, text_version from identity.consent_record where purpose = 'share_with_insurer' and customer_id = (select customer_id from policy.policy_link where id = $1)", [res.body.id]);
    expect(consent.rows).toEqual([{ granted: true, text_version: SHARE_WITH_INSURER_CONSENT.version }]);
    const outbox = await pool.query("select topic from platform.outbox_event where aggregate_id = $1", [res.body.id]);
    expect(outbox.rows.map((r) => r.topic)).toEqual(['policy_link.requested']);
    const audit = await pool.query("select action from governance.audit_event where subject_id = $1", [res.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['policy_link.requested']);

    const list = await http().get('/me/policy-links').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('refuses without consent, with old consent wording, or with a bad policy number', async () => {
    const token = await signIn('0700000203');
    const post = (body: object) => http().post('/me/policy-links').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send(body);
    expect((await post(linkBody('SYN-1', { consent: false })).expect(422)).body.code).toBe('consent.required');
    expect((await post(linkBody('SYN-1', { consentTextVersion: 'old' })).expect(422)).body.code).toBe('consent.required');
    expect((await post(linkBody('!!')).expect(422)).body.code).toBe('policy.number_invalid');
    expect((await post(linkBody('SYN-1', { insurerCode: 'NOPE' })).expect(422)).body.code).toBe('insurer.unknown');
    // A refused request leaves no consent behind.
    const { rowCount } = await pool.query("select 1 from identity.consent_record c join identity.customer u on u.id = c.customer_id where u.phone_e164 = '+254700000203'");
    expect(rowCount).toBe(0);
  });

  it('allows one active link per policy number, without saying who holds it', async () => {
    const a = await signIn('0700000204');
    const b = await signIn('0700000205');
    await http().post('/me/policy-links').set('Authorization', `Bearer ${a}`).set('Idempotency-Key', key()).send(linkBody('SYN-SHARED-1')).expect(201);
    const res = await http().post('/me/policy-links').set('Authorization', `Bearer ${b}`).set('Idempotency-Key', key()).send(linkBody('SYN-SHARED-1')).expect(409);
    expect(res.body.code).toBe('policy.link_exists');
    expect(JSON.stringify(res.body)).not.toContain('0700000204');
  });

  it('only the owning insurer can decide, once, and a rejection needs a reason', async () => {
    const token = await signIn('0700000206');
    const created = await http().post('/me/policy-links').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send(linkBody('SYN-DECIDE-1')).expect(201);
    const ids = await pool.query<{ code: string; id: string }>('select code, id from insurer.insurer');
    const byCode = Object.fromEntries(ids.rows.map((r) => [r.code, r.id]));

    await expect(links.decide(created.body.id, 'confirmed', { insurerId: byCode.JAMII, userId: 'synthetic-jamii-user' })).rejects.toMatchObject({ status: 404 });
    await expect(links.decide(created.body.id, 'rejected', { insurerId: byCode.PWANI, userId: 'synthetic-pwani-user' })).rejects.toMatchObject({ status: 422 });
    const confirmed = await links.decide(created.body.id, 'confirmed', { insurerId: byCode.PWANI, userId: 'synthetic-pwani-user' });
    expect(confirmed.status).toBe('confirmed');
    await expect(links.decide(created.body.id, 'rejected', { insurerId: byCode.PWANI, userId: 'synthetic-pwani-user' }, 'x')).rejects.toMatchObject({ status: 409 });
  });

  it('requires sign-in and an Idempotency-Key', async () => {
    await http().get('/me/policy-links').expect(401);
    const token = await signIn('0700000207');
    await http().post('/me/policy-links').set('Authorization', `Bearer ${token}`).send(linkBody('SYN-NOKEY')).expect(400);
  });

  it('keeps consent records append-only', async () => {
    await expect(pool.query("update identity.consent_record set granted = false")).rejects.toThrow(/append-only/);
  });
});
