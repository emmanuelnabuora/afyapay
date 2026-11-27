import { Injectable } from '@nestjs/common';
import { MpesaGateway, StkPushRequest, StkPushResponse, StkStatus, toMsisdn, toWholeShillings } from './mpesa.gateway';

type Fetch = typeof fetch;

export interface DarajaConfig {
  baseUrl: string; // https://sandbox.safaricom.co.ke, or the live URL after gate G4
  consumerKey: string;
  consumerSecret: string;
  /** Resolves a passkey reference to the passkey, from the secret store. */
  passkey: (ref: string | null) => string;
}

/** Daraja timestamps are YYYYMMDDHHmmss in East Africa Time (UTC+3). */
export function darajaTimestamp(now = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 3600 * 1000);
  return eat.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function darajaPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

/**
 * Safaricom Daraja: Lipa na M-Pesa Online (STK push) and its status query.
 * The money goes to the insurer's own shortcode, never to AfyaPay.
 */
@Injectable()
export class DarajaGateway implements MpesaGateway {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: DarajaConfig,
    private readonly http: Fetch = fetch,
  ) {}

  async stkPush(req: StkPushRequest): Promise<StkPushResponse> {
    const timestamp = darajaTimestamp();
    const body = {
      BusinessShortCode: req.shortcode,
      Password: darajaPassword(req.shortcode, this.config.passkey(req.passkeyRef), timestamp),
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: toWholeShillings(req.amountMinor),
      PartyA: toMsisdn(req.phoneE164),
      PartyB: req.shortcode,
      PhoneNumber: toMsisdn(req.phoneE164),
      CallBackURL: req.callbackUrl,
      AccountReference: req.accountReference.slice(0, 12),
      TransactionDesc: req.description.slice(0, 13),
    };
    const res = await this.call('/mpesa/stkpush/v1/processrequest', body);
    if (res.ResponseCode !== '0') {
      throw new Error(`STK push refused: ${res.ResponseCode ?? res.errorCode} ${res.ResponseDescription ?? res.errorMessage ?? ''}`.trim());
    }
    return { merchantRequestId: res.MerchantRequestID, checkoutRequestId: res.CheckoutRequestID, responseCode: res.ResponseCode };
  }

  async queryStatus(shortcode: string, passkeyRef: string | null, checkoutRequestId: string): Promise<StkStatus> {
    const timestamp = darajaTimestamp();
    const res = await this.call('/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: shortcode,
      Password: darajaPassword(shortcode, this.config.passkey(passkeyRef), timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
    // Daraja answers "still being processed" with an error code instead of a result.
    if (res.errorCode === '500.001.1001') return { state: 'pending' };
    if (res.ResultCode === undefined) throw new Error(`STK query failed: ${res.errorCode ?? 'unknown'} ${res.errorMessage ?? ''}`.trim());
    return { state: 'final', resultCode: Number(res.ResultCode), resultDesc: String(res.ResultDesc ?? '') };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.config.consumerKey}:${this.config.consumerSecret}`).toString('base64');
    const res = await this.http(`${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.ok) throw new Error(`Daraja OAuth failed with HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: string };
    this.token = { value: json.access_token, expiresAt: Date.now() + Number(json.expires_in) * 1000 };
    return this.token.value;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(path: string, body: unknown): Promise<any> {
    const res = await this.http(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Daraja returned HTTP ${res.status} with a non-JSON body`);
    }
  }
}
