/**
 * Insurer portal API client. Staff tokens last 30 minutes and have no refresh
 * token, so the token sits in sessionStorage: it survives a reload in this tab
 * only, and is gone when the tab closes. A 401 sends the user back to sign in.
 */
const KEY = 'afyapay.insurer';
let token: string | null = read();
let onExpired: () => void = () => undefined;

function read(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const { t, exp } = JSON.parse(raw) as { t: string; exp: number };
    return exp > Date.now() ? t : null;
  } catch {
    return null;
  }
}

export function setToken(t: string, expiresInSeconds: number) {
  token = t;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ t, exp: Date.now() + expiresInSeconds * 1000 }));
  } catch {
    /* storage blocked: signed in until reload */
  }
}

export function clearToken() {
  token = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

export const hasToken = () => token !== null;
export const whenExpired = (fn: () => void) => (onExpired = fn);

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'POST') headers['Idempotency-Key'] = crypto.randomUUID();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/v1${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && token) {
    clearToken();
    onExpired();
  }
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join(' ') : data?.message ?? 'Something went wrong. Try again.';
    throw new ApiError(res.status, data?.code ?? 'error', message);
  }
  return data as T;
}

/** Minor units -> "KES 1,500.50" (exact, for insurer staff). */
export const kes = (minor: string | number) => {
  const n = BigInt(minor);
  const whole = n / 100n;
  const cents = n % 100n;
  return `KES ${whole.toLocaleString('en-KE')}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
};

/** "1,500.50" typed by staff -> minor units as a string, or null if not a valid amount. */
export function toMinor(typed: string): string | null {
  const m = typed.replace(/,/g, '').trim().match(/^(\d{1,10})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return (BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0')).toString();
}

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' }) : '—');
