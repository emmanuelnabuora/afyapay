import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Time-based one-time codes (RFC 6238: SHA-1, 30 seconds, 6 digits), the
 * format every authenticator app reads. Secrets are stored encrypted with a
 * key from MFA_SECRET_KEY, which lives in the secret store.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_STEP_SECONDS = 30;

export function totpAt(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matched step so the caller can refuse its reuse.
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (totpAt(secretBase32, s) === code) return s;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function mfaKey(): Buffer {
  const raw = process.env.MFA_SECRET_KEY;
  if (!raw || raw.length < 32) throw new Error('MFA_SECRET_KEY must be set to at least 32 characters');
  return createHash('sha256').update(raw).digest();
}
/** The current key, then MFA_SECRET_KEY_PREVIOUS while a rotation is under way. */
function mfaKeys(): Buffer[] {
  const previous = process.env.MFA_SECRET_KEY_PREVIOUS;
  return previous && previous.length >= 32 ? [mfaKey(), createHash('sha256').update(previous).digest()] : [mfaKey()];
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', mfaKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(stored: string): string {
  return decryptSecretWithKeyInfo(stored).plain;
}

/** Decrypts with the current key, or the previous one, and says whether the current key was used. */
export function decryptSecretWithKeyInfo(stored: string): { plain: string; current: boolean } {
  const [v, iv, tag, enc] = stored.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  for (const [i, key] of mfaKeys().entries()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
      return { plain, current: i === 0 };
    } catch {
      // wrong key: try the next one
    }
  }
  throw new Error('Secret could not be decrypted with the current or previous key');
}
