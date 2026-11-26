/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction,
 * and records it in public.schema_migration. Already-applied files are skipped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export async function migrate(connectionString: string, dir = join(__dirname, '..', 'db', 'migrations')): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'create table if not exists public.schema_migration (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query<{ name: string }>('select name from public.schema_migration')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('begin');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('insert into public.schema_migration (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  migrate(url)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
