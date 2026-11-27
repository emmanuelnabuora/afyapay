import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Encryption for personal data fields such as national ID numbers.
 * AES-256-GCM with a key derived from PII_ENCRYPTION_KEY (held in the secret
 * store, never in Git), and a separate keyed hash so an exact value can be
 * found without decrypting every row.
 */
function rawKey(): string {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) throw new Error('PII_ENCRYPTION_KEY must be set to at least 32 characters');
  return raw;
}
const encKey = () => createHash('sha256').update(`enc:${rawKey()}`).digest();
const lookupKey = () => createHash('sha256').update(`lookup:${rawKey()}`).digest();

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['f1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptField(stored: string): string {
  const [v, iv, tag, enc] = stored.split('.');
  if (v !== 'f1') throw new Error('Unknown field format');
  const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

export function lookupHash(value: string, purpose: string): string {
  return createHmac('sha256', lookupKey()).update(`${purpose}:${value}`).digest('hex');
}

/** Kenyan national ID numbers are 7 or 8 digits. Spaces are ignored. */
export function normaliseNationalId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const v = input.replace(/\s/g, '');
  return /^\d{7,8}$/.test(v) ? v : null;
}

/** "12345678" -> "******78". */
export function maskNationalId(lastTwo: string, length = 8): string {
  return `${'*'.repeat(Math.max(length - 2, 4))}${lastTwo}`;
}
