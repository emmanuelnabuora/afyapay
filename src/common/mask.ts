/**
 * Masks personal data and credentials before anything is logged.
 * Two layers: fields are masked by name, and free text is scanned for
 * phone numbers, national ID numbers and bearer tokens.
 */

const SECRET_KEYS = /pass(word)?|secret|token|authorization|api[_-]?key|pin|cvv|cvc|security[_-]?code|card[_-]?number|private[_-]?key/i;
const PERSONAL_KEYS = /phone|msisdn|mobile|national[_-]?id|id[_-]?number|passport|date[_-]?of[_-]?birth|dob|email/i;

// Kenyan mobile numbers: +2547XXXXXXXX, 2541XXXXXXXX, 07XXXXXXXX, 01XXXXXXXX (spaces allowed).
const KENYAN_PHONE = /(?<!\d)(?:\+?254|0)\s?[17]\d{2}\s?\d{3}\s?\d{3}(?!\d)/g;
// Kenyan national ID numbers are 7 or 8 digits; only masked when labelled as an ID.
const LABELLED_ID = /\b(id(?:\s?(?:no|number))?|national\s?id)(\s*[:=#]?\s*)(\d{7,8})\b/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/g;

export const MASK = '[redacted]';

/** Keeps the last 3 digits so support can still tell numbers apart. */
function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '');
  return `***${digits.slice(-3)}`;
}

export function maskText(text: string): string {
  return text
    .replace(BEARER, `$1 ${MASK}`)
    .replace(LABELLED_ID, (_m, label: string, sep: string) => `${label}${sep}${MASK}`)
    .replace(KENYAN_PHONE, maskPhone);
}

export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return MASK;
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: maskText(value.message) };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) out[k] = MASK;
      else if (PERSONAL_KEYS.test(k)) out[k] = typeof v === 'string' && /\d{3}$/.test(v) ? `***${v.replace(/\D/g, '').slice(-3)}` : MASK;
      else out[k] = maskSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}
