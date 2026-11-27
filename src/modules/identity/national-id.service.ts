import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { encryptField, lookupHash, maskNationalId, normaliseNationalId } from '../../common/field-crypto';
import { PG_POOL } from '../../database/database.module';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);

/**
 * A customer's national ID number, stored encrypted. Customers see and staff
 * see it masked; staff see it in full only through an approved unmask
 * request. The number is never logged or written to the audit log.
 */
@Injectable()
export class NationalIdService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(customerId: string, raw: unknown): Promise<{ nationalId: string }> {
    const id = normaliseNationalId(raw);
    if (!id) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'national_id.invalid', 'Enter your national ID number: 7 or 8 digits.');
    const hmac = lookupHash(id, 'national-id');
    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      const taken = await tx.query('select 1 from identity.national_id where id_hmac = $1 and customer_id <> $2', [hmac, customerId]);
      if (taken.rowCount) throw fail(HttpStatus.CONFLICT, 'national_id.unavailable', 'This ID number cannot be added to your account. Contact support.');
      const prior = await tx.query('select 1 from identity.national_id where customer_id = $1', [customerId]);
      await tx.query(
        `insert into identity.national_id (customer_id, id_enc, id_hmac, id_length, last_two) values ($1, $2, $3, $4, $5)
         on conflict (customer_id) do update set id_enc = excluded.id_enc, id_hmac = excluded.id_hmac, id_length = excluded.id_length,
                                                 last_two = excluded.last_two, updated_at = now()`,
        [customerId, encryptField(id), hmac, id.length, id.slice(-2)],
      );
      await tx.query(
        "insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('customer', $1, $2, 'customer', $1)",
        [customerId, prior.rowCount ? 'customer.national_id_changed' : 'customer.national_id_added'],
      );
      await tx.query('commit');
    } catch (err) {
      await tx.query('rollback');
      if ((err as { code?: string }).code === '23505') throw fail(HttpStatus.CONFLICT, 'national_id.unavailable', 'This ID number cannot be added to your account. Contact support.');
      throw err;
    } finally {
      tx.release();
    }
    return { nationalId: maskNationalId(id.slice(-2), id.length) };
  }

  async masked(customerId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ last_two: string; id_length: number }>('select last_two, id_length from identity.national_id where customer_id = $1', [customerId]);
    return rows[0] ? maskNationalId(rows[0].last_two, rows[0].id_length) : null;
  }
}
