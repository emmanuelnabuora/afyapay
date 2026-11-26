/**
 * Normalises a Kenyan mobile number to E.164 (+2547XXXXXXXX or +2541XXXXXXXX).
 * Accepts 07.., 01.., 7.., 1.., 2547.., +2547.., with spaces or dashes.
 * Returns null for anything that is not a Kenyan mobile number.
 */
export function normaliseKenyanMobile(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  const match = /^(?:\+?254|0)?([17]\d{8})$/.exec(digits);
  return match ? `+254${match[1]}` : null;
}

/** Synthetic test numbers from the data generator: +254700000xxx. */
export function isSyntheticNumber(e164: string): boolean {
  return /^\+254700000\d{3}$/.test(e164);
}

export function maskPhone(e164: string): string {
  return `***${e164.slice(-3)}`;
}
