import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { SMS_REMINDERS_CONSENT } from '../identity/consent';
import { isSyntheticNumber } from '../identity/phone';
import { PaymentService } from '../payment/payment.service';
import { OutboxEvent } from '../platform/outbox.service';
import { PolicyTracksService } from '../policy/policy-tracks.service';
import { kes } from '../policy/tracks';
import { SMS_GATEWAY, SmsGateway } from './sms.gateway';
import { ESSENTIAL, reason, render, TemplateName } from './templates';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);

/** No reminders between 21:00 and 08:00 East Africa Time. */
export function afterQuietHours(now: Date): Date {
  const eat = new Date(now.getTime() + 3 * 3600 * 1000);
  const hour = eat.getUTCHours();
  if (hour >= 8 && hour < 21) return now;
  const day = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate() + (hour >= 21 ? 1 : 0), 8 - 3));
  return day;
}

/** Reminder days before a due date, for customers who have not paid in full. */
export const REMINDER_DAYS = [3, 1];

export interface InAppMessage {
  id: string;
  template: string;
  body: string;
  createdAt: Date;
}

/**
 * Turns payment events and premium positions into customer messages. Every
 * message goes to the in-app inbox; SMS follows the rules: payment outcomes
 * always, reminders only with consent and outside quiet hours, and never to a
 * synthetic number.
 */
@Injectable()
export class NotificationService {
  private readonly log = new Logger('Notifications');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SMS_GATEWAY) private readonly sms: SmsGateway,
    private readonly payments: PaymentService,
    private readonly tracks: PolicyTracksService,
  ) {}

  /** Outbox handler. Unknown topics are ignored. */
  async handleEvent(event: OutboxEvent): Promise<void> {
    const templates: Record<string, TemplateName> = {
      'payment.prompt_sent': 'payment_prompt_sent',
      'payment.confirmed': 'payment_confirmed',
      'payment.failed': 'payment_failed',
    };
    const template = templates[event.topic];
    if (!template) return;
    const facts = await this.payments.messageFacts(event.aggregateId);
    if (!facts) return;
    const failureCode = (event.payload.failureCode as string | undefined) ?? facts.failureCode ?? 'declined';
    await this.queue(facts.customerId, template, `event:${event.id}`, {
      amount: kes(facts.amountMinor),
      insurer: facts.insurerName,
      receipt: facts.mpesaReceipt ?? '',
      reason: reason(failureCode),
    });
  }

  /** Reminders and overdue notices for today. Safe to run many times a day. */
  async runReminders(now = new Date()): Promise<number> {
    let queued = 0;
    for (const { customerId, tracks: t } of await this.tracks.allWithPlans(now)) {
      const p = t.premium;
      if (p.state === 'part_paid' && REMINDER_DAYS.includes(p.daysToDueDate)) {
        queued += await this.queue(customerId, 'premium_reminder', `reminder:${t.policyLinkId}:${p.dueDate}:${p.daysToDueDate}`, {
          insurer: t.insurer.name,
          paid: kes(BigInt(p.paidThisPeriodMinor)),
          premium: kes(BigInt(p.premiumMinor)),
          dueDate: p.dueDate,
        }, now);
      } else if (p.state === 'behind_schedule') {
        queued += await this.queue(customerId, 'premium_overdue', `overdue:${t.policyLinkId}:${p.periodStart}`, {
          insurer: t.insurer.name,
          behind: kes(BigInt(p.behindByMinor)),
          days: String(p.daysToDueDate),
        }, now);
      }
    }
    return queued;
  }

  /** Sends SMS messages that are due. Returns how many it handled. */
  async sendDue(limit = 50): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; body: string; phone_e164: string }>(
      `update notification.message m set updated_at = now(), send_after = now() + interval '5 minutes'
        where m.id in (select id from notification.message where channel = 'sms' and status = 'queued' and send_after <= now()
                        order by send_after limit $1 for update skip locked)
       returning m.id, m.body, (select phone_e164 from identity.customer c where c.id = m.customer_id)`,
      [limit],
    );
    for (const m of rows) {
      if (isSyntheticNumber(m.phone_e164)) {
        await this.setStatus(m.id, 'suppressed', 'synthetic number: never sent');
        continue;
      }
      try {
        const res = await this.sms.send(m.phone_e164, m.body);
        await this.pool.query("update notification.message set status = 'sent', provider = $2, provider_message_id = $3, updated_at = now() where id = $1", [m.id, this.sms.name, res.providerMessageId]);
      } catch (err) {
        this.log.warn(`SMS ${m.id} not sent: ${(err as Error).message}`);
        await this.setStatus(m.id, 'failed', (err as Error).message.slice(0, 200));
      }
    }
    return rows.length;
  }

  async inbox(customerId: string): Promise<InAppMessage[]> {
    const { rows } = await this.pool.query(
      "select id, template, body, created_at from notification.message where customer_id = $1 and channel = 'in_app' order by created_at desc limit 100",
      [customerId],
    );
    return rows.map((r) => ({ id: r.id, template: r.template, body: r.body, createdAt: r.created_at }));
  }

  async preferences(customerId: string): Promise<{ smsReminders: boolean; consentText: typeof SMS_REMINDERS_CONSENT }> {
    return { smsReminders: await this.hasReminderConsent(customerId), consentText: SMS_REMINDERS_CONSENT };
  }

  /** Turns SMS reminders on or off. Consent changes are new rows, never edits. */
  async setPreferences(customerId: string, body: { smsReminders?: unknown; consentTextVersion?: unknown }) {
    if (typeof body.smsReminders !== 'boolean') {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'preferences.reminders_invalid', 'smsReminders must be true or false.');
    }
    if (body.smsReminders && body.consentTextVersion !== SMS_REMINDERS_CONSENT.version) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'consent.required', `Accept consent ${SMS_REMINDERS_CONSENT.version} to get SMS reminders.`);
    }
    if (body.smsReminders !== (await this.hasReminderConsent(customerId))) {
      await this.pool.query(
        "insert into identity.consent_record (customer_id, purpose, granted, text_version) values ($1, 'sms_reminders', $2, $3)",
        [customerId, body.smsReminders, SMS_REMINDERS_CONSENT.version],
      );
    }
    return this.preferences(customerId);
  }

  private async hasReminderConsent(customerId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ granted: boolean }>(
      "select granted from identity.consent_record where customer_id = $1 and purpose = 'sms_reminders' order by recorded_at desc, id desc limit 1",
      [customerId],
    );
    return rows[0]?.granted === true;
  }

  /** Queues one message on both channels. Returns 1 if new, 0 if already queued. */
  private async queue(customerId: string, template: TemplateName, dedupeKey: string, vars: Record<string, string>, now = new Date()): Promise<number> {
    const body = render(template, vars);
    const essential = ESSENTIAL[template];

    const inApp = await this.pool.query(
      `insert into notification.message (customer_id, channel, template, body, essential, dedupe_key, status)
       values ($1, 'in_app', $2, $3, $4, $5, 'delivered') on conflict (channel, dedupe_key) do nothing`,
      [customerId, template, body, essential, dedupeKey],
    );
    const allowed = essential || (await this.hasReminderConsent(customerId));
    await this.pool.query(
      `insert into notification.message (customer_id, channel, template, body, essential, dedupe_key, status, send_after, status_reason)
       values ($1, 'sms', $2, $3, $4, $5, $6, $7, $8) on conflict (channel, dedupe_key) do nothing`,
      [customerId, template, body, essential, dedupeKey, allowed ? 'queued' : 'skipped_no_consent', essential ? now : afterQuietHours(now), allowed ? null : 'no SMS reminder consent'],
    );
    return inApp.rowCount ?? 0;
  }

  private async setStatus(id: string, status: string, reasonText: string) {
    await this.pool.query('update notification.message set status = $2, status_reason = $3, updated_at = now() where id = $1', [id, status, reasonText]);
  }
}
