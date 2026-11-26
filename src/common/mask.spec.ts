import { MASK, maskSensitive, maskText } from './mask';

describe('maskText', () => {
  it.each([
    ['+254712345678', '***678'],
    ['254712345678', '***678'],
    ['0712345678', '***678'],
    ['0712 345 678', '***678'],
    ['0110345678', '***678'],
  ])('masks the phone number %s', (input, expected) => {
    expect(maskText(`STK sent to ${input} ok`)).toBe(`STK sent to ${expected} ok`);
  });

  it('masks labelled ID numbers but leaves amounts and policy numbers alone', () => {
    expect(maskText('national id: 12345678, amount 3300, policy PM-HL-204871')).toBe(`national id: ${MASK}, amount 3300, policy PM-HL-204871`);
  });

  it('masks bearer tokens', () => {
    expect(maskText('Authorization: Bearer eyJhbGciOi.abc.def')).toBe(`Authorization: Bearer ${MASK}`);
  });
});

describe('maskSensitive', () => {
  it('masks secrets and personal fields by name, recursively', () => {
    const out = maskSensitive({
      customer: { phone: '+254712345678', nationalId: '12345678', name: 'Synthetic Person' },
      mpesa: { pin: '1234', password: 'x', accessToken: 'abc' },
      amountMinor: 3300,
      notes: ['call 0712345678'],
    });
    expect(out).toEqual({
      customer: { phone: '***678', nationalId: '***678', name: 'Synthetic Person' },
      mpesa: { pin: MASK, password: MASK, accessToken: MASK },
      amountMinor: 3300,
      notes: ['call ***678'],
    });
  });

  it('masks error messages', () => {
    expect(maskSensitive(new Error('failed for 0712345678'))).toEqual({ name: 'Error', message: 'failed for ***678' });
  });
});
