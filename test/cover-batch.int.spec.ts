import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_STAFF_EMAIL_CODE } from '../src/modules/insurer/insurer-auth.service';
import { currentStep, totpAt } from '../src/modules/insurer/totp';
import { eatDate } from '../src/modules/policy/tracks';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `cb-${Date.now()}-${n++}`;
const today = eatDate();
const until = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
const ids: Record<string, string> = {};
const policy = (i: number) => `SYN-PM-CB-${String(i).padStart(3, '0')}`;

async function staff(insurer: string, role: 'viewer' | 'operator' | 'approver'): Promise<{ token: string; id: string }> {
  const email = `${role}.${insurer.toLowerCase()}.cb${Date.now()}${n++}@sandbox.test`;
  const u = await pool.query("insert into insurer.insurer_user (insurer_id, email, display_name, role) values ($1, $2, 'Synthetic test user', $3) returning id", [ids[insurer], email, role]);
  const ch = await http().post('/insurer-auth/email-code').send({ email }).expect(202);
  const t = (await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
  const enrol = await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
  const token = (await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200)).body.accessToken;
  return { token, id: u.rows[0].id };
}

const as = (token: string) => ({
  get: (u: string) => http().get(u).set('Authorization', `Bearer ${token}`),
  post: (u: string) => http().post(u).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()),
});
const csv = (lines: string[]) => Buffer.from(['policy_number,status,covered_until,effective_on,reference', ...lines].join('\n'));
const propose = (token: string, file: Buffer, name = `cover-${n++}.csv`) => as(token).post('/insurer/cover-batches').attach('file', file, name);
const coverOf = async (num: string) =>
  (await pool.query("select e.status from policy.cover_event e join policy.policy_link l on l.id = e.policy_link_id where l.policy_number = $1 and l.insurer_id = $2 order by e.seq desc limit 1", [num, ids.PWANI])).rows[0]?.status ?? null;

let operator: { token: string; id: string };
let approverA: { token: string; id: string };
let approverB: { token: string; id: string };
let viewer: { token: string; id: string };
let jamii: { token: string; id: string };

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  for (const r of (await pool.query('select code, id from insurer.insurer')).rows) ids[r.code] = r.id;
  operator = await staff('PWANI', 'operator');
  approverA = await staff('PWANI', 'approver');
  approverB = await staff('PWANI', 'approver');
  viewer = await staff('PWANI', 'viewer');
  jamii = await staff('JAMII', 'approver');
  // 200 synthetic confirmed Pwani policies, written directly for speed.
  await pool.query(
    `with c as (insert into identity.customer (phone_e164) values ('+254700000801') on conflict (phone_e164) do update set updated_at = now() returning id)
     insert into policy.policy_link (customer_id, insurer_id, policy_number, status)
     select c.id, $1, 'SYN-PM-CB-' || lpad(g::text, 3, '0'), 'confirmed' from c, generate_series(1, 200) g
     on conflict do nothing`,
    [ids.PWANI],
  );
});

afterAll(async () => {
  await app?.close();
});

describe('bulk cover changes from a file', () => {
  it('applies a batch of 50 or fewer at once, line by line', async () => {
    const res = await propose(operator.token, csv([`${policy(1)},active,${until},${today},R1`, `${policy(2)},Active,${until},${today},`, 'SYN-PM-NOPE-1,active,' + until + ',' + today + ',', `${policy(3)},paused,,${today},`, `${policy(4)},lapsed,,${today},`])).expect(201);
    expect(res.body).toMatchObject({ status: 'applied', items: 5, needsSecondApprover: false, applied: 2, failed: 3 });
    expect(res.body.errors).toEqual([
      'Line 4: no confirmed policy SYN-PM-NOPE-1.',
      'Line 5: status must be active, lapsed or ended.',
      expect.stringMatching(/^Line 6: .*lapsed/), // none -> lapsed is not a transition the database allows
    ]);
    expect(await coverOf(policy(1))).toBe('active');
    expect(await coverOf(policy(2))).toBe('active');
    expect(await coverOf(policy(4))).toBeNull();
    const src = await pool.query("select distinct e.source from policy.cover_event e join policy.policy_link l on l.id = e.policy_link_id where l.policy_number = any($1) and l.insurer_id = $2", [[policy(1), policy(2)], ids.PWANI]);
    expect(src.rows).toEqual([{ source: 'insurer_file' }]);
  });

  it('reads Excel files and refuses files without the needed columns', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cover');
    ws.addRow(['Policy_Number', 'Status', 'Covered_Until', 'Effective_On']);
    ws.addRow([policy(5), 'active', new Date(`${until}T00:00:00Z`), new Date(`${today}T00:00:00Z`)]);
    const res = await propose(operator.token, Buffer.from(await wb.xlsx.writeBuffer()), 'cover.xlsx').expect(201);
    expect(res.body).toMatchObject({ status: 'applied', applied: 1, failed: 0 });
    expect(await coverOf(policy(5))).toBe('active');

    await propose(operator.token, Buffer.from(`policy_number,status\n${policy(6)},active\n`)).expect(422);
    await propose(operator.token, Buffer.from('%PDF-1.4 not a sheet'), 'cover.pdf').expect(422);
    await propose(viewer.token, csv([`${policy(6)},active,${until},${today},`])).expect(403);
  });

  it('holds a batch over 50 until a different approver accepts it', async () => {
    const lines = Array.from({ length: 51 }, (_, i) => `${policy(100 + i)},active,${until},${today},`);
    lines.push(`${policy(160)},active,,${today},`); // active without covered-until fails alone
    const res = await propose(approverA.token, csv(lines)).expect(201);
    expect(res.body).toMatchObject({ status: 'proposed', items: 52, needsSecondApprover: true, applied: null });
    expect(await coverOf(policy(100))).toBeNull();
    const id = res.body.id;

    await as(approverA.token).post(`/insurer/cover-batches/${id}/approve`).send({}).expect(403);
    await as(operator.token).post(`/insurer/cover-batches/${id}/approve`).send({}).expect(403);
    await as(viewer.token).post(`/insurer/cover-batches/${id}/approve`).send({}).expect(403);
    await as(jamii.token).post(`/insurer/cover-batches/${id}/approve`).send({}).expect(404);
    expect((await as(viewer.token).get(`/insurer/cover-batches/${id}`).expect(200)).body.status).toBe('proposed');

    const ok = await as(approverB.token).post(`/insurer/cover-batches/${id}/approve`).send({ note: 'Checked against our system' }).expect(200);
    expect(ok.body).toMatchObject({ status: 'applied', applied: 51, failed: 1, decidedBy: approverB.id, proposedBy: approverA.id });
    expect(ok.body.errors).toEqual([expect.stringMatching(/^Line 53: .*covered-until/)]);
    expect(await coverOf(policy(100))).toBe('active');
    await as(approverB.token).post(`/insurer/cover-batches/${id}/approve`).send({}).expect(409);
    expect((await as(viewer.token).get('/insurer/cover-batches').expect(200)).body.map((b: { id: string }) => b.id)).toContain(id);
    expect((await as(jamii.token).get('/insurer/cover-batches').expect(200)).body.map((b: { id: string }) => b.id)).not.toContain(id);
  });

  it('rejects a large batch with a reason and applies nothing', async () => {
    const lines = Array.from({ length: 51 }, (_, i) => `${policy(170 + i > 200 ? 200 : 170 + i)},ended,,${today},`);
    const res = await propose(operator.token, csv(lines)).expect(201);
    await as(approverA.token).post(`/insurer/cover-batches/${res.body.id}/reject`).send({ note: 'no' }).expect(422);
    const rej = await as(approverA.token).post(`/insurer/cover-batches/${res.body.id}/reject`).send({ note: 'Wrong month exported' }).expect(200);
    expect(rej.body).toMatchObject({ status: 'rejected', decidedBy: approverA.id, decisionNote: 'Wrong month exported' });
    await as(approverB.token).post(`/insurer/cover-batches/${res.body.id}/approve`).send({}).expect(409);
    expect(await coverOf(policy(170))).toBeNull();
  });

  it('enforces the second person and append-only rules in the database itself', async () => {
    const lines = Array.from({ length: 51 }, (_, i) => `${policy(30 + i)},active,${until},${today},`);
    const { id } = (await propose(operator.token, csv(lines)).expect(201)).body;
    await expect(pool.query("update policy.cover_batch set status = 'applied', decided_by = proposed_by, decided_at = now() where id = $1", [id])).rejects.toThrow();
    await expect(pool.query("update policy.cover_batch set item_count = 1 where id = $1", [id])).rejects.toThrow(/cannot change/);
    await expect(pool.query('delete from policy.cover_batch where id = $1', [id])).rejects.toThrow();
    await expect(pool.query("update policy.cover_batch_item set status = 'ended' where batch_id = $1", [id])).rejects.toThrow();
    await expect(pool.query('delete from policy.cover_batch_item where batch_id = $1', [id])).rejects.toThrow();

    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role afyapay_portal');
      await c.query("select set_config('app.insurer_id', $1, true)", [ids.JAMII]);
      expect((await c.query('select id from policy.cover_batch where id = $1', [id])).rowCount).toBe(0);
      expect((await c.query('select 1 from policy.cover_batch_item where batch_id = $1', [id])).rowCount).toBe(0);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
