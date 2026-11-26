/**
 * Seeds the fictional sandbox insurers. Safe to run repeatedly. Refuses to run
 * outside development, test and staging.
 */
import { Client } from 'pg';
import { resolveEnvironment } from '../environment';
import { generateSyntheticData } from '../synthetic/generator';

export async function seedSandbox(connectionString: string): Promise<number> {
  resolveEnvironment();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    let n = 0;
    for (const ins of generateSyntheticData({ customers: 0 }).insurers) {
      await client.query(
        `insert into insurer.insurer (code, name, stage) values ($1, $2, 'sandbox')
         on conflict (code) do update set name = excluded.name`,
        [ins.code, ins.name],
      );
      n++;
    }
    return n;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  seedSandbox(url)
    .then((n) => console.log(`Seeded ${n} fictional sandbox insurers`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
