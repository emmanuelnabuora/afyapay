/**
 * The three tracks of a policy and their fixed customer wording (Step 4,
 * decision J3). Money: what M-Pesa did. Premium: how payments compare with the
 * insurer's plan. Cover: only what the insurer says. Never mix their words:
 * "covered" belongs to the cover track alone.
 */

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'annual';

/** Whole KES for customer screens, e.g. 150000n -> "KES 1,500". Rounds up. */
export function kes(minor: bigint): string {
  const whole = (minor + 99n) / 100n;
  return `KES ${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Today's date in East Africa Time as YYYY-MM-DD. */
export function eatDate(now = new Date()): string {
  return new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

const toDays = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const fromDays = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

function addMonths(d: string, months: number): string {
  const [y, m, day] = d.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** Start of period k (k = 0 is the first) for a plan starting on `startsOn`. */
export function periodStart(frequency: Frequency, startsOn: string, k: number): string {
  switch (frequency) {
    case 'daily':
      return fromDays(toDays(startsOn) + k);
    case 'weekly':
      return fromDays(toDays(startsOn) + 7 * k);
    case 'monthly':
      return addMonths(startsOn, k);
    case 'annual':
      return addMonths(startsOn, 12 * k);
  }
}

// ---- Premium track -------------------------------------------------------

export type PremiumState = 'not_started' | 'part_paid' | 'behind_schedule' | 'fully_paid';

export interface PremiumPosition {
  state: PremiumState;
  label: string;
  premiumMinor: string;
  paidThisPeriodMinor: string;
  behindByMinor: string;
  periodStart: string;
  dueDate: string; // last day of the current period
  daysToDueDate: number;
  source: 'insurer_schedule_and_confirmed_payments';
}

/**
 * Compares confirmed payments since the plan started with the plan. Payments
 * count towards the oldest period first, so a missed due date is cleared before
 * the current period fills up. "Behind schedule" means an earlier period's due
 * date passed without the full premium; within the current period the customer
 * is saving towards it. Amounts are exact integers of minor units.
 */
export function premiumPosition(
  plan: { frequency: Frequency; amountMinor: bigint; startsOn: string },
  totalPaidMinor: bigint,
  insurerName: string,
  today: string,
): PremiumPosition {
  if (today < plan.startsOn) {
    return {
      state: 'not_started',
      label: `Your plan with ${insurerName} starts on ${plan.startsOn}.`,
      premiumMinor: plan.amountMinor.toString(),
      paidThisPeriodMinor: '0',
      behindByMinor: '0',
      periodStart: plan.startsOn,
      dueDate: fromDays(toDays(periodStart(plan.frequency, plan.startsOn, 1)) - 1),
      daysToDueDate: toDays(periodStart(plan.frequency, plan.startsOn, 1)) - 1 - toDays(today),
      source: 'insurer_schedule_and_confirmed_payments',
    };
  }

  // Find the current period k: periodStart(k) <= today < periodStart(k + 1).
  let k = 0;
  if (plan.frequency === 'daily') k = toDays(today) - toDays(plan.startsOn);
  else if (plan.frequency === 'weekly') k = Math.floor((toDays(today) - toDays(plan.startsOn)) / 7);
  else {
    while (periodStart(plan.frequency, plan.startsOn, k + 1) <= today) k++;
  }
  const start = periodStart(plan.frequency, plan.startsOn, k);
  const next = periodStart(plan.frequency, plan.startsOn, k + 1);
  const dueDate = fromDays(toDays(next) - 1);
  const daysToDueDate = toDays(dueDate) - toDays(today);

  const premium = plan.amountMinor;
  const dueBeforeThisPeriod = premium * BigInt(k);
  const paidThisPeriod = totalPaidMinor - dueBeforeThisPeriod; // negative = earlier periods not fully paid
  const behindBy = paidThisPeriod < 0n ? -paidThisPeriod : 0n;

  const base = {
    premiumMinor: premium.toString(),
    paidThisPeriodMinor: (paidThisPeriod > 0n ? (paidThisPeriod > premium ? premium : paidThisPeriod) : 0n).toString(),
    periodStart: start,
    dueDate,
    daysToDueDate,
    source: 'insurer_schedule_and_confirmed_payments' as const,
  };

  if (paidThisPeriod >= premium) {
    return { ...base, state: 'fully_paid', label: `Full premium paid to ${insurerName}`, behindByMinor: '0' };
  }
  if (behindBy > 0n) {
    const days = daysToDueDate === 1 ? '1 day' : `${daysToDueDate} days`;
    return { ...base, state: 'behind_schedule', label: `Behind by ${kes(behindBy)}. ${days} to due date.`, behindByMinor: behindBy.toString() };
  }
  return {
    ...base,
    state: 'part_paid',
    label: `Saved towards your premium: ${kes(BigInt(base.paidThisPeriodMinor))} of ${kes(premium)}`,
    behindByMinor: '0',
  };
}

// ---- Cover track ---------------------------------------------------------

export type CoverState = 'not_active' | 'active' | 'stale' | 'lapsed' | 'ended';

export interface CoverEventRow {
  status: 'active' | 'lapsed' | 'ended';
  coveredUntil: string | null;
  effectiveOn: string;
  recordedAt: Date;
}

export interface CoverView {
  state: CoverState;
  label: string;
  coveredUntil: string | null;
  confirmedOn: string | null;
  source: 'insurer' | null;
}

/** An "active" status older than this is shown as last confirmed, not as covered. */
export const COVER_STALE_AFTER_DAYS = 35;

export function coverView(latest: CoverEventRow | null, insurerName: string, today: string): CoverView {
  if (!latest) {
    return { state: 'not_active', label: `Not covered yet. ${insurerName} activates cover.`, coveredUntil: null, confirmedOn: null, source: null };
  }
  const confirmedOn = eatDate(latest.recordedAt);
  const common = { coveredUntil: latest.coveredUntil, confirmedOn, source: 'insurer' as const };
  if (latest.status === 'lapsed') return { ...common, state: 'lapsed', label: `Cover lapsed on ${latest.effectiveOn}, per ${insurerName}` };
  if (latest.status === 'ended') return { ...common, state: 'ended', label: `Cover ended on ${latest.effectiveOn}, per ${insurerName}` };

  const old = toDays(today) - toDays(confirmedOn) > COVER_STALE_AFTER_DAYS;
  const pastEnd = latest.coveredUntil !== null && today > latest.coveredUntil;
  if (old || pastEnd) return { ...common, state: 'stale', label: `Last confirmed by ${insurerName} on ${confirmedOn}` };
  return { ...common, state: 'active', label: `Covered until ${latest.coveredUntil}. Confirmed by ${insurerName} on ${confirmedOn}.` };
}

// ---- Money track ---------------------------------------------------------

export type MoneyState = 'none' | 'payment_pending' | 'payment_succeeded' | 'payment_failed';

export function moneyView(
  last: { status: string; amountMinor: bigint; failureMessage: string | null; at: Date } | null,
  insurerName: string,
): { state: MoneyState; label: string; at: Date | null; source: 'mpesa' | null } {
  if (!last) return { state: 'none', label: 'No payments yet', at: null, source: null };
  switch (last.status) {
    case 'confirmed':
      return { state: 'payment_succeeded', label: `${kes(last.amountMinor)} paid to ${insurerName}`, at: last.at, source: 'mpesa' };
    case 'failed':
    case 'expired':
      return { state: 'payment_failed', label: `Payment didn't go through: ${last.failureMessage ?? 'M-Pesa did not complete the payment.'}`, at: last.at, source: 'mpesa' };
    default: // created, prompt_sent, needs_review: not final yet
      return { state: 'payment_pending', label: 'Waiting for M-Pesa', at: last.at, source: 'mpesa' };
  }
}
