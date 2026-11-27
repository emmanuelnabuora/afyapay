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

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `ao-${Date.now()}-${n++}`;
const seeded: Record<string, string> = {};

interface Staff {
  id: string;
  token: string;
}

async function grant(staffId: string, role: string) {
  const r = await pool.query<{ id: string }>(
    "insert into governance.approval_request (kind, payload, reason, proposed_by) values ('role_grant', $1, 'Test set-up', $2) returning id",
    [{ staffUserId: staffId, role }, seeded['super-admin-1']],
  );
  await pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [r.rows[0].id, seeded['super-admin-2']]);
  await pool.query("insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, $2, 'grant', $3)", [staffId, role, r.rows[0].id]);
}

async function staff(...roles: string[]): Promise<Staff> {
  const email = `ao${Date.now()}${n++}@sandbox.test`;
  const u = await pool.query<{ id: string }>("insert into governance.staff_user (email, display_name, created_by) values ($1, 'Synthetic test staff', 'test') returning id", [email]);
  for (const role of roles) await grant(u.rows[0].id, role);
  const ch = await http().post('/admin-auth/email-code').send({ email }).expect(202);
  const t = (await http().post('/admin-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
  const enrol = await http().post('/admin-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
  const token = (await http().post('/admin-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200)).body.accessToken;
  return { id: u.rows[0].id, token };
}

const as = (s: Staff) => ({
  get: (u: string) => http().get(u).set('Authorization', `Bearer ${s.token}`),
  post: (u: string) => http().post(u).set('Authorization', `Bearer ${s.token}`).set('Idempotency-Key', key()),
});

let support: Staff;
let support2: Staff;
let finance: Staff;
let compliance: Staff;
let customerId: string;

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  for (const r of (await pool.query("select id, split_part(email, '@', 1) as k from governance.staff_user where created_by = 'seed'")).rows) seeded[r.k] = r.id;
  support = await staff('support');
  support2 = await staff('support');
  finance = await staff('finance');
  compliance = await staff('compliance');

  const otp = await http().post('/auth/otp').send({ phone: '0700000901' }).expect(202);
  const customerToken = (await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
  await http()
    .post('/me/policy-links')
    .set('Authorization', `Bearer ${customerToken}`)
    .set('Idempotency-Key', key())
    .send({ insurerCode: 'PWANI', policyNumber: 'SYN-PM-AO-0901', consent: true, consentTextVersion: SHARE_WITH_INSURER_CONSENT.version })
    .expect(201);
  customerId = (await pool.query("select id from identity.customer where phone_e164 = '+254700000901'")).rows[0].id;
});

afterAll(async () => {
  await app?.close();
});

describe('masked customer lookup', () => {
  it('finds a customer by exact phone or policy number and shows the phone masked', async () => {
    const byPhone = (await as(support).get('/admin/customers?phone=0700 000 901').expect(200)).body.customers;
    expect(byPhone).toHaveLength(1);
    expect(byPhone[0]).toMatchObject({ id: customerId, phoneMasked: '+254 7** *** 901', policies: [{ insurer: 'PWANI', policyNumber: 'SYN-PM-AO-0901', status: 'pending_insurer' }] });
    expect(byPhone[0].consents).toEqual([expect.objectContaining({ purpose: 'share_with_insurer', insurer: 'PWANI', granted: true })]);
    expect(JSON.stringify(byPhone)).not.toContain('700000901');

    const byPolicy = (await as(finance).get('/admin/customers?policyNumber=syn-pm-ao-0901&insurerCode=PWANI').expect(200)).body.customers;
    expect(byPolicy.map((c: { id: string }) => c.id)).toEqual([customerId]);
    expect((await as(support).get('/admin/customers?policyNumber=SYN-PM-AO-0901&insurerCode=JAMII').expect(200)).body.customers).toEqual([]);

    await as(support).get('/admin/customers?phone=0700').expect(422);
    await as(support).get('/admin/customers').expect(422);
    await http().get('/admin/customers?phone=0700000901').expect(401);
    const audit = await pool.query("select after_state from governance.audit_event where actor_id = $1 and action = 'customer.looked_up' order by seq", [support.id]);
    expect(audit.rows[0].after_state).toEqual({ by: 'phone', found: [customerId] });
    expect(JSON.stringify(audit.rows)).not.toContain('700000901');
  });

  it('shows the full number only to the person who asked, after someone else approves, for 30 minutes', async () => {
    await as(support).post(`/admin/customers/${customerId}/unmask-requests`).send({ reason: 'short' }).expect(422);
    const req = (await as(support).post(`/admin/customers/${customerId}/unmask-requests`).send({ reason: 'Support case SYN-101: customer cannot receive prompts' }).expect(201)).body;
    await as(support).get(`/admin/customers/${customerId}/phone?requestId=${req.requestId}`).expect(403);

    await as(support).post(`/admin/approvals/${req.requestId}/approve`).send({}).expect(403); // support cannot decide
    await as(support2).post(`/admin/approvals/${req.requestId}/approve`).send({}).expect(403);
    await as(finance).post(`/admin/approvals/${req.requestId}/approve`).send({}).expect(403);
    await as(compliance).post(`/admin/approvals/${req.requestId}/approve`).send({ note: 'Case checked' }).expect(200);

    const full = (await as(support).get(`/admin/customers/${customerId}/phone?requestId=${req.requestId}`).expect(200)).body;
    expect(full).toEqual({ customerId, phone: '+254700000901' });
    await as(support2).get(`/admin/customers/${customerId}/phone?requestId=${req.requestId}`).expect(403);
    const other = (await pool.query("select id from identity.customer where id <> $1 limit 1", [customerId])).rows[0];
    if (other) await as(support).get(`/admin/customers/${other.id}/phone?requestId=${req.requestId}`).expect(403);
    const viewed = await pool.query("select subject_id from governance.audit_event where actor_id = $1 and action = 'customer.phone_unmasked'", [support.id]);
    expect(viewed.rows).toEqual([{ subject_id: customerId }]);

    // Approvals expire: an approval decided 31 minutes ago no longer unmasks.
    const c = await pool.connect();
    try {
      await c.query('begin');
      const old = await c.query<{ id: string }>(
        "insert into governance.approval_request (kind, payload, reason, proposed_by, status, decided_by, decided_at) values ('customer_unmask', $1, 'Expiry test case', $2, 'proposed', null, null) returning id",
        [{ customerId, field: 'phone' }, support.id],
      );
      await c.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() - interval '31 minutes' where id = $1", [old.rows[0].id, compliance.id]);
      expect((await c.query("select governance.unmask_allowed($1, $2, $3, 'phone') as ok", [old.rows[0].id, support.id, customerId])).rows[0].ok).toBe(false);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('enforces who may decide an unmask request in the database', async () => {
    const r = await pool.query<{ id: string }>("insert into governance.approval_request (kind, payload, reason, proposed_by) values ('customer_unmask', $1, 'Database rule test', $2) returning id", [{ customerId, field: 'phone' }, support.id]);
    await expect(pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [r.rows[0].id, finance.id])).rejects.toThrow(/compliance or a super administrator/);
    await expect(pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [r.rows[0].id, support.id])).rejects.toThrow();
    await expect(pool.query("insert into governance.approval_request (kind, payload, reason, proposed_by) values ('customer_unmask', $1, 'Asks for a passport number', $2)", [{ customerId, field: 'passport' }, support.id])).rejects.toThrow();
    // Compliance still cannot decide role or setting changes.
    const role = await as(support).get('/admin/me').expect(200);
    const g = await pool.query<{ id: string }>("insert into governance.approval_request (kind, payload, reason, proposed_by) values ('role_grant', $1, 'Database rule test', $2) returning id", [{ staffUserId: role.body.id, role: 'finance' }, seeded['super-admin-1']]);
    await as(compliance).post(`/admin/approvals/${g.rows[0].id}/approve`).send({}).expect(403);
    await as(support).post('/admin/approvals').send({ kind: 'customer_unmask', payload: { customerId, field: 'phone' }, reason: 'Wrong door' }).expect(403);
  });
});

describe('national ID numbers', () => {
  it('are stored encrypted, shown masked, found by exact match, and unmasked only with approval', async () => {
    const otp = await http().post('/auth/otp').send({ phone: '0700000902' }).expect(202);
    const token = (await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
    const me = () => http().get('/me').set('Authorization', `Bearer ${token}`);
    const add = (nationalId: unknown) => http().post('/me/national-id').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send({ nationalId });
    expect((await me().expect(200)).body.nationalId).toBeNull();
    await add('12345').expect(422);
    await add('ABC12345').expect(422);
    expect((await add('3141 5926').expect(200)).body).toEqual({ nationalId: '******26' });
    expect((await me().expect(200)).body.nationalId).toBe('******26');
    const id = (await me()).body.id;

    // Nothing in the database holds the number in clear, or as a plain hash.
    const { createHash } = await import('node:crypto');
    const plainHash = createHash('sha256').update('31415926').digest('hex');
    for (const sql of ['select * from identity.national_id', 'select * from governance.audit_event where actor_id = $1', 'select * from platform.idempotency_key']) {
      const rows = JSON.stringify((await pool.query(sql, sql.includes('$1') ? [id] : [])).rows);
      expect(rows).not.toContain('31415926');
      expect(rows).not.toContain(plainHash);
    }

    // Another account cannot take the same number.
    const otp2 = await http().post('/auth/otp').send({ phone: '0700000903' }).expect(202);
    const token2 = (await http().post('/auth/otp/verify').send({ challengeId: otp2.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
    await http().post('/me/national-id').set('Authorization', `Bearer ${token2}`).set('Idempotency-Key', key()).send({ nationalId: '31415926' }).expect(409);

    const found = (await as(support).get('/admin/customers?nationalId=31415926').expect(200)).body.customers;
    expect(found).toEqual([expect.objectContaining({ id, nationalIdMasked: '******26' })]);
    expect(JSON.stringify(found)).not.toContain('31415926');
    await as(support).get('/admin/customers?nationalId=123').expect(422);

    // A phone approval does not unmask the ID, and the ID needs its own approval.
    const phoneReq = (await as(support).post(`/admin/customers/${id}/unmask-requests`).send({ reason: 'Support case SYN-202: confirm caller' }).expect(201)).body;
    await as(compliance).post(`/admin/approvals/${phoneReq.requestId}/approve`).send({}).expect(200);
    await as(support).get(`/admin/customers/${id}/national-id?requestId=${phoneReq.requestId}`).expect(403);
    const idReq = (await as(support).post(`/admin/customers/${id}/unmask-requests`).send({ field: 'national_id', reason: 'Support case SYN-202: insurer asks to confirm ID' }).expect(201)).body;
    expect(idReq.field).toBe('national_id');
    await as(support).get(`/admin/customers/${id}/national-id?requestId=${idReq.requestId}`).expect(403);
    await as(compliance).post(`/admin/approvals/${idReq.requestId}/approve`).send({}).expect(200);
    expect((await as(support).get(`/admin/customers/${id}/national-id?requestId=${idReq.requestId}`).expect(200)).body).toEqual({ customerId: id, nationalId: '31415926' });
    await as(support2).get(`/admin/customers/${id}/national-id?requestId=${idReq.requestId}`).expect(403);
    await as(support).post(`/admin/customers/${customerId}/unmask-requests`).send({ field: 'national_id', reason: 'Customer has no ID on file yet' }).expect(404);

    // The insurer portal role cannot read the table at all.
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role afyapay_portal');
      await expect(c.query('select last_two from identity.national_id')).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

describe('command centre', () => {
  it('gives every staff role one summary of payments, waiting work, health and launch readiness', async () => {
    const res = (await as(support).get('/admin/command-centre').expect(200)).body;
    expect(res).toMatchObject({
      paymentsToday: { confirmed: { currency: 'KES' } },
      waitingOnPeople: { reconciliationExceptions: { open: expect.any(Number), overdue: expect.any(Number) } },
      platformHealth: { deadJobs: expect.any(Number), outboxBacklog: expect.any(Number) },
      launchReadiness: { liveMoney: { allowed: false } },
    });
    expect(typeof res.paymentsToday.confirmed.amountMinor).toBe('string');
    expect(res.launchReadiness.gates).toHaveLength(9);
    expect(res.waitingOnPeople.approvalRequests.customer_unmask).toBeGreaterThanOrEqual(1);
    await http().get('/admin/command-centre').expect(401);
  });
});

describe('account actions', () => {
  async function insurerUser(): Promise<{ id: string; token: string; email: string }> {
    const email = `acct${Date.now()}${n++}@sandbox.test`;
    const u = await pool.query<{ id: string }>(
      "insert into insurer.insurer_user (insurer_id, email, display_name, role) select id, $1, 'Synthetic operator', 'operator' from insurer.insurer where code = 'PWANI' returning id",
      [email],
    );
    const ch = await http().post('/insurer-auth/email-code').send({ email }).expect(202);
    const t = (await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
    const enrol = await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
    const token = (await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200)).body.accessToken;
    return { id: u.rows[0].id, token, email };
  }
  const insurerMe = (token: string) => http().get('/insurer/me').set('Authorization', `Bearer ${token}`);

  it('lists insurer users for support, without secrets', async () => {
    const op = await insurerUser();
    const list = (await as(support).get('/admin/insurer-users').expect(200)).body;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ id: op.id, insurer: expect.any(String), role: 'operator', status: 'active', mfaEnrolled: true })]));
    expect(JSON.stringify(list)).not.toMatch(/totp|secret/i);
    await as(finance).get('/admin/insurer-users').expect(403);
  });

  it('suspends an insurer user at once, and only a super administrator can approve reactivating them', async () => {
    const op = await insurerUser();
    const admin = await staff('super_admin');
    await insurerMe(op.token).expect(200);
    await as(support).post(`/admin/accounts/insurer_user/${op.id}/suspend`).send({ reason: 'Laptop reported stolen' }).expect(403); // support cannot suspend
    await as(compliance).post(`/admin/accounts/insurer_user/${op.id}/suspend`).send({ reason: 'no' }).expect(422);
    await as(compliance).post(`/admin/accounts/insurer_user/${op.id}/suspend`).send({ reason: 'Laptop reported stolen' }).expect(200);
    await insurerMe(op.token).expect(401); // the existing session ends at once
    await as(compliance).post(`/admin/accounts/insurer_user/${op.id}/suspend`).send({ reason: 'Laptop reported stolen' }).expect(409);

    const req = (await as(support).post(`/admin/accounts/insurer_user/${op.id}/requests`).send({ action: 'reactivate', reason: 'New laptop issued, confirmed by Pwani admin' }).expect(201)).body;
    expect(req).toMatchObject({ kind: 'account_action', status: 'proposed', payload: { accountType: 'insurer_user', accountId: op.id, action: 'reactivate' } });
    await as(compliance).post(`/admin/approvals/${req.id}/approve`).send({}).expect(403); // compliance cannot decide account actions
    await as(admin).post(`/admin/approvals/${req.id}/approve`).send({}).expect(200);
    expect((await pool.query('select status from insurer.insurer_user where id = $1', [op.id])).rows[0].status).toBe('active');
    const audit = await pool.query("select action from governance.audit_event where subject_id = $1 or (after_state->'payload'->>'accountId') = $1 order by seq", [op.id]);
    expect(audit.rows.map((r) => r.action).slice(-3)).toEqual(['account.suspended', 'approval.proposed', 'approval.approved']);
  });

  it('resets an insurer authenticator after approval, which ends their sessions and makes them enrol again', async () => {
    const op = await insurerUser();
    const admin = await staff('super_admin');
    const req = (await as(support).post(`/admin/accounts/insurer_user/${op.id}/requests`).send({ action: 'reset_authenticator', reason: 'Lost phone, identity confirmed by Pwani admin' }).expect(201)).body;
    await insurerMe(op.token).expect(200); // nothing changes until approved
    await as(admin).post(`/admin/approvals/${req.id}/approve`).send({}).expect(200);
    await insurerMe(op.token).expect(401);
    const row = (await pool.query('select totp_secret_enc, totp_enrolled_at from insurer.insurer_user where id = $1', [op.id])).rows[0];
    expect(row).toEqual({ totp_secret_enc: null, totp_enrolled_at: null });
    const ch = await http().post('/insurer-auth/email-code').send({ email: op.email }).expect(202);
    const t = (await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
    expect(t.enrolled).toBe(false);
    await as(support).post(`/admin/accounts/insurer_user/${op.id}/requests`).send({ action: 'reset_authenticator', reason: 'Lost phone again' }).expect(409); // nothing to reset
  });

  it('keeps a stolen session ended after the account is reactivated or re-enrolled (incident drill)', async () => {
    const op = await insurerUser();
    const admin = await staff('super_admin');
    const stolen = op.token; // still on the stolen laptop
    await as(compliance).post(`/admin/accounts/insurer_user/${op.id}/suspend`).send({ reason: 'Laptop reported stolen' }).expect(200);
    await insurerMe(stolen).expect(401);
    for (const action of ['reset_authenticator', 'reactivate']) {
      const req = (await as(support).post(`/admin/accounts/insurer_user/${op.id}/requests`).send({ action, reason: 'New laptop issued, confirmed by Pwani admin' }).expect(201)).body;
      await as(admin).post(`/admin/approvals/${req.id}/approve`).send({}).expect(200);
    }
    // The operator enrols a new authenticator on the new laptop and signs in.
    await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole seconds
    const ch = await http().post('/insurer-auth/email-code').send({ email: op.email }).expect(202);
    const t = (await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
    const enrol = await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
    const fresh = (await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200)).body.accessToken;
    await insurerMe(fresh).expect(200);
    await insurerMe(stolen).expect(401); // the stolen laptop's session never comes back
  });

  it('keeps a staff session ended after their account is reactivated', async () => {
    const victim = await staff('support');
    const admin = await staff('super_admin');
    await as(compliance).post(`/admin/accounts/staff_user/${victim.id}/suspend`).send({ reason: 'Laptop reported stolen' }).expect(200);
    const req = (await as(support2).post(`/admin/accounts/staff_user/${victim.id}/requests`).send({ action: 'reactivate', reason: 'Laptop recovered, wiped and checked' }).expect(201)).body;
    await as(admin).post(`/admin/approvals/${req.id}/approve`).send({}).expect(200);
    await as(victim).get('/admin/me').expect(401);
  });

  it('keeps staff from acting on their own account', async () => {
    const admin = await staff('super_admin');
    const other = await staff('super_admin');
    await as(admin).post(`/admin/accounts/staff_user/${admin.id}/suspend`).send({ reason: 'Testing own suspend' }).expect(403);
    await as(admin).post(`/admin/accounts/staff_user/${admin.id}/requests`).send({ action: 'reset_authenticator', reason: 'My own phone' }).expect(403);

    const req = (await as(support).post(`/admin/accounts/staff_user/${admin.id}/requests`).send({ action: 'reset_authenticator', reason: 'Lost phone, confirmed in person' }).expect(201)).body;
    await as(admin).post(`/admin/approvals/${req.id}/approve`).send({}).expect(403); // not about yourself
    await expect(pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [req.id, admin.id])).rejects.toThrow(/own account/);
    await as(other).post(`/admin/approvals/${req.id}/approve`).send({}).expect(200);
    await as(admin).get('/admin/me').expect(401); // their session ended with the reset

  });
});
