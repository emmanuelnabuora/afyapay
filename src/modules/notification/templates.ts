/**
 * Every customer message. English only for now (founder, 26 Nov 2026); a
 * second language needs wording tested with native speakers first (Step 4,
 * J3). Rules: under 160 characters, no health information, the fixed status
 * vocabulary, and never ask for a PIN.
 */

export type TemplateName = 'otp' | 'payment_prompt_sent' | 'payment_confirmed' | 'payment_failed' | 'premium_reminder' | 'premium_overdue';

/** Payment outcomes and sign-in codes go out without marketing consent; reminders need it. */
export const ESSENTIAL: Record<TemplateName, boolean> = {
  otp: true,
  payment_prompt_sent: true,
  payment_confirmed: true,
  payment_failed: true,
  premium_reminder: false,
  premium_overdue: false,
};

type Vars = Record<string, string>;

const TEMPLATES: Record<TemplateName, (v: Vars) => string> = {
  otp: (v) => `AfyaPay code: ${v.code}. Do not share it with anyone, including AfyaPay staff.`,
  payment_prompt_sent: (v) => `AfyaPay: Check your phone for the M-Pesa prompt to pay ${v.amount} to ${v.insurer}. Enter your PIN only on the M-Pesa prompt.`,
  payment_confirmed: (v) => `AfyaPay: ${v.amount} paid to ${v.insurer}. M-Pesa ref ${v.receipt}.`,
  payment_failed: (v) => `AfyaPay: Payment didn't go through: ${v.reason}`,
  premium_reminder: (v) => `AfyaPay: Saved towards your ${v.insurer} premium: ${v.paid} of ${v.premium}. Due ${v.dueDate}.`,
  premium_overdue: (v) => `AfyaPay: Behind by ${v.behind} on your ${v.insurer} premium. ${v.days} days to the next due date.`,
};

/** Why a payment did not go through. Keys match payment failure codes. */
const REASONS: Record<string, string> = {
  cancelled: 'You cancelled the M-Pesa prompt.',
  insufficient_funds: 'Your M-Pesa balance was too low.',
  no_response: 'We could not reach your phone. Try again.',
  wrong_pin: 'The M-Pesa PIN was not accepted.',
  prompt_not_sent: 'We could not send the M-Pesa prompt. Try again.',
  declined: 'M-Pesa did not complete the payment.',
};

export function reason(code: string): string {
  return REASONS[code] ?? REASONS.declined;
}

/** Insurer names are cut so a message stays short. */
export function shortName(name: string): string {
  return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}

export const SMS_MAX = 160;

export function render(name: TemplateName, vars: Vars): string {
  const v = { ...vars, ...(vars.insurer ? { insurer: shortName(vars.insurer) } : {}) };
  return TEMPLATES[name](v);
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];
