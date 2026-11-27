import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_SYNTHETIC_CODE } from '../src/modules/identity/auth.service';
import { PLAN_INTEREST_CONSENT } from '../src/modules/identity/consent';
import { PRE_LAUNCH_STAFF_EMAIL_CODE } from '../src/modules/insurer/insurer-auth.service';
import { currentStep, totpAt } from '../src/modules/insurer/totp';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `cat-${Date.now()}-${n++}`;
const ids: Record<string, string> = {};

async function insurerStaff(insurer: string, role: 'viewer' | 'operator' | 'approver'): Promise<string> {
  const email = `${role}.${insurer.toLowerCase()}.cat${Date.now()}${n++}@sandbox.test`;
  await pool.query("insert into insurer.insurer_user (insurer_id, email, display_name, role) values ($1, $2, 'Synthetic test user', $3)", [ids[insurer], email, role]);
  const ch = await http().post('/insurer-auth/email-code').send({ email }).expect(202);
  const t = (await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
  const enrol = await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
  return (await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200)).body.accessToken;
}

async function customer(phone: string): Promise<string> {
  const otp = await http().post('/auth/otp').send({ phone }).expect(202);
  return (await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
}

const as = (token: string) => ({
  get: (u: string) => http().get(u).set('Authorization', `Bearer ${token}`),
  post: (u: string) => http().post(u).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()),
});

const planBody = (code: string, extra: Record<string, unknown> = {}) => ({
  code, name: `Test plan ${code}`, coverType: 'health_family', summary: 'Synthetic plan published by a test.', minHousehold: 1, maxHousehold: 5,
  baseMonthlyMinor: 80_000, perExtraMemberMinor: 20_000, counties: ['Mombasa', 'kilifi'], inpatientLimitMinor: '25000000', waitingPeriodDays: 30,
  benefits: ['Inpatient care'], exclusions: ['Cosmetic treatment'], ...extra,
});

let pwaniOperator: string;
let pwaniViewer: string;
let jamiiOperator: string;

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  for (const r of (await pool.query('select code, id from insurer.insurer')).rows) ids[r.code] = r.id;
  pwaniOperator = await insurerStaff('PWANI', 'operator');
  pwaniViewer = await insurerStaff('PWANI', 'viewer');
  jamiiOperator = await insurerStaff('JAMII', 'operator');
});

afterAll(async () => {
  await app?.close();
});

type Plan = { id: string; code: string; quote: { available: boolean; monthlyMinor: string }; sponsored: boolean; label: string | null; buy: { available: boolean }; counties: string[]; coverType: string };

describe('finding plans', () => {
  it('ranks by monthly price for the household only, labels sponsored plans, and keeps buying off', async () => {
    const res = (await http().get('/plans?householdSize=4').expect(200)).body;
    expect(res.buying).toEqual({ buyingAvailable: false, notice: expect.stringContaining('not available yet') });
    const plans: Plan[] = res.plans;
    expect(plans.length).toBeGreaterThanOrEqual(2);
    const prices = plans.map((p) => BigInt(p.quote.monthlyMinor));
    expect(prices).toEqual([...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(plans.every((p) => p.buy.available === false)).toBe(true);
    const family = plans.find((p) => p.code === 'PM-HL')!;
    expect(family).toMatchObject({ sponsored: true, label: 'Sponsored', quote: { monthlyMinor: String(132_000 + 3 * 35_000) } });
    // The cheaper unsponsored Jamii family plan stays ahead of the sponsored one.
    expect(plans.findIndex((p) => p.code === 'JA-FB')).toBeLessThan(plans.findIndex((p) => p.code === 'PM-HL'));
    expect(plans.some((p) => p.code === 'PM-IN')).toBe(false); // individual plan does not fit 4 people
  });

  it('filters by county, budget and cover type, and refuses bad filters', async () => {
    const mombasa: Plan[] = (await http().get('/plans?householdSize=3&county=mombasa').expect(200)).body.plans;
    expect(mombasa.some((p) => p.code === 'JA-FB')).toBe(false); // Nairobi area only
    expect(mombasa.some((p) => p.code === 'PM-HL')).toBe(true); // all counties
    const cheap: Plan[] = (await http().get('/plans?budgetMinor=50000').expect(200)).body.plans;
    expect(cheap.every((p) => BigInt(p.quote.monthlyMinor) <= 50_000n)).toBe(true);
    expect(cheap.some((p) => p.code === 'JA-BD')).toBe(true);
    const accident: Plan[] = (await http().get('/plans?coverType=personal_accident').expect(200)).body.plans;
    expect(accident.every((p) => p.coverType === 'personal_accident')).toBe(true);
    await http().get('/plans?county=Atlantis').expect(422);
    await http().get('/plans?householdSize=0').expect(422);
    await http().get('/plans?budgetMinor=1500.50').expect(422);
    await http().get('/plans?coverType=car').expect(422);
    expect((await http().get('/plans/counties').expect(200)).body).toHaveLength(47);
  });

  it('compares two or three plans side by side', async () => {
    const seededIds = (await pool.query("select id from catalogue.plan where code in ('PM-IN', 'PM-HL', 'JA-FB', 'JA-BD') and updated_by = 'seed' order by code")).rows.map((r) => r.id);
    const [a, b, c, d] = seededIds;
    const cmp = (await http().get(`/plans/compare?ids=${a},${b},${c}&householdSize=2`).expect(200)).body;
    expect(cmp.plans.map((p: Plan) => p.id)).toEqual([a, b, c]);
    expect(cmp.rows.map((r: { label: string }) => r.label)).toContain('Monthly price for your household');
    expect(cmp.rows.every((r: { values: unknown[] }) => r.values.length === 3)).toBe(true);
    // A plan that does not fit the household is still compared, with no price for it.
    expect(cmp.plans.filter((p: Plan) => !p.quote.available).length).toBeGreaterThan(0);
    expect(cmp.buying.buyingAvailable).toBe(false);
    await http().get(`/plans/compare?ids=${a}`).expect(422);
    await http().get(`/plans/compare?ids=${a},${b},${c},${d}`).expect(422);
    await http().get(`/plans/compare?ids=${a},00000000-0000-0000-0000-000000000000`).expect(404);
  });
});

describe('insurer-supplied plans', () => {
  it('lets insurer staff publish, update and withdraw their own plans only', async () => {
    const code = `T${Date.now() % 1_000_000}`;
    await as(pwaniViewer).post('/insurer/plans').send(planBody(code)).expect(403);
    await as(pwaniOperator).post('/insurer/plans').send(planBody(code, { baseMonthlyMinor: 800.5 })).expect(422);
    await as(pwaniOperator).post('/insurer/plans').send(planBody(code, { counties: ['Atlantis'] })).expect(422);
    const made = (await as(pwaniOperator).post('/insurer/plans').send(planBody(code)).expect(200)).body;
    expect(made).toMatchObject({ created: true, code, counties: ['Mombasa', 'Kilifi'], baseMonthlyMinor: '80000', sponsored: false });
    const updated = (await as(pwaniOperator).post('/insurer/plans').send(planBody(code, { baseMonthlyMinor: 85_000, sponsored: true })).expect(200)).body;
    expect(updated).toMatchObject({ created: false, id: made.id, baseMonthlyMinor: '85000', sponsored: true });

    const found = (await http().get('/plans?householdSize=2&county=Kilifi').expect(200)).body.plans.find((p: Plan) => p.id === made.id);
    expect(found).toMatchObject({ quote: { monthlyMinor: '105000' }, label: 'Sponsored', insurer: { code: 'PWANI' } });
    expect((await as(jamiiOperator).get('/insurer/plans').expect(200)).body.map((p: { id: string }) => p.id)).not.toContain(made.id);
    await as(jamiiOperator).post(`/insurer/plans/${code}/withdraw`).expect(404);

    await as(pwaniOperator).post(`/insurer/plans/${code}/withdraw`).expect(200);
    expect((await http().get('/plans?householdSize=2').expect(200)).body.plans.map((p: Plan) => p.id)).not.toContain(made.id);
    await http().get(`/plans/${made.id}`).expect(404);
  });

  it('has no commission or fee column to rank by', async () => {
    const cols = (await pool.query("select column_name from information_schema.columns where table_schema = 'catalogue'")).rows.map((r) => r.column_name);
    expect(cols.filter((c: string) => /commission|fee|boost|rank|weight/.test(c))).toEqual([]);
  });
});

describe('registering interest', () => {
  it('needs consent, records it, and shows the interest to that insurer only', async () => {
    const token = await customer('0700000951');
    const plan: Plan = (await http().get('/plans?householdSize=3').expect(200)).body.plans.find((p: Plan) => p.code === 'PM-HL');
    const consent = (await http().get(`/plans/${plan.id}/interest-consent`).expect(200)).body;
    expect(consent).toEqual({ version: PLAN_INTEREST_CONSENT.version, text: expect.stringContaining('Pwani Mutual (fictional) can contact me about Afya Plus Family') });

    const body = { planId: plan.id, householdSize: 3, county: 'Nakuru', consent: true, consentTextVersion: PLAN_INTEREST_CONSENT.version };
    await http().post('/me/plan-interests').set('Idempotency-Key', key()).send(body).expect(401);
    await as(token).post('/me/plan-interests').send({ ...body, consent: false }).expect(422);
    await as(token).post('/me/plan-interests').send({ ...body, householdSize: 9 }).expect(422);
    const made = (await as(token).post('/me/plan-interests').send(body).expect(201)).body;
    expect(made).toMatchObject({ status: 'new', quotedMonthlyMinor: String(132_000 + 2 * 35_000), message: expect.stringContaining('does not give you cover') });
    await as(token).post('/me/plan-interests').send(body).expect(409);
    expect((await as(token).get('/me/plan-interests').expect(200)).body.map((i: { id: string }) => i.id)).toEqual([made.id]);

    const consents = await pool.query("select c.granted, c.text_version, i.code from identity.consent_record c join identity.customer u on u.id = c.customer_id join insurer.insurer i on i.id = c.insurer_id where u.phone_e164 = '+254700000951' and c.purpose = 'plan_interest'");
    expect(consents.rows).toEqual([{ granted: true, text_version: PLAN_INTEREST_CONSENT.version, code: 'PWANI' }]);

    const seen = (await as(pwaniViewer).get('/insurer/plan-interests').expect(200)).body.find((i: { id: string }) => i.id === made.id);
    expect(seen).toMatchObject({ phone: '+254700000951', householdSize: 3, county: 'Nakuru', plan: { code: 'PM-HL' } });
    expect((await as(jamiiOperator).get('/insurer/plan-interests').expect(200)).body.map((i: { id: string }) => i.id)).not.toContain(made.id);
    await as(pwaniViewer).post(`/insurer/plan-interests/${made.id}/status`).send({ status: 'contacted' }).expect(403);
    await as(jamiiOperator).post(`/insurer/plan-interests/${made.id}/status`).send({ status: 'contacted' }).expect(404);
    await as(pwaniOperator).post(`/insurer/plan-interests/${made.id}/status`).send({ status: 'contacted', note: 'Called, sending brochure' }).expect(200);
    expect((await as(token).get('/me/plan-interests').expect(200)).body[0].status).toBe('contacted');
  });
});

describe('the buying switch', () => {
  it('stays off until gate G6 is closed, refused by the database too', async () => {
    expect((await http().get('/plans/status').expect(200)).body).toEqual({ buyingAvailable: false, notice: expect.any(String) });
    const admins = (await pool.query("select id from governance.staff_user where email in ('super-admin-1@sandbox.test', 'super-admin-2@sandbox.test') order by email")).rows.map((r) => r.id);
    const r = await pool.query<{ id: string }>(
      "insert into governance.approval_request (kind, payload, reason, proposed_by) values ('setting_change', '{\"key\":\"plan_buying_enabled\",\"value\":true}', 'Direct database write', $1) returning id",
      [admins[0]],
    );
    await pool.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [r.rows[0].id, admins[1]]);
    await expect(pool.query("insert into governance.setting_event (key, value, approval_request_id) values ('plan_buying_enabled', 'true', $1)", [r.rows[0].id])).rejects.toThrow(/G6/);
    expect((await pool.query('select governance.plan_buying_allowed() as ok')).rows[0].ok).toBe(false);
  });
});
