import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { seedSandbox } from '../src/database/seed-sandbox';
import { PRE_LAUNCH_SYNTHETIC_CODE } from '../src/modules/identity/auth.service';
import { SHARE_WITH_INSURER_CONSENT, SMS_REMINDERS_CONSENT } from '../src/modules/identity/consent';
import { NotificationService } from '../src/modules/notification/notification.service';
import { PaymentWorker } from '../src/modules/payment/payment.worker';
import { settlePayment } from './helpers/settle';
import { PolicyLinkService } from '../src/modules/policy/policy-link.service';
import { InsurerActor, PolicyTracksService } from '../src/modules/policy/policy-tracks.service';
import { eatDate, periodStart } from '../src/modules/policy/tracks';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
let notifications: NotificationService;
let pwani: InsurerActor;
const http = () => request(app.getHttpServer());
let n = 0;
const key = () => `nt-${Date.now()}-${n++}`;
const today = eatDate();
const plusDays = (d: number) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

async function customer(phone: string, policyNumber: string) {
  const otp = await http().post('/auth/otp').send({ phone }).expect(202);
  const token = (await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200)).body.accessToken;
  const link = await http()
    .post('/me/policy-links')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key())
    .send({ insurerCode: 'PWANI', policyNumber, consent: true, consentTextVersion: SHARE_WITH_INSURER_CONSENT.version })
    .expect(201);
  await app.get(PolicyLinkService).decide(link.body.id, 'confirmed', { insurerId: pwani.insurerId, userId: pwani.userId });
  const customerId = (await pool.query('select customer_id from policy.policy_link where id = $1', [link.body.id])).rows[0].customer_id;
  return { token, linkId: link.body.id as string, customerId: customerId as string };
}

/** Delivers this payment's outbox events to the notification handler (not the shared relay, which other test files use). */
async function deliverEvents(paymentId: string) {
  const { rows } = await pool.query('select id, topic, aggregate_type, aggregate_id, payload, created_at from platform.outbox_event where aggregate_id = $1 order by created_at', [paymentId]);
  for (const r of rows) await notifications.handleEvent({ id: r.id, topic: r.topic, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, payload: r.payload, createdAt: r.created_at });
}

async function payAndSettle(token: string, linkId: string, amountMinor: number) {
  const started = await http().post('/me/payments').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key()).send({ policyLinkId: linkId, amountMinor }).expect(201);
  const checkout = (await pool.query('select checkout_request_id from payment.stk_request where payment_intent_id = $1', [started.body.id])).rows[0].checkout_request_id;
  await settlePayment(pool, app.get(PaymentWorker), checkout);
  return started.body.id as string;
}

const messages = (customerId: string, channel: string) =>
  pool.query('select template, body, status, status_reason, essential from notification.message where customer_id = $1 and channel = $2 order by created_at', [customerId, channel]).then((r) => r.rows);

beforeAll(async () => {
  await seedSandbox(process.env.TEST_DATABASE_URL!);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  notifications = app.get(NotificationService);
  pwani = { insurerId: (await pool.query("select id from insurer.insurer where code = 'PWANI'")).rows[0].id, userId: 'synthetic-pwani-user', source: 'insurer_portal' };
});

afterAll(async () => {
  await app?.close();
});

describe('notifications', () => {
  it('tells the customer about a paid premium in the app and by SMS, but never sends to a synthetic number', async () => {
    const c = await customer('0700000501', 'SYN-PM-NTF-0501');
    const paymentId = await payAndSettle(c.token, c.linkId, 120000);
    await deliverEvents(paymentId);
    await deliverEvents(paymentId); // a repeated event adds nothing

    const inbox = await http().get('/me/messages').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(inbox.body.map((m: { template: string }) => m.template)).toEqual(['payment_confirmed', 'payment_prompt_sent']);
    expect(inbox.body[0].body).toMatch(/^AfyaPay: KES 1,200 paid to Pwani Mutual \(fictional\)\. M-Pesa ref SIM[0-9A-F]{7}\.$/);

    expect((await messages(c.customerId, 'sms')).map((m) => [m.template, m.status, m.essential])).toEqual([
      ['payment_prompt_sent', 'queued', true],
      ['payment_confirmed', 'queued', true],
    ]);
    await notifications.sendDue();
    for (const m of await messages(c.customerId, 'sms')) expect(m).toMatchObject({ status: 'suppressed', status_reason: 'synthetic number: never sent' });
  });

  it('explains a failed payment in the customer language', async () => {
    const c = await customer('0700000509', 'SYN-PM-NTF-0509');
    await http().post('/me/preferences').set('Authorization', `Bearer ${c.token}`).set('Idempotency-Key', key()).send({ language: 'sw' }).expect(201);
    const paymentId = await payAndSettle(c.token, c.linkId, 50000);
    await deliverEvents(paymentId);
    const failed = (await messages(c.customerId, 'in_app')).find((m) => m.template === 'payment_failed');
    expect(failed.body).toBe('AfyaPay: Malipo hayakufanikiwa: Ulighairi ombi la M-Pesa.');
  });

  it('sends reminders by SMS only with consent, once, and always shows them in the app', async () => {
    // Monthly plan whose due date is three days away, nothing paid yet.
    const startsOn = periodStart('monthly', plusDays(4), -1);
    const without = await customer('0700000502', 'SYN-PM-NTF-0502');
    const withConsent = await customer('0700000503', 'SYN-PM-NTF-0503');
    for (const c of [without, withConsent]) await app.get(PolicyTracksService).setPremiumSchedule(c.linkId, pwani, { frequency: 'monthly', amountMinor: 300000n, startsOn });

    await http().post('/me/preferences').set('Authorization', `Bearer ${withConsent.token}`).set('Idempotency-Key', key()).send({ smsReminders: true }).expect(422);
    const prefs = await http()
      .post('/me/preferences')
      .set('Authorization', `Bearer ${withConsent.token}`)
      .set('Idempotency-Key', key())
      .send({ smsReminders: true, consentTextVersion: SMS_REMINDERS_CONSENT.version })
      .expect(201);
    expect(prefs.body).toMatchObject({ language: 'en', smsReminders: true });

    await notifications.runReminders();
    await notifications.runReminders();

    expect(await messages(without.customerId, 'in_app')).toEqual([
      expect.objectContaining({ template: 'premium_reminder', body: `AfyaPay: Saved towards your Pwani Mutual (fictional) premium: KES 0 of KES 3,000. Due ${plusDays(3)}.` }),
    ]);
    expect(await messages(without.customerId, 'sms')).toEqual([expect.objectContaining({ status: 'skipped_no_consent', essential: false })]);
    expect(await messages(withConsent.customerId, 'sms')).toEqual([expect.objectContaining({ template: 'premium_reminder', status: 'queued' })]);

    // Turning reminders off is a new consent row, never an edit.
    await http().post('/me/preferences').set('Authorization', `Bearer ${withConsent.token}`).set('Idempotency-Key', key()).send({ smsReminders: false }).expect(201);
    const consents = await pool.query("select granted from identity.consent_record where customer_id = $1 and purpose = 'sms_reminders' order by recorded_at", [withConsent.customerId]);
    expect(consents.rows.map((r) => r.granted)).toEqual([true, false]);
  });

  it('sends an overdue notice once per period when a due date has passed', async () => {
    const c = await customer('0700000504', 'SYN-PM-NTF-0504');
    await app.get(PolicyTracksService).setPremiumSchedule(c.linkId, pwani, { frequency: 'monthly', amountMinor: 200000n, startsOn: periodStart('monthly', today, -1) });
    await notifications.runReminders();
    await notifications.runReminders();
    const inApp = await messages(c.customerId, 'in_app');
    expect(inApp).toHaveLength(1);
    expect(inApp[0]).toMatchObject({ template: 'premium_overdue' });
    expect(inApp[0].body).toMatch(/^AfyaPay: Behind by KES 2,000 on your Pwani Mutual \(fictional\) premium\. \d+ days to the next due date\.$/);
  });

  it('checks preference input and needs sign-in', async () => {
    const c = await customer('0700000505', 'SYN-PM-NTF-0505');
    await http().post('/me/preferences').set('Authorization', `Bearer ${c.token}`).set('Idempotency-Key', key()).send({ language: 'fr' }).expect(422);
    const prefs = await http().get('/me/preferences').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(prefs.body).toMatchObject({ language: 'en', smsReminders: false, consentText: { version: SMS_REMINDERS_CONSENT.version } });
    await http().get('/me/messages').expect(401);
  });
});
