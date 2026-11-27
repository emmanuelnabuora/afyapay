import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

export type Book = 'collections' | 'revenue';

export interface PostingLine {
  accountCode: string;
  accountName: string;
  amountMinor: bigint;
}

export interface Posting {
  book: Book;
  description: string;
  idempotencyKey: string;
  lines: PostingLine[];
}

/**
 * Posts balanced journal entries inside the caller's transaction. The database
 * itself refuses unbalanced, single-line, cross-book and edited entries; this
 * service adds idempotency so the same business event is never posted twice.
 */
@Injectable()
export class LedgerService {
  async post(tx: PoolClient, posting: Posting): Promise<{ entryId: string; created: boolean }> {
    const sum = posting.lines.reduce((s, l) => s + l.amountMinor, 0n);
    if (posting.lines.length < 2 || sum !== 0n) {
      throw new Error(`Posting ${posting.idempotencyKey} must have two or more lines summing to zero`);
    }

    const existing = await tx.query<{ id: string }>('select id from ledger.journal_entry where idempotency_key = $1', [posting.idempotencyKey]);
    if (existing.rows[0]) return { entryId: existing.rows[0].id, created: false };

    const { rows } = await tx.query<{ id: string }>(
      'insert into ledger.journal_entry (book, description, idempotency_key) values ($1, $2, $3) returning id',
      [posting.book, posting.description, posting.idempotencyKey],
    );
    const entryId = rows[0].id;
    for (const line of posting.lines) {
      const account = await tx.query<{ id: string }>(
        `insert into ledger.ledger_account (book, code, name) values ($1, $2, $3)
         on conflict (book, code) do update set name = ledger.ledger_account.name
         returning id`,
        [posting.book, line.accountCode, line.accountName],
      );
      await tx.query('insert into ledger.journal_line (entry_id, account_id, amount_minor) values ($1, $2, $3)', [
        entryId,
        account.rows[0].id,
        line.amountMinor.toString(),
      ]);
    }
    return { entryId, created: true };
  }

  /** Balance of one account, as an exact integer of minor units. */
  async balance(tx: PoolClient, book: Book, accountCode: string): Promise<bigint> {
    const { rows } = await tx.query<{ s: string | null }>(
      `select sum(l.amount_minor)::text as s from ledger.journal_line l
         join ledger.ledger_account a on a.id = l.account_id where a.book = $1 and a.code = $2`,
      [book, accountCode],
    );
    return BigInt(rows[0].s ?? '0');
  }
}
