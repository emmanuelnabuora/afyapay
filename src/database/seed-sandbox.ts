/**
 * Seeds the fictional sandbox insurers, their simulated M-Pesa paybills and
 * synthetic staff users. Safe to run repeatedly. Refuses to run
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
      // Safaricom's public sandbox shortcode, with the simulated gateway: no money moves.
      await client.query(
        `insert into insurer.collection_account (insurer_id, shortcode, mode)
         select id, '174379', 'simulated' from insurer.insurer where code = $1
         on conflict (insurer_id) where active do nothing`,
        [ins.code],
      );
      // Synthetic staff, one per role. They set up an authenticator on first sign-in.
      const slug = ins.code.toLowerCase();
      for (const role of ['viewer', 'operator', 'approver']) {
        await client.query(
          `insert into insurer.insurer_user (insurer_id, email, display_name, role)
           select id, $2, $3, $4 from insurer.insurer where code = $1
           on conflict (email) do nothing`,
          [ins.code, `${role}.${slug}@sandbox.test`, `Synthetic ${role} (${ins.code})`, role],
        );
      }
      n++;
    }
    await seedStaff(client);
    await seedPlans(client);
    return n;
  } finally {
    await client.end();
  }
}

/**
 * Synthetic AfyaPay staff. The first two super administrators are set up
 * directly (the database allows this only while fewer than two exist); every
 * other role goes through an approval request that the second one approves.
 */
async function seedStaff(client: Client): Promise<void> {
  await client.query('begin');
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('seed-staff'))");
    const ids: Record<string, string> = {};
    for (const [key, name] of [['super-admin-1', 'Synthetic super administrator 1'], ['super-admin-2', 'Synthetic super administrator 2'], ['compliance', 'Synthetic compliance'], ['finance', 'Synthetic finance'], ['support', 'Synthetic support']]) {
      await client.query("insert into governance.staff_user (email, display_name, created_by) values ($1, $2, 'seed') on conflict (email) do nothing", [`${key}@sandbox.test`, name]);
      ids[key] = (await client.query<{ id: string }>('select id from governance.staff_user where email = $1', [`${key}@sandbox.test`])).rows[0].id;
    }
    for (const key of ['super-admin-1', 'super-admin-2']) {
      const has = await client.query<{ has: boolean }>("select governance.has_role($1, 'super_admin') as has", [ids[key]]);
      if (!has.rows[0].has) await client.query("insert into governance.staff_role_event (staff_user_id, role, action) values ($1, 'super_admin', 'grant')", [ids[key]]);
    }
    for (const role of ['compliance', 'finance', 'support']) {
      const has = await client.query<{ has: boolean }>('select governance.has_role($1, $2) as has', [ids[role], role]);
      if (has.rows[0].has) continue;
      const req = await client.query<{ id: string }>(
        "insert into governance.approval_request (kind, payload, reason, proposed_by) values ('role_grant', $1, 'Synthetic sandbox staff', $2) returning id",
        [{ staffUserId: ids[role], role }, ids['super-admin-1']],
      );
      await client.query("update governance.approval_request set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [req.rows[0].id, ids['super-admin-2']]);
      await client.query("insert into governance.staff_role_event (staff_user_id, role, action, approval_request_id) values ($1, $2, 'grant', $3)", [ids[role], role, req.rows[0].id]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

/** Fictional plans for the sandbox catalogue. Figures are made up and for testing only. */
const SANDBOX_PLANS = [
  { insurer: 'PWANI', code: 'PM-IN', name: 'Afya Basic Individual', coverType: 'health_individual', min: 1, max: 1, base: 99_000, extra: 0, counties: [], inpatient: 30_000_000, outpatient: 5_000_000, waiting: 30, sponsored: false,
    summary: 'Fictional sandbox plan: inpatient and outpatient cover for one adult.', benefits: ['Inpatient care', 'Outpatient visits', 'Prescribed medicines'], exclusions: ['Cosmetic treatment'] },
  { insurer: 'PWANI', code: 'PM-HL', name: 'Afya Plus Family', coverType: 'health_family', min: 2, max: 7, base: 132_000, extra: 35_000, counties: [], inpatient: 50_000_000, outpatient: 10_000_000, waiting: 60, sponsored: true,
    summary: 'Fictional sandbox plan: family cover with maternity after the waiting period.', benefits: ['Inpatient care', 'Outpatient visits', 'Maternity', 'Dental check-up'], exclusions: ['Cosmetic treatment', 'Pre-existing conditions in the first year'] },
  { insurer: 'JAMII', code: 'JA-FB', name: 'Familia Basic', coverType: 'health_family', min: 2, max: 6, base: 115_000, extra: 30_000, counties: ['Nairobi', 'Kiambu', 'Machakos', 'Kajiado'], inpatient: 40_000_000, outpatient: 6_000_000, waiting: 30, sponsored: false,
    summary: 'Fictional sandbox plan: family cover at partner facilities around Nairobi.', benefits: ['Inpatient care', 'Outpatient visits', 'Child immunisations'], exclusions: ['Treatment outside partner facilities'] },
  { insurer: 'JAMII', code: 'JA-BD', name: 'Boda Cover', coverType: 'personal_accident', min: 1, max: 1, base: 45_000, extra: 0, counties: [], inpatient: 20_000_000, outpatient: null, waiting: 0, sponsored: false,
    summary: 'Fictional sandbox plan: accident cover for motorbike riders.', benefits: ['Accident hospital care', 'Disability benefit'], exclusions: ['Riding without a licence'] },
];

async function seedPlans(client: Client): Promise<void> {
  for (const p of SANDBOX_PLANS) {
    await client.query(
      `insert into catalogue.plan (insurer_id, code, name, cover_type, summary, min_household, max_household, base_monthly_minor, per_extra_member_minor,
                                   counties, inpatient_limit_minor, outpatient_limit_minor, waiting_period_days, benefits, exclusions, sponsored, updated_by)
       select id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'seed' from insurer.insurer where code = $1
       on conflict (insurer_id, code) do nothing`,
      [p.insurer, p.code, p.name, p.coverType, p.summary, p.min, p.max, p.base, p.extra, p.counties, p.inpatient, p.outpatient, p.waiting, JSON.stringify(p.benefits), JSON.stringify(p.exclusions), p.sponsored],
    );
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
