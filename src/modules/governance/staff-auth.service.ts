import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { resolveEnvironment } from '../../environment';
import { keyedHash, safeEqualHex, signToken, verifyToken } from '../identity/tokens';
import { SYNTHETIC_STAFF_DOMAIN, PRE_LAUNCH_STAFF_EMAIL_CODE } from '../insurer/insurer-auth.service';
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUrl, verifyTotp } from '../insurer/totp';

export type StaffRole = 'support' | 'finance' | 'compliance' | 'super_admin';
export const STAFF_ROLES: StaffRole[] = ['support', 'finance', 'compliance', 'super_admin'];

export interface StaffClaims {
  sub: string; // staff user id
  typ: 'staff_user';
  iat: number;
  exp: number;
}

interface MfaTicket {
  sub: string;
  typ: 'staff_mfa';
  iat: number;
  exp: number;
}

export const ADMIN_ACCESS_TTL_SECONDS = 15 * 60;
const MFA_TICKET_TTL_SECONDS = 5 * 60;
const CODE_TTL_SECONDS = 600;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const normaliseEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** "::ffff:10.0.0.1" -> "10.0.0.1", so IPv4 addresses match IPv4 allow-list entries. */
export function clientIp(raw: string | undefined): string {
  const ip = (raw ?? '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Checks an address against the staff IP allow-list setting. An empty or
 * unset list allows any address before go-live (development, test, staging);
 * the list is changed only through an approved request.
 */
export async function staffIpAllowed(db: Pool | PoolClient, ip: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select case
              when coalesce(jsonb_array_length(governance.setting('staff_ip_allowlist')), 0) = 0 then true
              when $1 = '' then false
              else exists (select 1 from jsonb_array_elements_text(governance.setting('staff_ip_allowlist')) c where $1::inet <<= c::cidr)
            end as ok`,
    [/^[0-9a-fA-F:.]+$/.test(ip) ? ip : ''],
  );
  return rows[0].ok;
}

/**
 * AfyaPay staff sign in with a one-time email code, then a code from an
 * authenticator app, which is required. Every step checks the IP allow-list.
 * Before go-live only synthetic @sandbox.test addresses can sign in, and no
 * email is sent. No password exists, so none is stored.
 */
@Injectable()
export class StaffAuthService {
  private readonly log = new Logger('StaffAuth');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async requestEmailCode(rawEmail: unknown, ip: string): Promise<{ challengeId: string; expiresInSeconds: number }> {
    await this.checkIp(ip);
    const email = normaliseEmail(rawEmail);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'email.invalid', 'Enter your work email address.');
    if (!email.endsWith(`@${SYNTHETIC_STAFF_DOMAIN}`)) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'email.synthetic_only', `Only synthetic staff addresses (@${SYNTHETIC_STAFF_DOMAIN}) can sign in on ${resolveEnvironment()}.`);
    }
    const recent = await this.pool.query<{ n: number }>("select count(*)::int as n from governance.staff_email_challenge where email = $1 and created_at > now() - interval '1 hour'", [email]);
    if (recent.rows[0].n >= MAX_CODES_PER_HOUR) throw fail(HttpStatus.TOO_MANY_REQUESTS, 'email.rate_limited', 'Too many codes requested. Try again in an hour.');
    const { rows } = await this.pool.query<{ id: string }>(
      "insert into governance.staff_email_challenge (email, code_hash, expires_at) values ($1, 'pending', now() + make_interval(secs => $2)) returning id",
      [email, CODE_TTL_SECONDS],
    );
    const challengeId = rows[0].id;
    await this.pool.query('update governance.staff_email_challenge set code_hash = $2 where id = $1', [challengeId, keyedHash(`${challengeId}:${PRE_LAUNCH_STAFF_EMAIL_CODE}`, 'admin-email')]);
    this.log.log('Staff email code suppressed (no email provider before go-live)');
    return { challengeId, expiresInSeconds: CODE_TTL_SECONDS };
  }

  async verifyEmailCode(challengeId: unknown, code: unknown, ip: string): Promise<{ mfaTicket: string; enrolled: boolean }> {
    await this.checkIp(ip);
    if (typeof challengeId !== 'string' || !/^[0-9a-f-]{36}$/.test(challengeId) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw fail(HttpStatus.BAD_REQUEST, 'email_code.invalid_request', 'Send the challengeId and the 6-digit code.');
    }
    const result = await this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ email: string; code_hash: string; attempts: number; expired: boolean; consumed: boolean }>(
        'select email, code_hash, attempts, expires_at < now() as expired, consumed_at is not null as consumed from governance.staff_email_challenge where id = $1 for update',
        [challengeId],
      );
      const ch = rows[0];
      if (!ch || ch.expired || ch.consumed) return { error: fail(HttpStatus.BAD_REQUEST, 'email_code.expired', 'This code has expired or was already used. Request a new one.') };
      if (ch.attempts >= MAX_ATTEMPTS) return { error: fail(HttpStatus.TOO_MANY_REQUESTS, 'email_code.too_many_attempts', 'Too many wrong codes. Request a new one.') };
      if (!safeEqualHex(ch.code_hash, keyedHash(`${challengeId}:${code}`, 'admin-email'))) {
        await tx.query('update governance.staff_email_challenge set attempts = attempts + 1 where id = $1', [challengeId]);
        return { error: fail(HttpStatus.BAD_REQUEST, 'email_code.incorrect', 'That code is not right.') };
      }
      await tx.query('update governance.staff_email_challenge set consumed_at = now() where id = $1', [challengeId]);
      const user = await tx.query<{ id: string; status: string; enrolled: boolean }>('select id, status, totp_enrolled_at is not null as enrolled from governance.staff_user where email = $1', [ch.email]);
      const u = user.rows[0];
      if (!u || u.status !== 'active') return { error: fail(HttpStatus.FORBIDDEN, 'staff.not_active', 'This account cannot sign in. Ask a super administrator.') };
      return { user: u };
    });
    if ('error' in result) throw result.error;
    return { mfaTicket: signToken({ sub: result.user.id, typ: 'staff_mfa' as const }, MFA_TICKET_TTL_SECONDS), enrolled: result.user.enrolled };
  }

  async startEnrolment(ticket: unknown, ip: string): Promise<{ secret: string; otpauthUrl: string }> {
    await this.checkIp(ip);
    const t = this.ticket(ticket);
    const { rows } = await this.pool.query<{ email: string; enrolled: boolean }>('select email, totp_enrolled_at is not null as enrolled from governance.staff_user where id = $1', [t.sub]);
    if (!rows[0]) throw fail(HttpStatus.UNAUTHORIZED, 'auth.required', 'Sign in again.');
    if (rows[0].enrolled) throw fail(HttpStatus.CONFLICT, 'mfa.already_enrolled', 'An authenticator is already set up. Ask a super administrator to reset it.');
    const secret = newTotpSecret();
    await this.pool.query('update governance.staff_user set totp_secret_enc = $2 where id = $1 and totp_enrolled_at is null', [t.sub, encryptSecret(secret)]);
    return { secret, otpauthUrl: otpauthUrl('AfyaPay admin', rows[0].email, secret) };
  }

  async verifyAuthenticator(ticket: unknown, code: unknown, ip: string): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number }> {
    await this.checkIp(ip);
    const t = this.ticket(ticket);
    if (typeof code !== 'string') throw fail(HttpStatus.BAD_REQUEST, 'mfa.invalid_request', 'Send the 6-digit code from your authenticator app.');
    const result = await this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; status: string; totp_secret_enc: string | null; enrolled: boolean; last_totp_step: string | null }>(
        'select id, status, totp_secret_enc, totp_enrolled_at is not null as enrolled, last_totp_step from governance.staff_user where id = $1 for update',
        [t.sub],
      );
      const u = rows[0];
      if (!u || u.status !== 'active') return { error: fail(HttpStatus.FORBIDDEN, 'staff.not_active', 'This account cannot sign in. Ask a super administrator.') };
      if (!u.totp_secret_enc) return { error: fail(HttpStatus.CONFLICT, 'mfa.not_enrolled', 'Set up an authenticator app first.') };
      const step = verifyTotp(decryptSecret(u.totp_secret_enc), code);
      if (step === null || (u.last_totp_step !== null && step <= Number(u.last_totp_step))) {
        await this.audit(tx, u.id, 'admin.mfa_failed', ip);
        return { error: fail(HttpStatus.UNAUTHORIZED, 'mfa.incorrect', 'That authenticator code is not right, or was already used.') };
      }
      await tx.query('update governance.staff_user set last_totp_step = $2, totp_enrolled_at = coalesce(totp_enrolled_at, now()) where id = $1', [u.id, step]);
      await this.audit(tx, u.id, u.enrolled ? 'admin.signed_in' : 'admin.mfa_enrolled', ip);
      return { user: u };
    });
    if ('error' in result) throw result.error;
    return { accessToken: signToken({ sub: result.user.id, typ: 'staff_user' as const }, ADMIN_ACCESS_TTL_SECONDS), tokenType: 'Bearer', expiresIn: ADMIN_ACCESS_TTL_SECONDS };
  }

  private async checkIp(ip: string) {
    if (!(await staffIpAllowed(this.pool, ip))) throw fail(HttpStatus.FORBIDDEN, 'staff.ip_not_allowed', 'Staff sign-in is not allowed from this network.');
  }

  private ticket(ticket: unknown): MfaTicket {
    const t = typeof ticket === 'string' ? verifyToken<MfaTicket>(ticket, 'staff_mfa') : null;
    if (!t) throw fail(HttpStatus.UNAUTHORIZED, 'auth.required', 'Sign in again.');
    return t;
  }

  private async audit(tx: PoolClient, userId: string, action: string, ip: string) {
    await tx.query(
      "insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id, after_state) values ('staff_user', $1, $2, 'staff_user', $1, $3)",
      [userId, action, JSON.stringify({ ip })],
    );
  }

  private async inTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      const result = await fn(tx);
      await tx.query('commit'); // failed attempts are counted and kept
      return result;
    } catch (err) {
      await tx.query('rollback');
      throw err;
    } finally {
      tx.release();
    }
  }
}

export function verifyStaffToken(token: string): StaffClaims | null {
  return verifyToken<StaffClaims>(token, 'staff_user');
}
