import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { InsurerClaims } from '../insurer/insurer-auth.service';
import { InsurerScope } from '../insurer/insurer-scope';
import { PLAN_COLUMNS, PlanRow } from './catalogue.service';
import { normaliseCounty } from './counties';

const fail = (status: HttpStatus, code: string, message: string) => new HttpException({ code, message }, status);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COVER_TYPES = ['health_individual', 'health_family', 'personal_accident'];

function minor(v: unknown, name: string, optional = false): string | null {
  if ((v === undefined || v === null) && optional) return null;
  if (typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (name === 'perExtraMemberMinor' && (v === 0 || v === '0' || v === undefined)) return '0';
  throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.amount_invalid', `${name} is a whole number of cents, such as 150000 for KES 1,500.`);
}

function smallInt(v: unknown, name: string, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) return v;
  throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.number_invalid', `${name} is a whole number from ${min} to ${max}.`);
}

function textList(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 30 || !v.every((s) => typeof s === 'string' && s.trim().length >= 2 && s.length <= 200)) {
    throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.list_invalid', `${name} is a list of up to 30 short lines of text.`);
  }
  return v.map((s: string) => s.trim());
}

/**
 * Insurer staff publish and withdraw their own plans in the catalogue, and
 * see the interest customers registered in them. Runs under the portal role,
 * so row-level security keeps each insurer to its own rows.
 */
@Injectable()
export class InsurerPlansService {
  constructor(private readonly scope: InsurerScope) {}

  async upsert(user: InsurerClaims, body: Record<string, unknown>) {
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9-]{2,30}$/.test(code)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.code_invalid', 'Give the plan your own code: 2 to 30 letters, digits or dashes.');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 3 || name.length > 80) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.name_invalid', 'The plan name is 3 to 80 characters.');
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (summary.length < 10 || summary.length > 400) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.summary_invalid', 'The summary is 10 to 400 characters.');
    if (!COVER_TYPES.includes(body.coverType as string)) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.cover_type_invalid', `coverType is one of ${COVER_TYPES.join(', ')}.`);
    const minH = smallInt(body.minHousehold, 'minHousehold', 1, 12, 1);
    const maxH = smallInt(body.maxHousehold, 'maxHousehold', minH, 12, minH);
    const counties = textList(body.counties, 'counties').map((c) => {
      const n = normaliseCounty(c);
      if (!n) throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.county_invalid', `${c} is not one of Kenya’s 47 counties.`);
      return n;
    });
    if (body.sponsored !== undefined && typeof body.sponsored !== 'boolean') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'plan.sponsored_invalid', 'sponsored is true or false.');
    const values = [
      user.ins, code, name, body.coverType, summary, minH, maxH,
      minor(body.baseMonthlyMinor, 'baseMonthlyMinor'), minor(body.perExtraMemberMinor ?? 0, 'perExtraMemberMinor'), [...new Set(counties)],
      minor(body.inpatientLimitMinor, 'inpatientLimitMinor', true), minor(body.outpatientLimitMinor, 'outpatientLimitMinor', true),
      smallInt(body.waitingPeriodDays, 'waitingPeriodDays', 0, 730, 0), JSON.stringify(textList(body.benefits, 'benefits')), JSON.stringify(textList(body.exclusions, 'exclusions')),
      body.sponsored === true, `insurer_user:${user.sub}`,
    ];
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ id: string; created: boolean }>(
        `insert into catalogue.plan (insurer_id, code, name, cover_type, summary, min_household, max_household, base_monthly_minor, per_extra_member_minor,
                                     counties, inpatient_limit_minor, outpatient_limit_minor, waiting_period_days, benefits, exclusions, sponsored, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         on conflict (insurer_id, code) do update set name = excluded.name, cover_type = excluded.cover_type, summary = excluded.summary,
           min_household = excluded.min_household, max_household = excluded.max_household, base_monthly_minor = excluded.base_monthly_minor,
           per_extra_member_minor = excluded.per_extra_member_minor, counties = excluded.counties, inpatient_limit_minor = excluded.inpatient_limit_minor,
           outpatient_limit_minor = excluded.outpatient_limit_minor, waiting_period_days = excluded.waiting_period_days, benefits = excluded.benefits,
           exclusions = excluded.exclusions, sponsored = excluded.sponsored, status = 'active', updated_by = excluded.updated_by, updated_at = now()
         returning id, (xmax = 0) as created`,
        values,
      );
      await this.audit(tx, user, rows[0].created ? 'plan.published' : 'plan.updated', rows[0].id, { code, baseMonthlyMinor: values[7], sponsored: values[15] });
      return { ...(await this.view(tx, rows[0].id)), created: rows[0].created };
    });
  }

  async withdraw(user: InsurerClaims, code: string) {
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ id: string }>("update catalogue.plan set status = 'withdrawn', updated_by = $2, updated_at = now() where code = $1 and status = 'active' returning id", [code.toUpperCase(), `insurer_user:${user.sub}`]);
      if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'plan.not_found', 'No active plan with that code.');
      await this.audit(tx, user, 'plan.withdrawn', rows[0].id, { code });
      return this.view(tx, rows[0].id);
    });
  }

  async list(user: InsurerClaims) {
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ id: string }>('select id from catalogue.plan order by code');
      const out = [];
      for (const r of rows) out.push(await this.view(tx, r.id));
      return out;
    });
  }

  /** Interest customers registered, with the phone number they agreed to share. */
  async interests(user: InsurerClaims, status?: string) {
    const filter = status && ['new', 'contacted', 'closed'].includes(status) ? status : null;
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query(
        `select x.id, x.status, x.household_size, x.county, x.quoted_monthly_minor::text, x.consent_version, x.insurer_note, x.created_at,
                p.code as plan_code, p.name as plan_name, c.phone_e164
           from catalogue.plan_interest x join catalogue.plan p on p.id = x.plan_id join identity.customer c on c.id = x.customer_id
          where $1::text is null or x.status = $1 order by x.created_at desc limit 500`,
        [filter],
      );
      return rows.map((r) => ({
        id: r.id, status: r.status, plan: { code: r.plan_code, name: r.plan_name }, phone: r.phone_e164, householdSize: r.household_size, county: r.county,
        quotedMonthlyMinor: r.quoted_monthly_minor, currency: 'KES', consentVersion: r.consent_version, note: r.insurer_note, createdAt: r.created_at,
      }));
    });
  }

  async updateInterest(user: InsurerClaims, id: string, body: { status?: unknown; note?: unknown }) {
    if (!UUID.test(id)) throw fail(HttpStatus.NOT_FOUND, 'interest.not_found', 'Not found.');
    if (body.status !== 'contacted' && body.status !== 'closed') throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'interest.status_invalid', 'status is contacted or closed.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
    return this.scope.run(user.ins, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "update catalogue.plan_interest set status = $2, insurer_note = coalesce($3, insurer_note), updated_at = now() where id = $1 and status <> 'closed' returning id",
        [id, body.status, note],
      );
      if (!rows[0]) throw fail(HttpStatus.NOT_FOUND, 'interest.not_found', 'Not found, or already closed.');
      await this.audit(tx, user, `plan.interest_${body.status}`, id, null);
      return { id, status: body.status };
    });
  }

  private async view(tx: PoolClient, id: string) {
    const { rows } = await tx.query<PlanRow>(`select ${PLAN_COLUMNS} from catalogue.plan p join insurer.insurer i on i.id = p.insurer_id where p.id = $1`, [id]);
    const r = rows[0];
    return {
      id: r.id, code: r.code, name: r.name, coverType: r.cover_type, summary: r.summary, minHousehold: r.min_household, maxHousehold: r.max_household,
      baseMonthlyMinor: r.base_monthly_minor, perExtraMemberMinor: r.per_extra_member_minor, counties: r.counties, inpatientLimitMinor: r.inpatient_limit_minor,
      outpatientLimitMinor: r.outpatient_limit_minor, waitingPeriodDays: r.waiting_period_days, benefits: r.benefits, exclusions: r.exclusions,
      sponsored: r.sponsored, status: r.status, updatedAt: r.updated_at,
    };
  }

  private async audit(tx: PoolClient, user: InsurerClaims, action: string, subjectId: string, after: unknown) {
    await tx.query("insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id, after_state) values ('insurer_user', $1, $2, 'catalogue_plan', $3, $4)", [user.sub, action, subjectId, after === null ? null : JSON.stringify(after)]);
  }
}
