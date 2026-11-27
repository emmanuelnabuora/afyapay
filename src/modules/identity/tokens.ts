import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Small HS256 JWT implementation for short-lived customer access tokens, plus
 * keyed hashing for one-time codes and refresh tokens. The key comes from
 * AUTH_SECRET, which lives in the host's secret store, never in Git.
 */

export interface AccessClaims {
  sub: string; // customer id
  sid: string; // session id
  typ: 'customer';
  iat: number;
  exp: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set to at least 32 characters');
  }
  return secret;
}

export function keyedHash(value: string, purpose: string, secret = authSecret()): string {
  return createHmac('sha256', secret).update(`${purpose}:${value}`).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function signAccessToken(claims: Omit<AccessClaims, 'iat' | 'exp'>, ttlSeconds: number, secret = authSecret(), now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyAccessToken(token: string, secret = authSecret(), now = Date.now()): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (h.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AccessClaims;
    if (claims.typ !== 'customer' || typeof claims.exp !== 'number' || claims.exp <= Math.floor(now / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
