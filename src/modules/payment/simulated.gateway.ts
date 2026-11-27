import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JobQueueService } from '../platform/job-queue.service';
import { MpesaGateway, StkPushRequest, StkPushResponse, StkStatus, toMsisdn, toWholeShillings } from './mpesa.gateway';

export const SIMULATED_CALLBACK_JOB = 'mpesa.simulated_callback';

/**
 * Stands in for M-Pesa before Daraja credentials exist (development, test and
 * staging). It never moves money. It answers like Daraja and sends itself the
 * callback a few seconds later. The outcome depends on the phone's last digit:
 * 9 = customer cancels (1032), 8 = insufficient funds (1), anything else = paid.
 */
@Injectable()
export class SimulatedMpesaGateway implements MpesaGateway {
  constructor(private readonly jobs: JobQueueService) {}

  static outcomeFor(phoneE164: string): number {
    const last = phoneE164.slice(-1);
    return last === '9' ? 1032 : last === '8' ? 1 : 0;
  }

  async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
    const resultCode = SimulatedMpesaGateway.outcomeFor(req.phoneE164);
    const checkoutRequestId = `ws_SIM_${resultCode}_${randomUUID()}`;
    const merchantRequestId = `SIM-${randomUUID().slice(0, 8)}`;
    const items =
      resultCode === 0
        ? [
            { Name: 'Amount', Value: toWholeShillings(req.amountMinor) },
            { Name: 'MpesaReceiptNumber', Value: `SIM${randomBytes(4).toString('hex').toUpperCase().slice(0, 7)}` },
            { Name: 'PhoneNumber', Value: Number(toMsisdn(req.phoneE164)) },
          ]
        : undefined;
    await this.jobs.enqueue(
      SIMULATED_CALLBACK_JOB,
      {
        Body: {
          stkCallback: {
            MerchantRequestID: merchantRequestId,
            CheckoutRequestID: checkoutRequestId,
            ResultCode: resultCode,
            ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Simulated failure',
            ...(items ? { CallbackMetadata: { Item: items } } : {}),
          },
        },
      },
      { runAt: new Date(Date.now() + 3000) },
    );
    return { merchantRequestId, checkoutRequestId, responseCode: '0' };
  }

  async queryStatus(_shortcode: string, _passkeyRef: string | null, checkoutRequestId: string): Promise<StkStatus> {
    const match = /^ws_SIM_(\d+)_/.exec(checkoutRequestId);
    if (!match) throw new Error('Unknown simulated checkout request');
    const resultCode = Number(match[1]);
    return { state: 'final', resultCode, resultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Simulated failure' };
  }
}
