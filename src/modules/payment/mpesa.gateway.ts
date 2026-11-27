/**
 * The M-Pesa adapter. Everything outside this file talks to MpesaGateway, so
 * the provider can change without touching payment logic.
 */

export const MPESA_GATEWAY = Symbol('MPESA_GATEWAY');

export interface StkPushRequest {
  shortcode: string;
  passkeyRef: string | null;
  amountMinor: bigint; // whole shillings only; M-Pesa takes integers
  phoneE164: string;
  accountReference: string; // the policy number, so the insurer can match it
  description: string;
  callbackUrl: string;
}

export interface StkPushResponse {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
}

/** Outcome of an STK status query. `pending` means M-Pesa has no final result yet. */
export type StkStatus = { state: 'pending' } | { state: 'final'; resultCode: number; resultDesc: string };

export interface MpesaGateway {
  stkPush(req: StkPushRequest): Promise<StkPushResponse>;
  queryStatus(shortcode: string, passkeyRef: string | null, checkoutRequestId: string): Promise<StkStatus>;
}

/** Customer-facing meaning of the common M-Pesa result codes. */
export const RESULT_CODES: Record<number, { code: string; message: string }> = {
  0: { code: 'paid', message: 'Payment received by the insurer.' },
  1: { code: 'insufficient_funds', message: 'Your M-Pesa balance was too low.' },
  1032: { code: 'cancelled', message: 'You cancelled the M-Pesa prompt.' },
  1037: { code: 'no_response', message: 'We could not reach your phone. Check it is on and try again.' },
  2001: { code: 'wrong_pin', message: 'The M-Pesa PIN was not accepted.' },
};

export function describeResult(resultCode: number): { code: string; message: string } {
  return RESULT_CODES[resultCode] ?? { code: 'declined', message: 'M-Pesa did not complete the payment.' };
}

export function toWholeShillings(amountMinor: bigint): number {
  if (amountMinor % 100n !== 0n) throw new Error('M-Pesa amounts must be whole shillings');
  return Number(amountMinor / 100n);
}

/** M-Pesa wants 2547XXXXXXXX without the plus sign. */
export function toMsisdn(phoneE164: string): string {
  return phoneE164.replace(/^\+/, '');
}
