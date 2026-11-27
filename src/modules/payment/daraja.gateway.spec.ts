import { DarajaGateway, darajaPassword, darajaTimestamp } from './daraja.gateway';
import { describeResult, toMsisdn, toWholeShillings } from './mpesa.gateway';
import { SimulatedMpesaGateway } from './simulated.gateway';

// Dummy credentials. Not secrets.
const config = { baseUrl: 'https://sandbox.example', consumerKey: 'dummy-key', consumerSecret: 'dummy-secret', passkey: () => 'dummy-passkey' };

function fakeFetch(responses: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const http = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = Object.keys(responses).find((p) => url.includes(p));
    const body = path ? responses[path] : { errorCode: '404' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }) as typeof fetch;
  return { http, calls };
}

describe('M-Pesa helpers', () => {
  it('formats amounts, phone numbers, timestamps and passwords the way Daraja expects', () => {
    expect(toWholeShillings(150000n)).toBe(1500);
    expect(() => toWholeShillings(150050n)).toThrow('whole shillings');
    expect(toMsisdn('+254700000123')).toBe('254700000123');
    expect(darajaTimestamp(new Date('2027-01-11T21:30:05Z'))).toBe('20270112003005');
    expect(Buffer.from(darajaPassword('174379', 'pk', '20270112003005'), 'base64').toString()).toBe('174379pk20270112003005');
    expect(describeResult(1032).code).toBe('cancelled');
    expect(describeResult(9999).code).toBe('declined');
  });

  it('simulates outcomes from the last digit of a synthetic phone number', () => {
    expect(SimulatedMpesaGateway.outcomeFor('+254700000129')).toBe(1032);
    expect(SimulatedMpesaGateway.outcomeFor('+254700000128')).toBe(1);
    expect(SimulatedMpesaGateway.outcomeFor('+254700000121')).toBe(0);
  });
});

describe('DarajaGateway', () => {
  const oauth = { '/oauth/v1/generate': { access_token: 'tok', expires_in: '3599' } };

  it('sends a paybill STK push to the insurer shortcode and reuses the token', async () => {
    const { http, calls } = fakeFetch({ ...oauth, '/stkpush/v1/processrequest': { ResponseCode: '0', MerchantRequestID: 'm1', CheckoutRequestID: 'ws_1' } });
    const gw = new DarajaGateway(config, http);
    const req = { shortcode: '174379', passkeyRef: 'X', amountMinor: 250000n, phoneE164: '+254700000123', accountReference: 'SYN-PM-HL-100001', description: 'Premium payment', callbackUrl: 'https://cb.example/x' };
    expect(await gw.stkPush(req)).toEqual({ merchantRequestId: 'm1', checkoutRequestId: 'ws_1', responseCode: '0' });
    await gw.stkPush(req);
    expect(calls.filter((c) => c.url.includes('oauth'))).toHaveLength(1);
    const sent = JSON.parse(String(calls[1].init!.body));
    expect(sent).toMatchObject({ BusinessShortCode: '174379', PartyB: '174379', TransactionType: 'CustomerPayBillOnline', Amount: 2500, PhoneNumber: '254700000123', AccountReference: 'SYN-PM-HL-10' });
    expect(sent.TransactionDesc.length).toBeLessThanOrEqual(13);
    expect(calls[1].init!.headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('throws when Daraja refuses the push', async () => {
    const { http } = fakeFetch({ ...oauth, '/stkpush/v1/processrequest': { errorCode: '400.002.02', errorMessage: 'Bad Request' } });
    const gw = new DarajaGateway(config, http);
    await expect(
      gw.stkPush({ shortcode: '174379', passkeyRef: null, amountMinor: 100n, phoneE164: '+254700000123', accountReference: 'A', description: 'B', callbackUrl: 'C' }),
    ).rejects.toThrow('STK push refused: 400.002.02 Bad Request');
  });

  it('reads pending and final answers from the status query', async () => {
    const pending = new DarajaGateway(config, fakeFetch({ ...oauth, '/stkpushquery': { errorCode: '500.001.1001', errorMessage: 'still processing' } }).http);
    expect(await pending.queryStatus('174379', null, 'ws_1')).toEqual({ state: 'pending' });
    const done = new DarajaGateway(config, fakeFetch({ ...oauth, '/stkpushquery': { ResultCode: '1032', ResultDesc: 'Request cancelled by user' } }).http);
    expect(await done.queryStatus('174379', null, 'ws_1')).toEqual({ state: 'final', resultCode: 1032, resultDesc: 'Request cancelled by user' });
  });
});
