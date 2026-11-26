/**
 * Runs once before all test files: resets the throwaway test database and
 * applies every migration, so test files can run in parallel against it.
 */
import { Client } from 'pg';
import { migrate } from '../src/database/migrate';

export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set; tests need a throwaway PostgreSQL database');
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query(
    'drop schema if exists identity, insurer, policy, payment, inbox, ledger, reconciliation, platform, governance cascade; drop table if exists public.schema_migration',
  );
  await db.end();
  await migrate(url);
}
