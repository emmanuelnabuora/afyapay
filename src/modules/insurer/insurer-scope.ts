import { HttpException, HttpStatus, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';

/**
 * Runs insurer portal work as the restricted `afyapay_portal` database role
 * with the insurer's id set, so row-level security limits every query to that
 * insurer's rows even if application code has a bug. If the role does not
 * exist, the portal refuses requests rather than run without that protection.
 */
@Injectable()
export class InsurerScope implements OnApplicationBootstrap {
  private roleExists = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      "select case when exists (select 1 from pg_roles where rolname = 'afyapay_portal') then pg_has_role(current_user, 'afyapay_portal', 'MEMBER') else false end as ok",
    );
    this.roleExists = rows[0].ok;
  }

  async run<T>(insurerId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    if (!this.roleExists) throw new HttpException({ code: 'portal.unavailable', message: 'The insurer portal is not available on this server.' }, HttpStatus.SERVICE_UNAVAILABLE);
    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      await tx.query('set local role afyapay_portal');
      await tx.query("select set_config('app.insurer_id', $1, true)", [insurerId]);
      const result = await fn(tx);
      await tx.query('commit');
      return result;
    } catch (err) {
      await tx.query('rollback');
      throw err;
    } finally {
      tx.release();
    }
  }
}
