/**
 * Reads an insurer statement (CSV, RFC 4180 quoting) into typed lines. Amounts
 * are parsed from text straight to integer cents, never through floats.
 */

export interface Mapping {
  receiptCol: string;
  policyCol: string;
  amountCol: string;
  dateCol: string;
  dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY';
}

export const DEFAULT_MAPPING: Mapping = { receiptCol: 'receipt', policyCol: 'policy_number', amountCol: 'amount', dateCol: 'date', dateFormat: 'YYYY-MM-DD' };

export type ParsedLine =
  | { lineNo: number; ok: true; receipt: string; policyNumber: string; amountMinor: bigint; paidOn: string }
  | { lineNo: number; ok: false; error: string; receipt: string | null };

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** "1,500", "1500.00", "KES 1,500.5" -> 150000n / 150050n cents. Null if not a clean positive amount. */
export function parseAmountToMinor(raw: string): bigint | null {
  const s = raw.trim().replace(/^KES\s*/i, '').replace(/^KSH\s*/i, '');
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = BigInt(m[1].replace(/,/g, ''));
  const cents = m[2] ? BigInt(m[2].padEnd(2, '0')) : 0n;
  const v = whole * 100n + cents;
  return v > 0n ? v : null;
}

export function parseDate(raw: string, format: Mapping['dateFormat']): string | null {
  const s = raw.trim().slice(0, 10);
  let y: number, mo: number, d: number;
  if (format === 'YYYY-MM-DD') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export const normaliseRef = (v: string) => v.trim().toUpperCase().replace(/\s+/g, '');

export function parseStatement(text: string, mapping: Mapping): { lines: ParsedLine[]; missingColumns: string[] } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { lines: [], missingColumns: [] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name.trim().toLowerCase());
  const cols = { receipt: idx(mapping.receiptCol), policy: idx(mapping.policyCol), amount: idx(mapping.amountCol), date: idx(mapping.dateCol) };
  const missingColumns = [
    cols.receipt < 0 ? mapping.receiptCol : null,
    cols.policy < 0 ? mapping.policyCol : null,
    cols.amount < 0 ? mapping.amountCol : null,
    cols.date < 0 ? mapping.dateCol : null,
  ].filter((c): c is string => c !== null);
  if (missingColumns.length) return { lines: [], missingColumns };

  const lines = rows.slice(1).map((r, i): ParsedLine => {
    const lineNo = i + 2; // as the insurer sees it in a spreadsheet, header is line 1
    const receipt = normaliseRef(r[cols.receipt] ?? '');
    const policyNumber = normaliseRef(r[cols.policy] ?? '');
    const amountMinor = parseAmountToMinor(r[cols.amount] ?? '');
    const paidOn = parseDate(r[cols.date] ?? '', mapping.dateFormat);
    if (!/^[A-Z0-9]{6,20}$/.test(receipt)) return { lineNo, ok: false, error: 'M-Pesa receipt is missing or not valid', receipt: receipt || null };
    if (!policyNumber) return { lineNo, ok: false, error: 'Policy number is missing', receipt };
    if (amountMinor === null) return { lineNo, ok: false, error: 'Amount is not a positive number', receipt };
    if (!paidOn) return { lineNo, ok: false, error: `Date is not in ${mapping.dateFormat} format`, receipt };
    return { lineNo, ok: true, receipt, policyNumber, amountMinor, paidOn };
  });
  return { lines, missingColumns: [] };
}
