import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { resolveEnvironment } from '../../environment';
import { keyedHash, safeEqualHex, signToken, verifyToken } from '../identity/tokens';
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUrl, verifyTotp } from './totp';

export type InsurerRole = 'viewer' | 'operator' | 'approver';

export interface InsurerClaims {
  sub: string; // insurer user id
  ins: string; // insurer id
  role: InsurerRole;
  typ: 'insurer_user';
  iat: number;
  exp: number;
}

interface MfaTicket {
  sub: string;
  typ: 'insurer_mfa';
  iat: number;
  exp: number;
}

export const STAFF_ACCESS_TTL_SECONDS = 30 * 60;
const MFA_TICKET_TTL_SECONDS = 5 * 60;
const CODE_TTL_SECONDS = 600;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

/** Before go-live only synthetic staff addresses sign in, with this fixed email code. No email is sent. */
export const SYNTHETIC_STAFF_DOMAIN = 'sandbox.test';
export const PRE_LAUNCH_STAFF_EMAIL_CODE = '246810';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const normaliseEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * Insurer staff sign in with a one-time email code, then a code from an
 * authenticator app, which is required: there is no way in without it. No
 * password exists, so none is stored.
 */
@Injectable()
export class InsurerAuthService {
  private readonly log = new Logger('InsurerAuth');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Step 1. Always answers the same way, so it does not reveal who has an account. */
  async requestEmailCode(rawEmail: unknown): Promise<{ challengeId: string; expiresInSeconds: number }> {
    const email = normaliseEmail(rawEmail);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'email.invalid', 'Enter your work email address.');
    const env = resolveEnvironment();
    if (!email.endsWith(`@${SYNTHETIC_STAFF_DOMAIN}`)) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'email.synthetic_only', `Only synthetic staff addresses (@${SYNTHETIC_STAFF_DOMAIN}) can sign in on ${env}.`);
    }
    const recent = await this.pool.query<{ n: number }>("select count(*)::int as n from insurer.email_challenge where email = $1 and created_at > now() - interval '1 hour'", [email]);
    if (recent.rows[0].n >= MAX_CODES_PER_HOUR) throw fail(HttpStatus.TOO_MANY_REQUESTS, 'email.rate_limited', 'Too many codes requested. Try again in an hour.');

    const { rows } = await this.pool.query<{ id: string }>(
      "insert into insurer.email_challenge (email, code_hash, expires_at) values ($1, 'pending', now() + make_interval(secs => $2)) returning id",
      [email, CODE_TTL_SECONDS],
    );
    const challengeId = rows[0].id;
    await this.pool.query('update insurer.email_challenge set code_hash = $2 where id = $1', [challengeId, keyedHash(`${challengeId}:${PRE_LAUNCH_STAFF_EMAIL_CODE}`, 'staff-email')]);
    this.log.log('Staff email code suppressed (no email provider before go-live)');
    return { challengeId, expiresInSeconds: CODE_TTL_SECONDS };
  }

  /**
   * Step 2. A right email code gives a five-minute ticket for the authenticator
   * step. `enrolled: false` means the user must set up an authenticator first.
   */
  async verifyEmailCode(challengeId: unknown, code: unknown): Promise<{ mfaTicket: string; enrolled: boolean }> {
    if (typeof challengeId !== 'string' || !/^[0-9a-f-]{36}$/.test(challengeId) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw fail(HttpStatus.BAD_REQUEST, 'email_code.invalid_request', 'Send the challengeId and the 6-digit code.');
    }
    const result = await this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ email: string; code_hash: string; attempts: number; expired: boolean; consumed: boolean }>(
        'select email, code_hash, attempts, expires_at < now() as expired, consumed_at is not null as consumed from insurer.email_challenge where id = $1 for update',
        [challengeId],
      );
      const ch = rows[0];
      if (!ch || ch.expired || ch.consumed) return { error: fail(HttpStatus.BAD_REQUEST, 'email_code.expired', 'This code has expired or was already used. Request a new one.') };
      if (ch.attempts >= MAX_ATTEMPTS) return { error: fail(HttpStatus.TOO_MANY_REQUESTS, 'email_code.too_many_attempts', 'Too many wrong codes. Request a new one.') };
      if (!safeEqualHex(ch.code_hash, keyedHash(`${challengeId}:${code}`, 'staff-email'))) {
        await tx.query('update insurer.email_challenge set attempts = attempts + 1 where id = $1', [challengeId]);
        return { error: fail(HttpStatus.BAD_REQUEST, 'email_code.incorrect', 'That code is not right.') };
      }
      await tx.query('update insurer.email_challenge set consumed_at = now() where id = $1', [challengeId]);
      const user = await tx.query<{ id: string; status: string; enrolled: boolean }>(
        'select id, status, totp_enrolled_at is not null as enrolled from insurer.insurer_user where email = $1',
        [ch.email],
      );
      const u = user.rows[0];
      if (!u || u.status !== 'active') return { error: fail(HttpStatus.FORBIDDEN, 'staff.not_active', 'This account cannot sign in. Ask your administrator.') };
      return { user: u };
    });
    if ('error' in result) throw result.error;
    return { mfaTicket: signToken({ sub: result.user.id, typ: 'insurer_mfa' as const }, MFA_TICKET_TTL_SECONDS), enrolled: result.user.enrolled };
  }

  /** Step 2b, first sign-in only: creates the authenticator secret to scan. */
  async startEnrolment(ticket: unknown): Promise<{ secret: string; otpauthUrl: string }> {
    const t = this.ticket(ticket);
    const { rows } = await this.pool.query<{ email: string; enrolled: boolean }>('select email, totp_enrolled_at is not null as enrolled from insurer.insurer_user where id = $1', [t.sub]);
    if (!rows[0]) throw fail(HttpStatus.UNAUTHORIZED, 'auth.required', 'Sign in again.');
    if (rows[0].enrolled) throw fail(HttpStatus.CONFLICT, 'mfa.already_enrolled', 'An authenticator is already set up. Ask your administrator to reset it.');
    const secret = newTotpSecret();
    await this.pool.query('update insurer.insurer_user set totp_secret_enc = $2 where id = $1 and totp_enrolled_at is null', [t.sub, encryptSecret(secret)]);
    return { secret, otpauthUrl: otpauthUrl('AfyaPay insurer portal', rows[0].email, secret) };
  }

  /** Step 3: the authenticator code. Finishes enrolment on first use, then issues the access token. */
  async verifyAuthenticator(ticket: unknown, code: unknown): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number }> {
    const t = this.ticket(ticket);
    if (typeof code !== 'string') throw fail(HttpStatus.BAD_REQUEST, 'mfa.invalid_request', 'Send the 6-digit code from your authenticator app.');
    const result = await this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; insurer_id: string; role: InsurerRole; status: string; totp_secret_enc: string | null; enrolled: boolean; last_totp_step: string | null }>(
        'select id, insurer_id, role, status, totp_secret_enc, totp_enrolled_at is not null as enrolled, last_totp_step from insurer.insurer_user where id = $1 for update',
        [t.sub],
      );
      const u = rows[0];
      if (!u || u.status !== 'active') return { error: fail(HttpStatus.FORBIDDEN, 'staff.not_active', 'This account cannot sign in. Ask your administrator.') };
      if (!u.totp_secret_enc) return { error: fail(HttpStatus.CONFLICT, 'mfa.not_enrolled', 'Set up an authenticator app first.') };
      const step = verifyTotp(decryptSecret(u.totp_secret_enc), code);
      if (step === null || (u.last_totp_step !== null && step <= Number(u.last_totp_step))) {
        await this.audit(tx, u.id, 'staff.mfa_failed');
        return { error: fail(HttpStatus.UNAUTHORIZED, 'mfa.incorrect', 'That authenticator code is not right, or was already used.') };
      }
      await tx.query('update insurer.insurer_user set last_totp_step = $2, totp_enrolled_at = coalesce(totp_enrolled_at, now()) where id = $1', [u.id, step]);
      await this.audit(tx, u.id, u.enrolled ? 'staff.signed_in' : 'staff.mfa_enrolled');
      return { user: u };
    });
    if ('error' in result) throw result.error;
    const u = result.user;
    return {
      accessToken: signToken({ sub: u.id, ins: u.insurer_id, role: u.role, typ: 'insurer_user' as const }, STAFF_ACCESS_TTL_SECONDS),
      tokenType: 'Bearer',
      expiresIn: STAFF_ACCESS_TTL_SECONDS,
    };
  }

  private ticket(ticket: unknown): MfaTicket {
    const t = typeof ticket === 'string' ? verifyToken<MfaTicket>(ticket, 'insurer_mfa') : null;
    if (!t) throw fail(HttpStatus.UNAUTHORIZED, 'auth.required', 'Sign in again.');
    return t;
  }

  private async audit(tx: PoolClient, userId: string, action: string) {
    await tx.query("insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('insurer_user', $1, $2, 'insurer_user', $1)", [userId, action]);
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

export function verifyInsurerToken(token: string): InsurerClaims | null {
  return verifyToken<InsurerClaims>(token, 'insurer_user');
}
