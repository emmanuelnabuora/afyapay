import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { PLAN_INTEREST_CONSENT } from '../identity/consent';
import { normaliseCounty } from './counties';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_COMPARE = 3;
const COVER_TYPES = ['health_individual', 'health_family', 'personal_accident'] as const;

/** Shown wherever plans are shown while buying is off. States a fact; claims nothing about licences. */
export const BUYING_OFF_NOTICE =
  'Buying a plan through AfyaPay is not available yet. You can compare plans and ask the insurer to contact you. Registering interest does not give you cover.';

export interface PlanRow {
  id: string;
  insurer_code: string;
  insurer_name: string;
  code: string;
  name: string;
  cover_type: string;
  summary: string;
  min_household: number;
  max_household: number;
  base_monthly_minor: string;
  per_extra_member_minor: string;
  counties: string[];
  inpatient_limit_minor: string | null;
  outpatient_limit_minor: string | null;
  waiting_period_days: number;
  benefits: string[];
  exclusions: string[];
  sponsored: boolean;
  status: string;
  updated_at: Date;
}

export const PLAN_COLUMNS = `p.id, i.code as insurer_code, i.name as insurer_name, p.code, p.name, p.cover_type, p.summary, p.min_household, p.max_household,
  p.base_monthly_minor::text, p.per_extra_member_minor::text, p.counties, p.inpatient_limit_minor::text, p.outpatient_limit_minor::text,
  p.waiting_period_days, p.benefits, p.exclusions, p.sponsored, p.status, p.updated_at`;

/** Monthly premium for a household: the base covers the first person, each extra member adds a fixed amount. */
export function quoteMinor(base: bigint, perExtra: bigint, household: number): bigint {
  return base + perExtra * BigInt(Math.max(household - 1, 0));
}

function int(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function minor(v: unknown): bigint | null {
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

/**
 * The plan catalogue for Journey 7, in sandbox only. Plans come from insurers.
 * Search filters by household size, budget, county and cover type, and ranks
 * by monthly price for that household, then name: nothing else, and never
 * commission. Sponsored plans carry a label but do not move up.
 */
@Injectable()
export class CatalogueService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async status() {
    const { rows } = await this.pool.query<{ allowed: boolean }>('select governance.plan_buying_allowed() as allowed');
    return { buyingAvailable: rows[0].allowed, notice: rows[0].allowed ? null : BUYING_OFF_NOTICE };
  }

  async search(query: Record<string, unknown>) {
    const household = query.householdSize === undefined ? 1 : int(query.householdSize, 1, 12);
    if (household === null) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.household_invalid', 'Household size is a number from 1 to 12.');
    const budget = query.budgetMinor === undefined ? null : minor(query.budgetMinor);
    if (query.budgetMinor !== undefined && (budget === null || budget <= 0n)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.budget_invalid', 'Budget is a whole number of cents per month, such as 150000 for KES 1,500.');
    const county = query.county === undefined ? null : normaliseCounty(query.county);
    if (query.county !== undefined && !county) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.county_invalid', 'Choose one of Kenya’s 47 counties.');
    const coverType = query.coverType === undefined ? null : (COVER_TYPES as readonly unknown[]).includes(query.coverType) ? (query.coverType as string) : undefined;
    if (coverType === undefined) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.cover_type_invalid', `Cover type is one of ${COVER_TYPES.join(', ')}.`);

    const { rows } = await this.pool.query<PlanRow & { quote: string }>(
      `select ${PLAN_COLUMNS}, (p.base_monthly_minor + p.per_extra_member_minor * ($1::int - 1))::text as quote
         from catalogue.plan p join insurer.insurer i on i.id = p.insurer_id
        where p.status = 'active' and $1 between p.min_household and p.max_household
          and ($2::text is null or cardinality(p.counties) = 0 or $2 = any(p.counties))
          and ($3::text is null or p.cover_type = $3)
          and ($4::bigint is null or p.base_monthly_minor + p.per_extra_member_minor * ($1::int - 1) <= $4)
        order by p.base_monthly_minor + p.per_extra_member_minor * ($1::int - 1), p.name, p.id
        limit 50`,
      [household, county, coverType, budget === null ? null : budget.toString()],
    );
    const status = await this.status();
    return {
      filters: { householdSize: household, budgetMinor: budget?.toString() ?? null, county, coverType },
      rankedBy: 'Monthly price for your household, lowest first. Sponsored plans are labelled and are not moved up.',
      buying: status,
      plans: rows.map((r) => this.view(r, household, status.buyingAvailable)),
    };
  }

  async get(id: string, householdSize?: unknown) {
    const household = householdSize === undefined ? 1 : int(householdSize, 1, 12);
    if (household === null) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.household_invalid', 'Household size is a number from 1 to 12.');
    const plan = await this.load(this.pool, id);
    const status = await this.status();
    return { buying: status, plan: this.view(plan, household, status.buyingAvailable) };
  }

  /** Up to three plans side by side, in the order asked for, with the same fields for each. */
  async compare(rawIds: unknown, householdSize?: unknown) {
    const ids = typeof rawIds === 'string' ? [...new Set(rawIds.split(',').map((s) => s.trim()).filter(Boolean))] : [];
    if (ids.length < 2 || ids.length > MAX_COMPARE) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'compare.count', `Compare 2 or ${MAX_COMPARE} plans.`);
    const household = householdSize === undefined ? 1 : int(householdSize, 1, 12);
    if (household === null) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.household_invalid', 'Household size is a number from 1 to 12.');
    const status = await this.status();
    const plans = [];
    for (const id of ids) plans.push(this.view(await this.load(this.pool, id), household, status.buyingAvailable));
    return {
      householdSize: household,
      buying: status,
      plans,
      rows: [
        { label: 'Insurer', values: plans.map((p) => p.insurer.name) },
        { label: 'Monthly price for your household', values: plans.map((p) => (p.quote.available ? p.quote.monthlyMinor : null)) },
        { label: 'Inpatient limit', values: plans.map((p) => p.inpatientLimitMinor) },
        { label: 'Outpatient limit', values: plans.map((p) => p.outpatientLimitMinor) },
        { label: 'Waiting period (days)', values: plans.map((p) => p.waitingPeriodDays) },
        { label: 'Household size', values: plans.map((p) => `${p.household.min} to ${p.household.max}`) },
        { label: 'Counties', values: plans.map((p) => (p.counties.length ? p.counties.join(', ') : 'All counties')) },
        { label: 'Sponsored', values: plans.map((p) => p.sponsored) },
      ],
    };
  }

  consentText(insurerName: string, planName: string) {
    return { version: PLAN_INTEREST_CONSENT.version, text: PLAN_INTEREST_CONSENT.text.replace(/\{insurer\}/g, insurerName).replace(/\{plan\}/g, planName) };
  }

  async interestConsent(planId: string) {
    const p = await this.load(this.pool, planId);
    return this.consentText(p.insurer_name, p.name);
  }

  /** A signed-in customer asks the insurer to contact them. Needs consent to the exact wording; records it. */
  async registerInterest(customerId: string, body: { planId?: unknown; householdSize?: unknown; county?: unknown; consent?: unknown; consentTextVersion?: unknown }) {
    if (body.consent !== true || body.consentTextVersion !== PLAN_INTEREST_CONSENT.version) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'interest.consent_required', 'Agree to share your details with the insurer first.');
    }
    const household = int(body.householdSize ?? 1, 1, 12);
    if (household === null) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.household_invalid', 'Household size is a number from 1 to 12.');
    const county = body.county === undefined || body.county === null ? null : normaliseCounty(body.county);
    if (body.county !== undefined && body.county !== null && !county) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'search.county_invalid', 'Choose one of Kenya’s 47 counties.');
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const tx = await this.pool.connect();
    try {
      await tx.query('begin');
      const p = await this.load(tx, planId);
      if (p.status !== 'active') throw fail(HttpStatus.CONFLICT, 'plan.withdrawn', 'This plan is no longer offered.');
      if (household < p.min_household || household > p.max_household) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'interest.household', `This plan covers households of ${p.min_household} to ${p.max_household}.`);
      if (county && p.counties.length && !p.counties.includes(county)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'interest.county', 'This plan is not offered in that county.');
      const insurerId = (await tx.query<{ insurer_id: string }>('select insurer_id from catalogue.plan where id = $1', [p.id])).rows[0].insurer_id;
      const quote = quoteMinor(BigInt(p.base_monthly_minor), BigInt(p.per_extra_member_minor), household);
      await tx.query("insert into identity.consent_record (customer_id, purpose, insurer_id, granted, text_version) values ($1, 'plan_interest', $2, true, $3)", [customerId, insurerId, PLAN_INTEREST_CONSENT.version]);
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        `insert into catalogue.plan_interest (plan_id, insurer_id, customer_id, household_size, county, quoted_monthly_minor, consent_version)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (plan_id, customer_id) where status <> 'closed' do nothing returning id, created_at`,
        [p.id, insurerId, customerId, household, county, quote.toString(), PLAN_INTEREST_CONSENT.version],
      );
      if (!rows[0]) throw fail(HttpStatus.CONFLICT, 'interest.exists', `You already asked ${p.insurer_name} about this plan. They will contact you.`);
      await tx.query("insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('customer', $1, 'plan.interest_registered', 'plan_interest', $2)", [customerId, rows[0].id]);
      await tx.query('commit');
      return {
        id: rows[0].id,
        plan: { id: p.id, name: p.name, insurer: p.insurer_name },
        householdSize: household,
        county,
        quotedMonthlyMinor: quote.toString(),
        currency: 'KES',
        status: 'new',
        message: `${p.insurer_name} will contact you about ${p.name}. This is not a purchase and does not give you cover.`,
        createdAt: rows[0].created_at,
      };
    } catch (err) {
      await tx.query('rollback');
      throw err;
    } finally {
      tx.release();
    }
  }

  async myInterests(customerId: string) {
    const { rows } = await this.pool.query(
      `select x.id, x.status, x.household_size, x.county, x.quoted_monthly_minor::text, x.created_at, p.id as plan_id, p.name as plan_name, i.name as insurer_name
         from catalogue.plan_interest x join catalogue.plan p on p.id = x.plan_id join insurer.insurer i on i.id = x.insurer_id
        where x.customer_id = $1 order by x.created_at desc`,
      [customerId],
    );
    return rows.map((r) => ({ id: r.id, status: r.status, plan: { id: r.plan_id, name: r.plan_name, insurer: r.insurer_name }, householdSize: r.household_size, county: r.county, quotedMonthlyMinor: r.quoted_monthly_minor, currency: 'KES', createdAt: r.created_at }));
  }

  private async load(db: Pool | PoolClient, id: string): Promise<PlanRow> {
    if (!UUID.test(id)) throw fail(HttpStatus.NOT_FOUND, 'plan.not_found', 'Plan not found.');
    const { rows } = await db.query<PlanRow>(`select ${PLAN_COLUMNS} from catalogue.plan p join insurer.insurer i on i.id = p.insurer_id where p.id = $1`, [id]);
    if (!rows[0] || rows[0].status !== 'active') throw fail(HttpStatus.NOT_FOUND, 'plan.not_found', 'Plan not found.');
    return rows[0];
  }

  view(r: PlanRow, household: number, buyingAvailable: boolean) {
    const fits = household >= r.min_household && household <= r.max_household;
    return {
      id: r.id,
      insurer: { code: r.insurer_code, name: r.insurer_name },
      code: r.code,
      name: r.name,
      coverType: r.cover_type,
      summary: r.summary,
      household: { min: r.min_household, max: r.max_household },
      quote: fits
        ? { available: true, householdSize: household, monthlyMinor: quoteMinor(BigInt(r.base_monthly_minor), BigInt(r.per_extra_member_minor), household).toString(), currency: 'KES' }
        : { available: false, householdSize: household, reason: `Covers households of ${r.min_household} to ${r.max_household}.` },
      counties: r.counties,
      inpatientLimitMinor: r.inpatient_limit_minor,
      outpatientLimitMinor: r.outpatient_limit_minor,
      waitingPeriodDays: r.waiting_period_days,
      benefits: r.benefits,
      exclusions: r.exclusions,
      sponsored: r.sponsored,
      label: r.sponsored ? 'Sponsored' : null,
      buy: { available: buyingAvailable },
      source: `Plan details supplied by ${r.insurer_name}`,
      updatedAt: r.updated_at,
    };
  }
}
