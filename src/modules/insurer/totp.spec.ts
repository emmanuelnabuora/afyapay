import { base32Decode, base32Encode, decryptSecret, encryptSecret, totpAt, verifyTotp } from './totp';

describe('TOTP (RFC 6238)', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 SHA-1 test vectors (last 6 digits)', () => {
    expect(rfcSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totpAt(rfcSecret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(rfcSecret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(rfcSecret, Math.floor(20000000000 / 30))).toBe('353130');
  });

  it('accepts one step of clock drift and nothing further', () => {
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step + 2), now)).toBeNull();
    expect(verifyTotp(rfcSecret, 'abcdef', now)).toBeNull();
  });

  it('round-trips base32 and encrypts secrets so the stored value is not the secret', () => {
    const raw = Buffer.from('any bytes here!');
    expect(base32Decode(base32Encode(raw))).toEqual(raw);
    const stored = encryptSecret(rfcSecret);
    expect(stored).not.toContain(rfcSecret);
    expect(decryptSecret(stored)).toBe(rfcSecret);
    const tampered = stored.slice(0, -2) + (stored.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
