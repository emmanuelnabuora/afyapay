import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_SYNTHETIC_CODE } from '../src/modules/identity/auth.service';
import { SHARE_WITH_INSURER_CONSENT } from '../src/modules/identity/consent';
import { PRE_LAUNCH_STAFF_EMAIL_CODE } from '../src/modules/insurer/insurer-auth.service';
import { currentStep, totpAt } from '../src/modules/insurer/totp';
import { PaymentWorker } from '../src/modules/payment/payment.worker';
import { PolicyLinkService } from '../src/modules/policy/policy-link.service';
import { eatDate } from '../src/modules/policy/tracks';
import { settlePayment } from './helpers/settle';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `rc-${Date.now()}-${n++}`;
const today = eatDate();
const ids: Record<string, string> = {};

/** Creates a synthetic staff user of its own, so test files never share an authenticator, and signs in. */
async function staff(insurer: string, role: 'viewer' | 'operator' | 'approver'): Promise<string> {
  const email = `${role}.${insurer.toLowerCase()}.rc${Date.now()}${n++}@sandbox.test`;
  await pool.query("insert into insurer.insurer_user (insurer_id, email, display_name, role) values ($1, $2, 'Synthetic test user', $3)", [ids[insurer], email, role]);
  const ch = await http().post('/insurer-auth/email-code').send({ email }).expect(202);
  const t = (await http().post('/insurer-auth/email-code/verify').send({ challengeId: ch.body.challengeId, code: PRE_LAUNCH_STAFF_EMAIL_CODE }).expect(200)).body;
  const enrol = await http().post('/insurer-auth/mfa/enrol').send({ mfaTicket: t.mfaTicket }).expect(200);
  return (await http().post('/insurer-auth/mfa/verify').send({ mfaTicket: t.mfaTicket, code: totpAt(enrol.body.secret, currentStep()) }).expect(200)).body.accessToken;
}

const as = (token: string) => ({
  get: (u: string) => http().get(u).set('Authorization', `Bearer ${token}`),
  post: (u: string) => http().post(u).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()),
});
const upload = (token: string, csv: string, name = `statement-${n++}.csv`) => as(token).post('/insurer/statements').attach('file', Buffer.from(csv), name);

/** A confirmed simulated payment to Pwani; returns its receipt. */
async function paid(customerToken: string, linkId: string, amountMinor: number): Promise<{ id: string; receipt: string }> {
  const started = await http().post('/me/payments').set('Authorization', `Bearer ${customerToken}`).set('Idempotency-Key', key()).send({ policyLinkId: linkId, amountMinor }).expect(201);
  const checkout = (await pool.query('select checkout_request_id from payment.stk_request where payment_intent_id = $1', [started.body.id])).rows[0].checkout_request_id;
  await settlePayment(pool, app.get(PaymentWorker), checkout);
  const r = await pool.query('select mpesa_receipt from payment.payment_result where payment_intent_id = $1 and result_code = 0', [started.body.id]);
  return { id: started.body.id, receipt: r.rows[0].mpesa_receipt };
}

let operator: string;
let viewer: string;
let jamii: string;
let customerToken: string;
let linkId: string;

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  for (const r of (await pool.query('select code, id from insurer.insurer')).rows) ids[r.code] = r.id;
  operator = await staff('PWANI', 'operator');
  viewer = await staff('PWANI', 'viewer');
  jamii = await staff('JAMII', 'approver');

  const otp = await http().post('/auth/otp').send({ phone: '0700000701' }).expect(202);
  customerToken = (await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
  const link = await http()
    .post('/me/policy-links')
    .set('Authorization', `Bearer ${customerToken}`)
    .set('Idempotency-Key', key())
    .send({ insurerCode: 'PWANI', policyNumber: 'SYN-PM-RC-0701', consent: true, consentTextVersion: SHARE_WITH_INSURER_CONSENT.version })
    .expect(201);
  linkId = link.body.id;
  await app.get(PolicyLinkService).decide(linkId, 'confirmed', { insurerId: ids.PWANI, userId: 'synthetic-pwani-user' });
});

afterAll(async () => {
  await app?.close();
});

describe('statement reconciliation', () => {
  it('matches lines to confirmed payments and turns every difference into an exception', async () => {
    const a = await paid(customerToken, linkId, 100000);
    const b = await paid(customerToken, linkId, 200000);
    const c = await paid(customerToken, linkId, 300000);
    const d = await paid(customerToken, linkId, 400000); // left out of the statement

    const csv = [
      'receipt,policy_number,amount,date',
      `${a.receipt},SYN-PM-RC-0701,"1,000.00",${today}`, // matches
      `${b.receipt},SYN-PM-RC-0701,2100,${today}`, // wrong amount
      `${c.receipt},SYN-PM-OTHER,3000,${today}`, // wrong policy
      'SIMNOTOURS1,SYN-PM-RC-0701,500,' + today, // not an AfyaPay payment
      `${a.receipt},SYN-PM-RC-0701,1000,${today}`, // repeated in the file
      'bad line,,,',
    ].join('\n');
    const res = await upload(operator, csv).expect(201);
    expect(res.body).toMatchObject({ lineCount: 6, matched: 1, exceptions: 5, periodFrom: today, periodTo: today });
    // At least d; other test files pay Pwani today too, and those are missing from this statement as well.
    expect(res.body.missingFromStatement).toBeGreaterThanOrEqual(1);

    const open = (await as(operator).get('/insurer/exceptions').expect(200)).body;
    const kinds = (paymentOrLine: (e: { paymentId: string | null; detail: string }) => boolean) => open.filter(paymentOrLine).map((e: { kind: string }) => e.kind);
    expect(kinds((e) => e.paymentId === b.id)).toEqual(['amount_mismatch']);
    expect(kinds((e) => e.paymentId === c.id)).toEqual(['policy_mismatch']);
    expect(kinds((e) => e.paymentId === d.id)).toEqual(['missing_from_statement']);
    expect(kinds((e) => e.detail.includes('SIMNOTOURS1'))).toEqual(['unknown_receipt']);
    expect(kinds((e) => e.detail.startsWith('Line 6:'))).toEqual(['duplicate_line']);
    expect(kinds((e) => e.detail.startsWith('Line 7:'))).toEqual(['unparseable_line']);
    expect(open.find((e: { paymentId: string }) => e.paymentId === b.id).detail).toContain('KES 2100 in the statement, KES 2000 paid');

    // The same file twice is refused; a later statement clears "missing" and counts earlier matches once.
    await upload(operator, csv, 'again.csv').expect(409);
    const later = await upload(operator, `receipt,policy_number,amount,date\n${d.receipt},SYN-PM-RC-0701,4000,${today}\n${a.receipt},SYN-PM-RC-0701,1000,${today}\n`).expect(201);
    expect(later.body).toMatchObject({ matched: 1, alreadyMatched: 1, exceptions: 0 });
    const missing = await pool.query("select status, resolved_by from reconciliation.exception where payment_intent_id = $1 and kind = 'missing_from_statement'", [d.id]);
    expect(missing.rows).toEqual([{ status: 'resolved', resolved_by: 'system' }]);
  });

  it('lets staff own and resolve exceptions with a note, and reports collections and ageing', async () => {
    await upload(operator, `receipt,policy_number,amount,date\nSIMUNKNOWN2,SYN-PM-RC-0701,750,${today}\n`).expect(201);
    const exc = (await as(operator).get('/insurer/exceptions').expect(200)).body.find((e: { detail: string }) => e.detail.includes('SIMUNKNOWN2'));
    expect(exc).toMatchObject({ status: 'open', owner: null, overdue: false });
    expect(new Date(exc.dueAt).getTime() - Date.now()).toBeGreaterThan(47 * 3600 * 1000);

    await as(viewer).post(`/insurer/exceptions/${exc.id}/resolve`).send({ note: 'Paid at branch' }).expect(403);
    await as(operator).post(`/insurer/exceptions/${exc.id}/assign`).expect(200);
    await as(operator).post(`/insurer/exceptions/${exc.id}/resolve`).send({ note: 'ok' }).expect(422);
    const done = await as(operator).post(`/insurer/exceptions/${exc.id}/resolve`).send({ note: 'Customer paid the paybill directly, not through AfyaPay.' }).expect(200);
    expect(done.body).toMatchObject({ status: 'resolved' });
    await as(operator).post(`/insurer/exceptions/${exc.id}/resolve`).send({ note: 'again and again' }).expect(409);
    await expect(pool.query('delete from reconciliation.statement_line')).rejects.toThrow(/append-only/);

    const daily = (await as(viewer).get(`/insurer/reports/daily-collections?from=${today}&to=${today}`).expect(200)).body;
    expect(daily[0]).toMatchObject({ day: today, currency: 'KES' });
    expect(BigInt(daily[0].totalMinor) >= 1000000n).toBe(true);
    const ageing = (await as(viewer).get('/insurer/reports/exception-ageing').expect(200)).body;
    expect(ageing.under_1_day).toBeGreaterThanOrEqual(5);
  });

  it('uses each insurer’s own column mapping', async () => {
    const p = await paid(customerToken, linkId, 50000);
    const [y, m, d] = today.split('-');
    await as(viewer).post('/insurer/statement-mapping').send({ receiptCol: 'x' }).expect(403);
    await as(operator).post('/insurer/statement-mapping').send({ receiptCol: 'Trans ID', policyCol: 'Account', amountCol: 'Paid In', dateCol: 'Completion Time', dateFormat: 'DD/MM/YYYY' }).expect(200);
    await upload(operator, `receipt,policy_number,amount,date\n${p.receipt},SYN-PM-RC-0701,500,${today}\n`).expect(422);
    const res = await upload(operator, `Trans ID,Completion Time,Account,Paid In\n${p.receipt},${d}/${m}/${y} 10:15,SYN-PM-RC-0701,500.00\n`).expect(201);
    expect(res.body).toMatchObject({ matched: 1, exceptions: 0 });
    expect((await as(jamii).get('/insurer/statement-mapping').expect(200)).body.receiptCol).toBe('receipt');
  });

  it('keeps each insurer’s statements and exceptions to itself', async () => {
    const pwaniStatements = (await as(operator).get('/insurer/statements').expect(200)).body.map((s: { id: string }) => s.id);
    const jamiiStatements = (await as(jamii).get('/insurer/statements').expect(200)).body.map((s: { id: string }) => s.id);
    expect(pwaniStatements.length).toBeGreaterThan(0);
    expect(jamiiStatements.filter((id: string) => pwaniStatements.includes(id))).toEqual([]);
    const pwaniException = (await as(operator).get('/insurer/exceptions?status=all').expect(200)).body[0];
    await as(jamii).post(`/insurer/exceptions/${pwaniException.id}/resolve`).send({ note: 'not mine to resolve' }).expect(404);
    // A Pwani receipt in a Jamii statement is unknown to Jamii.
    const res = await upload(jamii, `receipt,policy_number,amount,date\n${(await pool.query('select mpesa_receipt from payment.payment_result where mpesa_receipt is not null limit 1')).rows[0].mpesa_receipt},X,1,${today}\n`).expect(201);
    expect(res.body).toMatchObject({ matched: 0, exceptions: 1 });
  });

  it('matches a 5,000-line statement in under 2 minutes', async () => {
    // 5,000 synthetic confirmed payments to Jamii, written directly for speed.
    const setup = await pool.query(
      `with c as (insert into identity.customer (phone_e164) values ('+254700000799') on conflict (phone_e164) do update set updated_at = now() returning id),
            l as (insert into policy.policy_link (customer_id, insurer_id, policy_number, status) select id, $1, 'SYN-JA-PERF-1', 'confirmed' from c returning id, customer_id)
       select l.id as link_id, l.customer_id, a.id as account_id from l, insurer.collection_account a where a.insurer_id = $1 and a.active`,
      [ids.JAMII],
    );
    const { link_id, customer_id, account_id } = setup.rows[0];
    await pool.query(
      `with p as (
         insert into payment.payment_intent (customer_id, policy_link_id, insurer_id, collection_account_id, amount_minor, status)
         select $1, $2, $3, $4, 100 * (100 + g), 'confirmed' from generate_series(1, 5000) g returning id, amount_minor)
       insert into payment.payment_result (payment_intent_id, result_code, result_desc, mpesa_receipt, amount_minor, confirmed_via)
       select id, 0, 'ok', 'PERF' || lpad(((amount_minor / 100) - 100)::text, 6, '0'), amount_minor, 'status_query' from p`,
      [customer_id, link_id, ids.JAMII, account_id],
    );
    const lines = ['receipt,policy_number,amount,date'];
    for (let g = 1; g <= 5000; g++) lines.push(`PERF${String(g).padStart(6, '0')},SYN-JA-PERF-1,${100 + g},${today}`);

    const started = Date.now();
    const res = await upload(jamii, lines.join('\n'), 'jamii-5000.csv').expect(201);
    const seconds = (Date.now() - started) / 1000;
    expect(res.body).toMatchObject({ lineCount: 5000, matched: 5000, exceptions: 0 });
    expect(seconds).toBeLessThan(120);
  }, 150_000);

  it('reads Excel statements directly, dates and amounts as typed cells', async () => {
    const p = await paid(customerToken, linkId, 65000);
    await as(operator).post('/insurer/statement-mapping').send({ receiptCol: 'Trans ID', policyCol: 'Account', amountCol: 'Paid In', dateCol: 'Completion Time', dateFormat: 'DD/MM/YYYY' }).expect(200);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.addRow(['Trans ID', 'Completion Time', 'Account', 'Paid In']);
    ws.addRow([p.receipt, new Date(`${today}T10:15:00Z`), 'SYN-PM-RC-0701', 650]);
    const res = await as(operator).post('/insurer/statements').attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'statement.xlsx').expect(201);
    expect(res.body).toMatchObject({ lineCount: 1, matched: 1, exceptions: 0, periodFrom: today });
    await as(operator).post('/insurer/statements').attach('file', Buffer.from('MZ not a statement'), 'statement.exe').expect(422);
  });

  it('holds PDF statements for a second person to transcribe', async () => {
    const p = await paid(customerToken, linkId, 72000);
    const approver = await staff('PWANI', 'approver');
    const pdf = Buffer.from('%PDF-1.4\n% synthetic statement for tests\n%%EOF\n');
    await as(operator).post('/insurer/statements').attach('file', pdf, 'statement.pdf').expect(422);
    await as(operator).post('/insurer/statement-documents').attach('file', Buffer.from('not really a pdf'), 'fake.pdf').expect(422);
    await as(viewer).post('/insurer/statement-documents').attach('file', pdf, 'statement.pdf').expect(403);
    const doc = (await as(operator).post('/insurer/statement-documents').attach('file', pdf, 'November statement.pdf').expect(201)).body;
    expect(doc).toMatchObject({ status: 'awaiting_review' });

    const listed = (await as(viewer).get('/insurer/statement-documents').expect(200)).body.find((d: { id: string }) => d.id === doc.id);
    expect(listed).toMatchObject({ status: 'awaiting_review', statementId: null });
    const content = await as(viewer).get(`/insurer/statement-documents/${doc.id}/content`).buffer(true).expect(200);
    expect(content.headers['content-type']).toContain('application/pdf');
    expect(content.headers['content-disposition']).toBe('attachment; filename="November_statement.pdf"');
    expect(Buffer.compare(content.body as Buffer, pdf)).toBe(0);
    await as(jamii).get(`/insurer/statement-documents/${doc.id}/content`).expect(404);

    const [y, m, d] = today.split('-');
    const lines = Buffer.from(`Trans ID,Completion Time,Account,Paid In\n${p.receipt},${d}/${m}/${y},SYN-PM-RC-0701,720\n`);
    await as(operator).post(`/insurer/statement-documents/${doc.id}/transcription`).attach('file', lines, 'typed.csv').expect(403);
    await as(viewer).post(`/insurer/statement-documents/${doc.id}/transcription`).attach('file', lines, 'typed.csv').expect(403);
    const done = await as(approver).post(`/insurer/statement-documents/${doc.id}/transcription`).attach('file', lines, 'typed.csv').expect(201);
    expect(done.body).toMatchObject({ matched: 1, exceptions: 0 });
    await as(approver).post(`/insurer/statement-documents/${doc.id}/transcription`).attach('file', Buffer.concat([lines, Buffer.from('\n')]), 'typed2.csv').expect(409);
    const after = (await as(viewer).get('/insurer/statement-documents').expect(200)).body.find((x: { id: string }) => x.id === doc.id);
    expect(after).toMatchObject({ status: 'transcribed', statementId: done.body.id });
    await expect(pool.query("update reconciliation.statement_document set status = 'awaiting_review', statement_id = null where id = $1", [doc.id])).rejects.toThrow(/already transcribed/);
    await expect(pool.query('delete from reconciliation.statement_document where id = $1', [doc.id])).rejects.toThrow(/never deleted/);
    const other = (await as(operator).post('/insurer/statement-documents').attach('file', Buffer.concat([pdf, Buffer.from('% 2')]), 'second.pdf').expect(201)).body;
    await expect(pool.query("update reconciliation.statement_document set status = 'rejected', reviewed_by = uploaded_by, reviewed_at = now() where id = $1", [other.id])).rejects.toThrow();
    await expect(pool.query("update reconciliation.statement_document set content = 'x' where id = $1", [other.id])).rejects.toThrow(/cannot change/);
  });
});
