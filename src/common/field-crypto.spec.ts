import { decryptField, encryptField, lookupHash, maskNationalId, normaliseNationalId } from './field-crypto';

process.env.PII_ENCRYPTION_KEY = 'test-only-pii-encryption-key-not-real-00';

describe('field crypto', () => {
  it('round-trips, with a fresh IV each time', () => {
    const a = encryptField('31415926');
    expect(a).not.toContain('31415926');
    expect(encryptField('31415926')).not.toBe(a);
    expect(decryptField(a)).toBe('31415926');
  });

  it('refuses a tampered value', () => {
    const [v, iv, tag, enc] = encryptField('31415926').split('.');
    const flipped = Buffer.from(enc, 'base64url');
    flipped[0] ^= 1;
    expect(() => decryptField([v, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('hashes for lookup with a key, per purpose', () => {
    expect(lookupHash('31415926', 'national-id')).toBe(lookupHash('31415926', 'national-id'));
    expect(lookupHash('31415926', 'national-id')).not.toBe(lookupHash('31415926', 'other'));
  });

  it('accepts 7 or 8 digits and masks all but the last two', () => {
    expect(normaliseNationalId(' 1234 567 ')).toBe('1234567');
    expect(normaliseNationalId('123456')).toBeNull();
    expect(normaliseNationalId(12345678)).toBeNull();
    expect(maskNationalId('67', 7)).toBe('*****67');
  });
});
