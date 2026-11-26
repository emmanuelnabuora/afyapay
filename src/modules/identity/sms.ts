import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from './phone';

export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsSender {
  sendOtp(phoneE164: string, code: string): Promise<void>;
}

/**
 * The only sender before go-live: it sends nothing and never logs the code.
 * A real provider adapter (E6) replaces it once a provider is contracted, and
 * it must refuse synthetic numbers.
 */
@Injectable()
export class SuppressedSmsSender implements SmsSender {
  private readonly logger = new Logger('Sms');

  async sendOtp(phoneE164: string): Promise<void> {
    this.logger.log(`OTP SMS suppressed (no provider before go-live) for ${maskPhone(phoneE164)}`);
  }
}
