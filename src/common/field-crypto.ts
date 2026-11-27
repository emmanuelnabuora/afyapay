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
/**
 * During a key rotation PII_ENCRYPTION_KEY_PREVIOUS holds the old key, so data
 * written under it still reads until `rotate-keys` has re-encrypted every row
 * (see docs/runbooks/secret-rotation.md). New data always uses the current key.
 */
function rawKeys(): string[] {
  const previous = process.env.PII_ENCRYPTION_KEY_PREVIOUS;
  return previous && previous.length >= 32 ? [rawKey(), previous] : [rawKey()];
}
const encKey = (raw = rawKey()) => createHash('sha256').update(`enc:${raw}`).digest();
const lookupKey = (raw = rawKey()) => createHash('sha256').update(`lookup:${raw}`).digest();

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['f1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

/** Decrypts with the current key, or the previous one during a rotation. */
export function decryptField(stored: string): string {
  const [v, iv, tag, enc] = stored.split('.');
  if (v !== 'f1') throw new Error('Unknown field format');
  for (const raw of rawKeys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', encKey(raw), Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // wrong key: try the next one
    }
  }
  throw new Error('Field could not be decrypted with the current or previous key');
}

/** True when a stored value decrypts with the current key (no re-encryption needed). */
export function isCurrentField(stored: string): boolean {
  const [, iv, tag, enc] = stored.split('.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    decipher.update(Buffer.from(enc, 'base64url'));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}

export function lookupHash(value: string, purpose: string): string {
  return createHmac('sha256', lookupKey()).update(`${purpose}:${value}`).digest('hex');
}

/** The lookup hash under every key in use, for finding rows during a rotation. */
export function lookupHashes(value: string, purpose: string): string[] {
  return rawKeys().map((raw) => createHmac('sha256', lookupKey(raw)).update(`${purpose}:${value}`).digest('hex'));
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
