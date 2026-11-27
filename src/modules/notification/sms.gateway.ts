import { Injectable } from '@nestjs/common';
import { isSyntheticNumber } from '../identity/phone';

export const SMS_GATEWAY = Symbol('SMS_GATEWAY');

export interface SmsGateway {
  readonly name: string;
  /** Sends one SMS. Returns the provider's message id. */
  send(phoneE164: string, body: string): Promise<{ providerMessageId: string }>;
}

/**
 * Refuses synthetic numbers. Every real provider adapter must call this first,
 * so test records can never reach a real phone.
 */
export function assertRealRecipient(phoneE164: string): void {
  if (isSyntheticNumber(phoneE164)) throw new Error('Refusing to send an SMS to a synthetic number');
}

/**
 * The only gateway before an SMS provider is contracted: it sends nothing.
 * Messages are marked suppressed, so the flow can be tested end to end.
 */
@Injectable()
export class SuppressedSmsGateway implements SmsGateway {
  readonly name = 'suppressed';

  async send(phoneE164: string): Promise<{ providerMessageId: string }> {
    assertRealRecipient(phoneE164);
    throw new Error('No SMS provider is configured before go-live');
  }
}
