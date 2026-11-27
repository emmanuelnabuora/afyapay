/**
 * Every customer message, in English and Kiswahili. English is the source
 * (Step 4, J3). The Kiswahili is a first draft that must be reviewed and
 * tested with native speakers before launch: KISWAHILI_REVIEWED stays false
 * until then. Rules: under 160 characters, no health information, the fixed
 * status vocabulary, and never ask for a PIN.
 */

export type Language = 'en' | 'sw';
export type TemplateName = 'otp' | 'payment_prompt_sent' | 'payment_confirmed' | 'payment_failed' | 'premium_reminder' | 'premium_overdue';

export const KISWAHILI_REVIEWED = false;

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

const TEMPLATES: Record<TemplateName, Record<Language, (v: Vars) => string>> = {
  otp: {
    en: (v) => `AfyaPay code: ${v.code}. Do not share it with anyone, including AfyaPay staff.`,
    sw: (v) => `Nambari ya AfyaPay: ${v.code}. Usimpe mtu yeyote, hata wafanyakazi wa AfyaPay.`,
  },
  payment_prompt_sent: {
    en: (v) => `AfyaPay: Check your phone for the M-Pesa prompt to pay ${v.amount} to ${v.insurer}. Enter your PIN only on the M-Pesa prompt.`,
    sw: (v) => `AfyaPay: Angalia simu yako kwa ombi la M-Pesa kulipa ${v.amount} kwa ${v.insurer}. Weka PIN kwenye ombi la M-Pesa pekee.`,
  },
  payment_confirmed: {
    en: (v) => `AfyaPay: ${v.amount} paid to ${v.insurer}. M-Pesa ref ${v.receipt}.`,
    sw: (v) => `AfyaPay: ${v.amount} zimelipwa kwa ${v.insurer}. Kumbukumbu ya M-Pesa ${v.receipt}.`,
  },
  payment_failed: {
    en: (v) => `AfyaPay: Payment didn't go through: ${v.reason}`,
    sw: (v) => `AfyaPay: Malipo hayakufanikiwa: ${v.reason}`,
  },
  premium_reminder: {
    en: (v) => `AfyaPay: Saved towards your ${v.insurer} premium: ${v.paid} of ${v.premium}. Due ${v.dueDate}.`,
    sw: (v) => `AfyaPay: Umeweka ${v.paid} kati ya ${v.premium} kwa ada ya ${v.insurer}. Mwisho ${v.dueDate}.`,
  },
  premium_overdue: {
    en: (v) => `AfyaPay: Behind by ${v.behind} on your ${v.insurer} premium. ${v.days} days to the next due date.`,
    sw: (v) => `AfyaPay: Umechelewa ${v.behind} kwa ada ya ${v.insurer}. Siku ${v.days} hadi tarehe ya mwisho ijayo.`,
  },
};

/** Why a payment did not go through, per language. Keys match payment failure codes. */
const REASONS: Record<string, Record<Language, string>> = {
  cancelled: { en: 'You cancelled the M-Pesa prompt.', sw: 'Ulighairi ombi la M-Pesa.' },
  insufficient_funds: { en: 'Your M-Pesa balance was too low.', sw: 'Salio lako la M-Pesa halikutosha.' },
  no_response: { en: 'We could not reach your phone. Try again.', sw: 'Hatukuweza kufikia simu yako. Jaribu tena.' },
  wrong_pin: { en: 'The M-Pesa PIN was not accepted.', sw: 'PIN ya M-Pesa haikukubaliwa.' },
  prompt_not_sent: { en: 'We could not send the M-Pesa prompt. Try again.', sw: 'Hatukuweza kutuma ombi la M-Pesa. Jaribu tena.' },
  declined: { en: 'M-Pesa did not complete the payment.', sw: 'M-Pesa haikukamilisha malipo.' },
};

export function reason(code: string, language: Language): string {
  return (REASONS[code] ?? REASONS.declined)[language];
}

/** Insurer names are cut so a message stays short. */
export function shortName(name: string): string {
  return name.length > 30 ? `${name.slice(0, 29)}…` : name;
}

export const SMS_MAX = 160;

export function render(name: TemplateName, language: Language, vars: Vars): string {
  const v = { ...vars, ...(vars.insurer ? { insurer: shortName(vars.insurer) } : {}) };
  return TEMPLATES[name][language](v);
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];
