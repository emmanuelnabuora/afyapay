import { randomInt } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { resolveEnvironment } from '../../environment';
import { isSyntheticNumber, normaliseKenyanMobile } from './phone';
import { SMS_SENDER, SmsSender } from './sms';
import { keyedHash, newRefreshToken, safeEqualHex, signAccessToken } from './tokens';

export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_PER_HOUR = 5;
export const OTP_MAX_ATTEMPTS = 5;
export const ACCESS_TTL_SECONDS = 900;
export const REFRESH_TTL_DAYS = 30;

/** Before go-live every number is synthetic and the SMS is suppressed, so this fixed code signs in. */
export const PRE_LAUNCH_SYNTHETIC_CODE = '123456';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);

@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
  ) {}

  async requestOtp(rawPhone: unknown): Promise<{ challengeId: string; expiresInSeconds: number }> {
    const phone = typeof rawPhone === 'string' ? normaliseKenyanMobile(rawPhone) : null;
    if (!phone) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'phone.invalid', 'Enter a Kenyan mobile number, for example 0712 345 678.');

    // No real people outside production: before go-live only synthetic numbers can sign in.
    const env = resolveEnvironment();
    if (!isSyntheticNumber(phone)) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'phone.synthetic_only', `Only synthetic test numbers (+254700000xxx) can sign in on ${env}.`);
    }

    const { rows } = await this.pool.query<{ n: number }>(
      "select count(*)::int as n from identity.otp_challenge where phone_e164 = $1 and created_at > now() - interval '1 hour'",
      [phone],
    );
    if (rows[0].n >= OTP_MAX_PER_HOUR) {
      throw fail(HttpStatus.TOO_MANY_REQUESTS, 'otp.rate_limited', 'Too many codes requested for this number. Try again in an hour.');
    }

    const code = isSyntheticNumber(phone) ? PRE_LAUNCH_SYNTHETIC_CODE : String(randomInt(0, 1_000_000)).padStart(6, '0');
    const inserted = await this.pool.query<{ id: string }>(
      `insert into identity.otp_challenge (phone_e164, code_hash, expires_at)
       values ($1, 'pending', now() + make_interval(secs => $2)) returning id`,
      [phone, OTP_TTL_SECONDS],
    );
    const challengeId = inserted.rows[0].id;
    await this.pool.query('update identity.otp_challenge set code_hash = $2 where id = $1', [challengeId, keyedHash(`${challengeId}:${code}`, 'otp')]);
    await this.sms.sendOtp(phone, code);
    return { challengeId, expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verifyOtp(challengeId: unknown, code: unknown): Promise<TokenPair> {
    if (typeof challengeId !== 'string' || !/^[0-9a-f-]{36}$/.test(challengeId) || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      throw fail(HttpStatus.BAD_REQUEST, 'otp.invalid_request', 'Send the challengeId and the 6-digit code.');
    }
    return this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ phone_e164: string; code_hash: string; attempts: number; expired: boolean; consumed: boolean }>(
        `select phone_e164, code_hash, attempts, expires_at < now() as expired, consumed_at is not null as consumed
           from identity.otp_challenge where id = $1 for update`,
        [challengeId],
      );
      const ch = rows[0];
      if (!ch || ch.expired || ch.consumed) {
        throw fail(HttpStatus.BAD_REQUEST, 'otp.expired', 'This code has expired or was already used. Request a new one.');
      }
      if (ch.attempts >= OTP_MAX_ATTEMPTS) {
        throw fail(HttpStatus.TOO_MANY_REQUESTS, 'otp.too_many_attempts', 'Too many wrong codes. Request a new one.');
      }
      if (!safeEqualHex(ch.code_hash, keyedHash(`${challengeId}:${code}`, 'otp'))) {
        await tx.query('update identity.otp_challenge set attempts = attempts + 1 where id = $1', [challengeId]);
        throw new CommitThenThrow(
          fail(HttpStatus.BAD_REQUEST, 'otp.incorrect', `That code is not right. ${OTP_MAX_ATTEMPTS - ch.attempts - 1} tries left.`),
        );
      }
      await tx.query('update identity.otp_challenge set consumed_at = now() where id = $1', [challengeId]);

      const customer = await tx.query<{ id: string; status: string; created: boolean }>(
        `insert into identity.customer (phone_e164) values ($1)
         on conflict (phone_e164) do update set updated_at = now()
         returning id, status, (xmax = 0) as created`,
        [ch.phone_e164],
      );
      const { id: customerId, status, created } = customer.rows[0];
      if (status !== 'active') throw fail(HttpStatus.FORBIDDEN, 'customer.not_active', 'This account cannot sign in. Contact support.');

      await this.audit(tx, customerId, created ? 'customer.signed_up' : 'customer.signed_in');
      return this.issueTokens(tx, customerId, null);
    });
  }

  async refresh(refreshToken: unknown): Promise<TokenPair> {
    if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
      throw fail(HttpStatus.UNAUTHORIZED, 'auth.refresh_invalid', 'Sign in again.');
    }
    return this.inTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; customer_id: string; family_id: string; revoked_reason: string | null; expired: boolean }>(
        `select id, customer_id, family_id, revoked_reason, expires_at < now() as expired
           from identity.session where refresh_token_hash = $1 for update`,
        [keyedHash(refreshToken, 'refresh')],
      );
      const s = rows[0];
      if (!s) throw fail(HttpStatus.UNAUTHORIZED, 'auth.refresh_invalid', 'Sign in again.');
      if (s.revoked_reason === 'rotated') {
        // A token that was already exchanged is being used again: assume theft.
        await tx.query(
          "update identity.session set revoked_at = now(), revoked_reason = 'reuse_detected' where family_id = $1 and revoked_at is null",
          [s.family_id],
        );
        await this.audit(tx, s.customer_id, 'customer.refresh_reuse_detected');
        throw new CommitThenThrow(fail(HttpStatus.UNAUTHORIZED, 'auth.refresh_reused', 'For your safety you have been signed out everywhere. Sign in again.'));
      }
      if (s.revoked_reason || s.expired) throw fail(HttpStatus.UNAUTHORIZED, 'auth.refresh_invalid', 'Sign in again.');
      return this.issueTokens(tx, s.customer_id, s);
    });
  }

  async logout(refreshToken: unknown): Promise<void> {
    if (typeof refreshToken !== 'string') return;
    await this.pool.query(
      `update identity.session set revoked_at = now(), revoked_reason = 'logout'
        where family_id = (select family_id from identity.session where refresh_token_hash = $1) and revoked_at is null`,
      [keyedHash(refreshToken, 'refresh')],
    );
  }

  private async issueTokens(tx: PoolClient, customerId: string, previous: { id: string; family_id: string } | null): Promise<TokenPair> {
    const refreshToken = newRefreshToken();
    const { rows } = await tx.query<{ id: string }>(
      `insert into identity.session (customer_id, family_id, refresh_token_hash, expires_at)
       values ($1, coalesce($2, platform.uuid_v7()), $3, now() + make_interval(days => $4)) returning id`,
      [customerId, previous?.family_id ?? null, keyedHash(refreshToken, 'refresh'), REFRESH_TTL_DAYS],
    );
    const sessionId = rows[0].id;
    if (previous) {
      await tx.query("update identity.session set revoked_at = now(), revoked_reason = 'rotated', replaced_by = $2 where id = $1", [previous.id, sessionId]);
    }
    return {
      accessToken: signAccessToken({ sub: customerId, sid: sessionId, typ: 'customer' }, ACCESS_TTL_SECONDS),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TTL_SECONDS,
    };
  }

  private async audit(tx: PoolClient, customerId: string, action: string): Promise<void> {
    await tx.query(
      `insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id)
       values ('customer', $1, $2, 'customer', $1)`,
      [customerId, action],
    );
  }

  /** Runs fn in a transaction. CommitThenThrow keeps the writes (e.g. a failed attempt) and then raises. */
  private async inTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      const result = await fn(tx);
      await tx.query('commit');
      return result;
    } catch (err) {
      if (err instanceof CommitThenThrow) {
        await tx.query('commit');
        throw err.error;
      }
      await tx.query('rollback');
      throw err;
    } finally {
      tx.release();
    }
  }
}

class CommitThenThrow {
  constructor(readonly error: Error) {}
}
