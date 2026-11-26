/**
 * Integration tests against a real PostgreSQL. CI provides one; locally,
 * set TEST_DATABASE_URL to a throwaway database (it is reset by this test).
 */
import { Client } from 'pg';
import { migrate } from '../scripts/migrate';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set; integration tests need a throwaway PostgreSQL database');
}

let db: Client;
let cash: string;
let insurerPayable: string;
let feeIncome: string;
let n = 0;
const key = () => `test-${Date.now()}-${n++}`;

async function postEntry(lines: Array<[string, number]>, book = 'collections') {
  await db.query('begin');
  try {
    const { rows } = await db.query<{ id: string }>(
      'insert into ledger.journal_entry (book, description, idempotency_key) values ($1, $2, $3) returning id',
      [book, 'test entry', key()],
    );
    for (const [account, amount] of lines) {
      await db.query('insert into ledger.journal_line (entry_id, account_id, amount_minor) values ($1, $2, $3)', [
        rows[0].id,
        account,
        amount,
      ]);
    }
    await db.query('commit');
    return rows[0].id;
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}

beforeAll(async () => {
  const reset = new Client({ connectionString: url });
  await reset.connect();
  await reset.query(
    'drop schema if exists identity, insurer, policy, payment, inbox, ledger, reconciliation, platform, governance cascade; drop table if exists public.schema_migration',
  );
  await reset.end();
  await migrate(url);

  db = new Client({ connectionString: url });
  await db.connect();
  const acct = async (book: string, code: string) =>
    (
      await db.query<{ id: string }>(
        'insert into ledger.ledger_account (book, code, name) values ($1, $2, $2) returning id',
        [book, code],
      )
    ).rows[0].id;
  cash = await acct('collections', 'mpesa_received_for_insurer');
  insurerPayable = await acct('collections', 'insurer_premium_collected');
  feeIncome = await acct('revenue', 'insurer_fee_income');
});

afterAll(async () => {
  await db?.end();
});

describe('ledger', () => {
  it('accepts a balanced entry and keeps amounts as exact integers', async () => {
    const id = await postEntry([
      [cash, 3300],
      [insurerPayable, -3300],
    ]);
    const { rows } = await db.query('select sum(amount_minor)::text as s, count(*)::int as c from ledger.journal_line where entry_id = $1', [id]);
    expect(rows[0]).toEqual({ s: '0', c: 2 });
  });

  it('rejects an entry whose lines do not sum to zero', async () => {
    await expect(
      postEntry([
        [cash, 3300],
        [insurerPayable, -3200],
      ]),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects an entry with a single line', async () => {
    await expect(postEntry([[cash, 3300]])).rejects.toThrow(/at least two lines/);
  });

  it('rejects lines from another book', async () => {
    await expect(
      postEntry([
        [cash, 3300],
        [feeIncome, -3300],
      ]),
    ).rejects.toThrow(/another book/);
  });

  it('refuses UPDATE, DELETE and TRUNCATE at the database level', async () => {
    const id = await postEntry([
      [cash, 6600],
      [insurerPayable, -6600],
    ]);
    await expect(db.query('update ledger.journal_line set amount_minor = 1 where entry_id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(db.query('delete from ledger.journal_line where entry_id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(db.query('update ledger.journal_entry set description = $2 where id = $1', [id, 'edited'])).rejects.toThrow(/append-only/);
    await expect(db.query('truncate ledger.journal_line cascade')).rejects.toThrow(/append-only/);
  });

  it('rejects a duplicate idempotency key', async () => {
    await db.query('begin');
    await db.query("insert into ledger.journal_entry (book, description, idempotency_key) values ('collections', 'a', 'dup-key')");
    await expect(
      db.query("insert into ledger.journal_entry (book, description, idempotency_key) values ('collections', 'b', 'dup-key')"),
    ).rejects.toThrow(/duplicate key/);
    await db.query('rollback');
  });
});

describe('audit log', () => {
  it('chains each event to the previous one and cannot be edited', async () => {
    const insert = (action: string) =>
      db.query<{ prev_hash: string | null; hash: string }>(
        `insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id)
         values ('staff_user', 'synthetic-staff-1', $1, 'journal_entry', 'e-1') returning prev_hash, hash`,
        [action],
      );
    const first = (await insert('entry.proposed')).rows[0];
    const second = (await insert('entry.approved')).rows[0];
    expect(second.prev_hash).toBe(first.hash);
    expect(second.hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(db.query("update governance.audit_event set action = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query('delete from governance.audit_event')).rejects.toThrow(/append-only/);
  });
});

describe('ids', () => {
  it('generates time-ordered UUID v7 values', async () => {
    const { rows } = await db.query<{ a: string; b: string }>('select platform.uuid_v7()::text a, pg_sleep(0.002), platform.uuid_v7()::text b');
    expect(rows[0].a[14]).toBe('7');
    expect(rows[0].a < rows[0].b).toBe(true);
  });
});
