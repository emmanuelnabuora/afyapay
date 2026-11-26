import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';

export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Jobs with the same dedupe key are only ever queued once. */
  dedupeKey?: string;
}

@Injectable()
export class JobQueueService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async enqueue(kind: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into platform.job (kind, payload, run_at, max_attempts, dedupe_key)
       values ($1, $2, coalesce($3, now()), coalesce($4, 5), $5)
       on conflict (dedupe_key) do nothing
       returning id`,
      [kind, JSON.stringify(payload), opts.runAt ?? null, opts.maxAttempts ?? null, opts.dedupeKey ?? null],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Claims up to `limit` ready jobs of the given kinds for `leaseSeconds`.
   * A job whose worker died is claimable again once its lease runs out.
   */
  async claim(kinds: string[], limit = 10, leaseSeconds = 60): Promise<Job[]> {
    const { rows } = await this.pool.query<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }>(
      `update platform.job j
          set status = 'running',
              attempts = j.attempts + 1,
              locked_until = now() + make_interval(secs => $3),
              updated_at = now()
        where j.id in (
          select id from platform.job
           where kind = any($1)
             and run_at <= now()
             and (status = 'queued' or (status = 'running' and locked_until < now()))
           order by run_at
           limit $2
           for update skip locked)
       returning j.id, j.kind, j.payload, j.attempts, j.max_attempts`,
      [kinds, limit, leaseSeconds],
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts }));
  }

  async complete(id: string): Promise<void> {
    await this.pool.query("update platform.job set status = 'done', locked_until = null, last_error = null, updated_at = now() where id = $1", [id]);
  }

  /**
   * Schedules a retry with backoff (30s, 2m, 8m, 32m, capped at 2h), or marks
   * the job dead after its last attempt.
   */
  async fail(id: string, error: string): Promise<'retry' | 'dead'> {
    const { rows } = await this.pool.query<{ status: 'queued' | 'dead' }>(
      `update platform.job
          set status = case when attempts >= max_attempts then 'dead' else 'queued' end,
              run_at = case when attempts >= max_attempts then run_at
                            else now() + make_interval(secs => least(30 * power(4, greatest(attempts - 1, 0)), 7200)) end,
              locked_until = null,
              last_error = $2,
              updated_at = now()
        where id = $1
        returning status`,
      [id, error.slice(0, 1000)],
    );
    return rows[0]?.status === 'dead' ? 'dead' : 'retry';
  }
}
