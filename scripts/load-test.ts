/**
 * Load test for the pilot (E10). Runs against a NON-PRODUCTION AfyaPay with
 * synthetic data only: it creates synthetic customers, links and confirms
 * their policies through the real APIs, then drives a realistic mix of
 * customer traffic at stepped rates and reports latency and errors.
 *
 *   BASE_URL=http://localhost:3000 DATABASE_URL=postgres://... npx ts-node scripts/load-test.ts
 *   (start the server with RATE_LIMIT_ANON_PER_MINUTE=0: every request comes from one address)
 *   options: --customers 200 --stages 5,10,25,50 --seconds 60
 *
 * DATABASE_URL is used once, to add a synthetic insurer operator who confirms
 * the policies; the script refuses any APP_ENV other than development or test,
 * and any base URL that is not localhost.
 */
import { Client } from 'pg';
import { currentStep, totpAt } from '../src/modules/insurer/totp';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const CUSTOMERS = Number(arg('customers', '200'));
const STAGES = arg('stages', '5,10,25,50').split(',').map(Number);
const SECONDS = Number(arg('seconds', '60'));
const RUN = Date.now().toString(36).slice(-5).toUpperCase();

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('Load tests run against localhost only.');
if (!['development', 'test', undefined].includes(process.env.APP_ENV)) throw new Error('Load tests never run against staging or production.');

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: T; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T, ms: performance.now() - t0 };
}
async function must<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const r = await call<T>(method, path, body, token);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function inBatches<T>(items: T[], size: number, fn: (x: T, i: number) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map((x, j) => fn(x, i + j)));
}

interface Customer { phone: string; token: string; linkId: string; paying: boolean }

async function setup(): Promise<Customer[]> {
  const email = `load.operator.${RUN.toLowerCase()}@sandbox.test`;
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(
    "insert into insurer.insurer_user (insurer_id, email, display_name, role) select id, $1, 'Synthetic load-test operator', 'operator' from insurer.insurer where code = 'PWANI'",
    [email],
  );
  await db.end();
  const ch = await must<{ challengeId: string }>('POST', '/insurer-auth/email-code', { email });
  const t = await must<{ mfaTicket: string }>('POST', '/insurer-auth/email-code/verify', { challengeId: ch.challengeId, code: '246810' });
  const en = await must<{ secret: string }>('POST', '/insurer-auth/mfa/enrol', { mfaTicket: t.mfaTicket });
  const insurer = (await must<{ accessToken: string }>('POST', '/insurer-auth/mfa/verify', { mfaTicket: t.mfaTicket, code: totpAt(en.secret, currentStep()) })).accessToken;

  const customers: Customer[] = [];
  if (CUSTOMERS > 400) throw new Error('At most 400 synthetic customers (numbers +254700000500 to +254700000899).');
  await inBatches([...Array(CUSTOMERS).keys()], 20, async (i) => {
    // Development accepts only the synthetic range +254700000xxx; 500 upwards stays clear of the seed.
    const phone = `0700000${500 + i}`;
    const otp = await must<{ challengeId: string }>('POST', '/auth/otp', { phone });
    const tok = await must<{ accessToken: string }>('POST', '/auth/otp/verify', { challengeId: otp.challengeId, code: '123456' });
    const consent = await must<{ version: string }>('GET', '/insurers/PWANI/consent', undefined, tok.accessToken);
    const link = await must<{ id: string }>('POST', '/me/policy-links', { insurerCode: 'PWANI', policyNumber: `SYN-LOAD-${RUN}-${i}`, consent: true, consentTextVersion: consent.version }, tok.accessToken);
    await must('POST', `/insurer/policy-links/${link.id}/decision`, { decision: 'confirmed' }, insurer);
    await must('POST', `/insurer/policy-links/${link.id}/premium-schedule`, { frequency: 'monthly', amountMinor: '50000', startsOn: new Date().toISOString().slice(0, 10) }, insurer);
    customers.push({ phone, token: tok.accessToken, linkId: link.id, paying: false });
  });
  return customers;
}

type Action = { name: string; weight: number; run: (c: Customer) => Promise<{ status: number; ms: number }> };
const ACTIONS: Action[] = [
  { name: 'GET /me/policies', weight: 35, run: (c) => call('GET', '/me/policies', undefined, c.token) },
  { name: 'GET /me/policies/:id', weight: 15, run: (c) => call('GET', `/me/policies/${c.linkId}`, undefined, c.token) },
  { name: 'GET /plans', weight: 20, run: () => call('GET', `/plans?householdSize=${1 + Math.floor(Math.random() * 5)}`) },
  { name: 'GET /me/messages', weight: 10, run: (c) => call('GET', '/me/messages', undefined, c.token) },
  { name: 'GET /me/payments', weight: 10, run: (c) => call('GET', '/me/payments', undefined, c.token) },
  {
    name: 'POST /me/payments',
    weight: 10,
    run: async (c) => {
      if (c.paying) return call('GET', '/me/policies', undefined, c.token);
      c.paying = true;
      const r = await call<{ id: string }>('POST', '/me/payments', { policyLinkId: c.linkId, amountMinor: '10000' }, c.token);
      if (r.status < 300) settleLater(c, r.data.id);
      else c.paying = false;
      return r;
    },
  },
];
const totalWeight = ACTIONS.reduce((a, b) => a + b.weight, 0);
const pick = () => {
  let x = Math.random() * totalWeight;
  for (const a of ACTIONS) if ((x -= a.weight) < 0) return a;
  return ACTIONS[0];
};

const settleTimes: number[] = [];
let unsettled = 0;
let settling = 0;
function settleLater(c: Customer, id: string) {
  const t0 = performance.now();
  settling++;
  const poll = async (n: number): Promise<void> => {
    const r = await call<{ status: string }>('GET', `/me/payments/${id}`, undefined, c.token);
    if (['confirmed', 'failed', 'expired', 'needs_review'].includes(r.data?.status)) {
      settleTimes.push(performance.now() - t0);
      c.paying = false;
      settling--;
      return;
    }
    if (n > 120) { unsettled++; c.paying = false; settling--; return; }
    await new Promise((r2) => setTimeout(r2, 1000));
    return poll(n + 1);
  };
  void poll(0);
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

async function stage(customers: Customer[], rps: number) {
  // errors: 5xx, 429 or no response. rejected: other 4xx (a bug in this script or the API).
  const results: Record<string, { ms: number[]; errors: number; rejected: number }> = {};
  const inflight: Promise<void>[] = [];
  const end = Date.now() + SECONDS * 1000;
  let sent = 0;
  const started = Date.now();
  while (Date.now() < end) {
    const due = Math.floor(((Date.now() - started) / 1000) * rps);
    while (sent < due) {
      sent++;
      const a = pick();
      const c = customers[Math.floor(Math.random() * customers.length)];
      inflight.push(
        a.run(c).then(
          (r) => {
            const s = (results[a.name] ??= { ms: [], errors: 0, rejected: 0 });
            s.ms.push(r.ms);
            if (r.status >= 500 || r.status === 429) s.errors++;
            else if (r.status >= 400) s.rejected++;
          },
          () => { (results[a.name] ??= { ms: [], errors: 0, rejected: 0 }).errors++; },
        ),
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  await Promise.all(inflight);
  const all = Object.values(results).flatMap((r) => r.ms);
  const errors = Object.values(results).reduce((a, r) => a + r.errors, 0);
  const rejected = Object.values(results).reduce((a, r) => a + r.rejected, 0);
  return { rps, requests: sent, achievedRps: +(sent / SECONDS).toFixed(1), p50: Math.round(pct(all, 50)), p95: Math.round(pct(all, 95)), p99: Math.round(pct(all, 99)), errors, rejected, byEndpoint: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { n: r.ms.length, p95: Math.round(pct(r.ms, 95)), errors: r.errors, rejected: r.rejected }])) };
}

(async () => {
  console.log(`Setting up ${CUSTOMERS} synthetic customers (run ${RUN})…`);
  const t0 = Date.now();
  const customers = await setup();
  console.log(`Set up in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  const report = [];
  for (const rps of STAGES) {
    process.stdout.write(`Stage ${rps} requests/s for ${SECONDS} s… `);
    const r = await stage(customers, rps);
    report.push(r);
    console.log(`p95 ${r.p95} ms, p99 ${r.p99} ms, errors ${r.errors}, rejected ${r.rejected}`);
  }
  // Wait for every payment started during the run to reach a final status.
  const waitUntil = Date.now() + 180_000;
  while (settling > 0 && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 1000));
  console.log(JSON.stringify({ run: RUN, customers: CUSTOMERS, secondsPerStage: SECONDS, stages: report, payments: { settled: settleTimes.length, unsettled, settleP50ms: Math.round(pct(settleTimes, 50)), settleP95ms: Math.round(pct(settleTimes, 95)) } }, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
