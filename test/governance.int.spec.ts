import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_STAFF_EMAIL_CODE } from '../src/modules/insurer/insurer-auth.service';
import { currentStep, totpAt } from '../src/modules/insurer/totp';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `gv-${Date.now()}-${n++}`;
const seeded: Record<string, string> = {};

interface Staff {
  id: string;
  token: string;
}

/** Grants a role the way the seed does: proposed by one seeded super administrator, approved by the other. */
async function grant(staffId: string, role: string) {
  const r = await pool.query<{ id: string }>(
    "insert into governance.approval_request (kind, payload, reason, proposed_by) values ('role_grant', $1, 'Test set-up', $2) returning id",
    [{ staffUserId: staffId, role }, seeded['super-admin-1']],
  );
  await pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [r.rows[0].id, seeded['super-admin-2']]);
  await pool.query("insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, $2, 'grant', $3)", [staffId, role, r.rows[0].id]);
}

/** Same for a setting, used to restore the allow-list when the test itself is locked out. */
async function setSetting(settingKey: string, value: unknown) {
  const r = await pool.query<{ id: string }>(
    "insert into governance.approval_request (kind, payload, reason, proposed_by) values ('setting_change', $1, 'Test set-up', $2) returning id",
    [{ key: settingKey, value }, seeded['super-admin-1']],
  );
  await pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [r.rows[0].id, seeded['super-admin-2']]);
  await pool.query('insert into governance.setting_event (key, value, approval_request_id) values ($1, $2, $3)', [settingKey, JSON.stringify(value), r.rows[0].id]);
}

async function signIn(email: string): Promise<string> {
  const ch = await http().post('/admin-auth/email-code').send({ email }).expect(202);
  const t = (await http().post('/admin-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
  expect(t.enrolled).toBe(false);
  const enrol = await http().post('/admin-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
  return (await http().post('/admin-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200)).body.accessToken;
}

/** A synthetic staff user of this test file's own, with the given roles, signed in. */
async function staff(...roles: string[]): Promise<Staff> {
  const email = `gv${Date.now()}${n++}@sandbox.test`;
  const u = await pool.query<{ id: string }>("insert into governance.staff_user (email, display_name, created_by) values ($1, 'Synthetic test staff', 'test') returning id", [email]);
  for (const role of roles) await grant(u.rows[0].id, role);
  return { id: u.rows[0].id, token: await signIn(email) };
}

const as = (s: Staff) => ({
  get: (u: string) => http().get(u).set('Authorization', `Bearer ${s.token}`),
  post: (u: string) => http().post(u).set('Authorization', `Bearer ${s.token}`).set('Idempotency-Key', key()),
});
const pdf = Buffer.from('%PDF-1.4\n% synthetic evidence for tests\n%%EOF\n');

let adminA: Staff;
let adminB: Staff;
let compliance: Staff;
let support: Staff;

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.getHttpAdapter().getInstance().set('trust proxy', 1); // as in main.ts
  await app.init();
  pool = app.get(PG_POOL);
  for (const r of (await pool.query("select id, split_part(email, '@', 1) as k from governance.staff_user where created_by = 'seed'")).rows) seeded[r.k] = r.id;
  adminA = await staff('super_admin');
  adminB = await staff('super_admin');
  compliance = await staff('compliance');
  support = await staff('support');
});

afterAll(async () => {
  await app?.close();
});

describe('staff sign-in', () => {
  it('needs an authenticator code; an email code alone gives no access', async () => {
    await http().post('/admin-auth/email-code').send({ email: 'someone@afyapay.example' }).expect(422);
    const email = `gvnew${Date.now()}@sandbox.test`;
    await pool.query("insert into governance.staff_user (email, display_name, created_by) values ($1, 'Synthetic', 'test')", [email]);
    const ch = await http().post('/admin-auth/email-code').send({ email }).expect(202);
    const t = (await http().post('/admin-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
    await http().get('/admin/me').set('Authorization', `Bearer ${t.mfaTicket}`).expect(401);
    const enrol = await http().post('/admin-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
    await http().post('/admin-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: '000000' }).expect(401);
    const code = totpAt(enrol.body.secret, currentStep());
    const token = (await http().post('/admin-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code }).expect(200)).body.accessToken;
    await http().post('/admin-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code }).expect(401); // a code works once
    expect((await http().get('/admin/me').set('Authorization', `Bearer ${token}`).expect(200)).body).toMatchObject({ email, roles: [] });
    const secret = await pool.query('select totp_secret_enc from governance.staff_user where email = $1', [email]);
    expect(secret.rows[0].totp_secret_enc).not.toContain(enrol.body.secret);
  });

  it('applies the IP allow-list to sign-in and to every request', async () => {
    // Other test files run at the same time from 127.0.0.1, so the list always keeps it;
    // this file's app trusts one proxy hop, so a forwarded address stands for an outside network.
    const outside = '196.201.214.7';
    await setSetting('staff_ip_allowlist', ['127.0.0.1/32', '::1/128']);
    try {
      await as(adminA).get('/admin/me').expect(200);
      await as(adminA).get('/admin/me').set('X-Forwarded-For', outside).expect(403);
      await http().post('/admin-auth/email-code').set('X-Forwarded-For', outside).send({ email: 'super-admin-1@sandbox.test' }).expect(403);
      await setSetting('staff_ip_allowlist', ['127.0.0.1/32', '::1/128', '196.201.214.0/24']);
      await as(adminA).get('/admin/me').set('X-Forwarded-For', outside).expect(200);
    } finally {
      await setSetting('staff_ip_allowlist', []);
    }
  });
});

describe('roles and maker-checker', () => {
  it('needs a second super administrator to grant a role', async () => {
    const person = await staff();
    await as(person).get('/admin/staff').expect(403);
    await as(support).post('/admin/approvals').send({ kind: 'role_grant', payload: { staffUserId: person.id, role: 'finance' }, reason: 'Joins finance' }).expect(403);
    await as(adminA).post('/admin/approvals').send({ kind: 'role_grant', payload: { staffUserId: person.id, role: 'finance' } }).expect(422);
    const req = (await as(adminA).post('/admin/approvals').send({ kind: 'role_grant', payload: { staffUserId: person.id, role: 'finance' }, reason: 'Joins the finance team' }).expect(201)).body;
    expect(req).toMatchObject({ status: 'proposed', proposedBy: { id: adminA.id } });

    await as(adminA).post(`/admin/approvals/${req.id}/approve`).send({}).expect(403);
    await as(compliance).post(`/admin/approvals/${req.id}/approve`).send({}).expect(403);
    expect((await as(person).get('/admin/me').expect(200)).body.roles).toEqual([]);

    const ok = (await as(adminB).post(`/admin/approvals/${req.id}/approve`).send({ note: 'Confirmed with HR' }).expect(200)).body;
    expect(ok).toMatchObject({ status: 'approved', decidedBy: { id: adminB.id } });
    expect((await as(person).get('/admin/me').expect(200)).body.roles).toEqual(['finance']);
    await as(adminB).post(`/admin/approvals/${req.id}/approve`).send({}).expect(409);
    expect((await as(compliance).get('/admin/approvals?status=approved').expect(200)).body.map((r: { id: string }) => r.id)).toContain(req.id);

    // Removing a role works the same way, and a revoked role stops working at once.
    const rev = (await as(adminB).post('/admin/approvals').send({ kind: 'role_revoke', payload: { staffUserId: person.id, role: 'finance' }, reason: 'Left the finance team' }).expect(201)).body;
    await as(adminA).post(`/admin/approvals/${rev.id}/approve`).send({}).expect(200);
    expect((await as(person).get('/admin/me').expect(200)).body.roles).toEqual([]);
  });

  it('stops anyone deciding a change to their own roles, and lets the proposer withdraw', async () => {
    const own = (await as(adminA).post('/admin/approvals').send({ kind: 'role_grant', payload: { staffUserId: adminB.id, role: 'compliance' }, reason: 'Covers compliance this month' }).expect(201)).body;
    await as(adminB).post(`/admin/approvals/${own.id}/approve`).send({}).expect(403);
    await as(adminB).post(`/admin/approvals/${own.id}/withdraw`).expect(403);
    await as(adminA).post(`/admin/approvals/${own.id}/withdraw`).expect(200);
    await as(adminA).post(`/admin/approvals/${own.id}/withdraw`).expect(409);

    const rej = (await as(adminA).post('/admin/approvals').send({ kind: 'role_grant', payload: { staffUserId: support.id, role: 'finance' }, reason: 'Temporary cover' }).expect(201)).body;
    await as(adminB).post(`/admin/approvals/${rej.id}/reject`).send({ note: 'no' }).expect(422);
    expect((await as(adminB).post(`/admin/approvals/${rej.id}/reject`).send({ note: 'Not needed this month' }).expect(200)).body.status).toBe('rejected');
  });

  it('enforces the same rules in the database itself', async () => {
    const person = await staff();
    const mk = async (by: string) =>
      (await pool.query<{ id: string }>("insert into governance.approval_request (kind, payload, reason, proposed_by) values ('role_grant', $1, 'Database rule test', $2) returning id", [{ staffUserId: person.id, role: 'finance' }, by])).rows[0].id;
    const id = await mk(adminA.id);
    await expect(pool.query("update governance.approval_request set status = 'approved', decided_by = proposed_by, decided_at = now() where id = $1", [id])).rejects.toThrow();
    await expect(pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [id, compliance.id])).rejects.toThrow(/super administrator/);
    await expect(pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [id, person.id])).rejects.toThrow();
    await expect(pool.query("update governance.approval_request set payload = '{\"staffUserId\":\"x\",\"role\":\"super_admin\"}' where id = $1", [id])).rejects.toThrow(/cannot change/);
    await expect(pool.query('delete from governance.approval_request where id = $1', [id])).rejects.toThrow(/never deleted/);
    // A role needs an approved request that matches it.
    await expect(pool.query("insert into governance.staff_role_event (staff_user_id, role, action) values ($1, 'finance', 'grant')", [person.id])).rejects.toThrow(/approved request/);
    await expect(pool.query("insert into governance.staff_role_event (staff_user_id, role, action) values ($1, 'super_admin', 'grant')", [person.id])).rejects.toThrow(/first two/);
    await expect(pool.query("insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, 'finance', 'grant', $2)", [person.id, id])).rejects.toThrow(/approved request/);
    await pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [id, adminB.id]);
    await expect(pool.query("insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, 'super_admin', 'grant', $2)", [person.id, id])).rejects.toThrow(/approved request/);
    await pool.query("insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, 'finance', 'grant', $2)", [person.id, id]);
    await expect(pool.query("insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, 'finance', 'grant', $2)", [person.id, id])).rejects.toThrow(); // used once
    await expect(pool.query("update governance.staff_role_event set role = 'super_admin' where approval_request_id = $1", [id])).rejects.toThrow(/append-only/);
  });
});

describe('launch gates and the live-money switch', () => {
  it('lets only compliance close a gate, and only with evidence', async () => {
    const gates = (await as(support).get('/admin/launch-gates').expect(200)).body;
    expect(gates.map((g: { code: string }) => g.code)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
    expect(gates.every((g: { status: string }) => g.status === 'open')).toBe(true);

    await as(compliance).post('/admin/launch-gates/G0/close').send({ note: 'Sandbox works end to end' }).expect(422);
    await as(support).post('/admin/launch-gates/G0/evidence').field('title', 'Test run').attach('file', pdf, 'run.pdf').expect(403);
    await as(compliance).post('/admin/launch-gates/G0/evidence').field('title', 'Bad file').attach('file', Buffer.from('MZ'), 'x.exe').expect(422);
    const ev = (await as(compliance).post('/admin/launch-gates/G0/evidence').field('title', 'Sandbox test report').attach('file', pdf, 'Sandbox report.pdf').expect(201)).body;
    await as(adminA).post('/admin/launch-gates/G0/close').send({ note: 'Sandbox works end to end' }).expect(403);
    await as(compliance).post('/admin/launch-gates/G0/close').send({ note: 'Sandbox works end to end' }).expect(200);
    await as(compliance).post('/admin/launch-gates/G0/close').send({ note: 'Sandbox works end to end' }).expect(409);

    const g0 = (await as(support).get('/admin/launch-gates/G0').expect(200)).body;
    expect(g0).toMatchObject({ status: 'closed', evidenceCount: 1, history: [{ status: 'closed' }] });
    const file = await as(support).get(`/admin/launch-gates/G0/evidence/${ev.id}/content`).buffer(true).expect(200);
    expect(file.headers['content-disposition']).toBe('attachment; filename="Sandbox_report.pdf"');
    expect(Buffer.compare(file.body as Buffer, pdf)).toBe(0);

    // The database refuses a close by someone without the compliance role, or without evidence.
    await expect(pool.query("insert into governance.gate_event (gate_code, status, note, actor_id) values ('G6', 'closed', 'Direct database write', $1)", [adminA.id])).rejects.toThrow(/only compliance/);
    await expect(pool.query("insert into governance.gate_event (gate_code, status, note, actor_id) values ('G6', 'closed', 'Direct database write', $1)", [compliance.id])).rejects.toThrow(/needs evidence/);
    await expect(pool.query("update governance.gate_evidence set title = 'changed' where id = $1", [ev.id])).rejects.toThrow(/append-only/);
  });

  it('keeps live money off until G1 to G5 are closed', async () => {
    const propose = (value: boolean) => as(adminA).post('/admin/approvals').send({ kind: 'setting_change', payload: { key: 'live_money_enabled', value }, reason: 'Pilot go-live switch' });
    const blocked = await propose(true).expect(409);
    expect(blocked.body.message).toContain('Still open: G1, G2, G3, G4, G5');

    for (const g of ['G1', 'G2', 'G3', 'G4', 'G5']) {
      await as(compliance).post(`/admin/launch-gates/${g}/evidence`).field('title', `Synthetic evidence for ${g}`).expect(201);
      await as(compliance).post(`/admin/launch-gates/${g}/close`).send({ note: 'Synthetic test evidence only' }).expect(200);
    }
    const req = (await propose(true).expect(201)).body;
    // A gate reopening before approval stops the switch.
    await as(compliance).post('/admin/launch-gates/G3/reopen').send({ note: 'Agreement withdrawn' }).expect(200);
    await as(adminB).post(`/admin/approvals/${req.id}/approve`).send({}).expect(409);
    await as(compliance).post('/admin/launch-gates/G3/close').send({ note: 'Agreement signed again' }).expect(200);
    const req2 = (await propose(true).expect(201)).body;
    await as(adminB).post(`/admin/approvals/${req2.id}/approve`).send({}).expect(200);
    expect((await as(support).get('/admin/settings').expect(200)).body.liveMoney).toEqual({ switchedOn: true, allowed: true, gatesStillOpen: [] });

    // Reopening any of G1 to G5 turns live money off at once, even with the switch on.
    await as(compliance).post('/admin/launch-gates/G4/reopen').send({ note: 'Live access suspended' }).expect(200);
    expect((await as(support).get('/admin/settings').expect(200)).body.liveMoney).toEqual({ switchedOn: true, allowed: false, gatesStillOpen: ['G4'] });
    const req3 = (await propose(false).expect(201)).body;
    await as(adminB).post(`/admin/approvals/${req3.id}/approve`).send({}).expect(200);
    expect((await as(support).get('/admin/settings').expect(200)).body.liveMoney.switchedOn).toBe(false);

    // The database also refuses the switch while a gate is open.
    const r = await pool.query<{ id: string }>("insert into governance.approval_request (kind, payload, reason, proposed_by) values ('setting_change', '{\"key\":\"live_money_enabled\",\"value\":true}', 'Direct database write', $1) returning id", [adminA.id]);
    await pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [r.rows[0].id, adminB.id]);
    await expect(pool.query("insert into governance.setting_event (key, value, approval_request_id) values ('live_money_enabled', 'true', $1)", [r.rows[0].id])).rejects.toThrow(/G1 to G5/);
  });
});

describe('audit log', () => {
  it('lists events and checks the hash chain, spotting a changed event', async () => {
    const mine = (await as(compliance).get(`/admin/audit-events?actorId=${adminB.id}&action=approval.`).expect(200)).body.events;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e: { actorId: string; action: string }) => e.actorId === adminB.id && e.action.startsWith('approval.'))).toBe(true);
    await as(support).get('/admin/audit-events').expect(403);

    const ok = (await as(compliance).post('/admin/audit-events/verify').expect(200)).body;
    expect(ok).toMatchObject({ intact: true, firstBadSeq: null });
    expect(ok.checked).toBe(ok.total);

    // Tamper inside a transaction that is rolled back, with the append-only trigger off.
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('alter table governance.audit_event disable trigger audit_event_append_only');
      const target = (await c.query("select seq from governance.audit_event where actor_id = $1 order by seq limit 1", [adminB.id])).rows[0].seq;
      await c.query("update governance.audit_event set action = 'approval.edited' where seq = $1", [target]);
      const bad = (await c.query('select * from governance.verify_audit_chain()')).rows[0];
      expect(bad.problem).toBe('event content does not match its hash');
      expect(Number(bad.first_bad_seq)).toBe(Number(target));
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('links events in seq order even when many are written at once', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        pool.query("insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('system', 'test', 'test.concurrent', 'test', $1)", [String(i)]),
      ),
    );
    const out = await pool.query('select count(*)::int as n from governance.audit_event a join governance.audit_event b on b.prev_hash = a.hash where b.seq < a.seq');
    expect(out.rows[0].n).toBe(0);
    expect((await pool.query('select problem from governance.verify_audit_chain()')).rows[0].problem).toBeNull();
  });
});
