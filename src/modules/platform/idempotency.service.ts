import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { keyedHash } from '../identity/tokens';

export type IdempotencyStart =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

/**
 * Stable hash of a request body: key order does not change the hash. Keyed
 * (HMAC), because bodies can hold short personal values such as an ID number
 * that a plain hash would let anyone with database access guess back.
 */
export function hashRequest(body: unknown): string {
  return keyedHash(canonicalJson(body ?? null), 'idempotency');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

@Injectable()
export class IdempotencyService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Claims a key, or reports what an earlier request with that key did. */
  async start(scope: string, key: string, requestHash: string): Promise<IdempotencyStart> {
    // An expired key is treated as never used.
    await this.pool.query('delete from platform.idempotency_key where scope = $1 and key = $2 and expires_at < now()', [scope, key]);
    const inserted = await this.pool.query(
      `insert into platform.idempotency_key (scope, key, request_hash) values ($1, $2, $3)
       on conflict (scope, key) do nothing returning key`,
      [scope, key, requestHash],
    );
    if (inserted.rowCount === 1) return { kind: 'new' };

    const { rows } = await this.pool.query<{
      request_hash: string;
      status: string;
      response_status: number | null;
      response_body: unknown;
    }>('select request_hash, status, response_status, response_body from platform.idempotency_key where scope = $1 and key = $2', [
      scope,
      key,
    ]);
    const row = rows[0];
    if (!row) return this.start(scope, key, requestHash); // removed between statements; try again
    if (row.request_hash !== requestHash) return { kind: 'conflict' };
    if (row.status !== 'completed') return { kind: 'in_progress' };
    return { kind: 'replay', status: row.response_status ?? 200, body: row.response_body };
  }

  async complete(scope: string, key: string, status: number, body: unknown): Promise<void> {
    await this.pool.query(
      `update platform.idempotency_key
          set status = 'completed', response_status = $3, response_body = $4, completed_at = now()
        where scope = $1 and key = $2`,
      [scope, key, status, JSON.stringify(body ?? null)],
    );
  }

  /** Frees the key after a failed request so the client can retry with it. */
  async release(scope: string, key: string): Promise<void> {
    await this.pool.query("delete from platform.idempotency_key where scope = $1 and key = $2 and status = 'in_progress'", [scope, key]);
  }
}
