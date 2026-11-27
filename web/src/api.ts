/**
 * Talks to the AfyaPay API on the same origin. Keeps the access token in
 * memory and the refresh token in localStorage, and refreshes once on a 401.
 * Every POST carries a fresh Idempotency-Key.
 */
const REFRESH_KEY = 'afyapay.refresh';
let accessToken: string | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function storedRefresh(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}
function storeRefresh(token: string | null) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* private mode: stay signed in for this tab only */
  }
}

export function setTokens(t: { accessToken: string; refreshToken: string }) {
  accessToken = t.accessToken;
  storeRefresh(t.refreshToken);
}

export function hasSession(): boolean {
  return accessToken !== null || storedRefresh() !== null;
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time: refresh tokens work once, so parallel requests share the same refresh. */
function refresh(): Promise<boolean> {
  refreshing ??= doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = storedRefresh();
  if (!refreshToken) return false;
  const res = await fetch('/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
  if (!res.ok) {
    storeRefresh(null);
    accessToken = null;
    return false;
  }
  setTokens(await res.json());
  return true;
}

export async function signOut() {
  const refreshToken = storedRefresh();
  accessToken = null;
  storeRefresh(null);
  if (refreshToken) await fetch('/v1/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) }).catch(() => undefined);
}

export async function api<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const send = () => {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') headers['Idempotency-Key'] = crypto.randomUUID();
    if (init.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return fetch(`/v1${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  if (init.auth !== false && !accessToken) await refresh();
  let res = await send();
  if (res.status === 401 && init.auth !== false && (await refresh())) res = await send();
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join(' ') : data?.message ?? 'Something went wrong. Try again.';
    throw new ApiError(res.status, data?.code ?? 'error', message);
  }
  return data as T;
}

/** Whole shillings typed by the customer -> minor units. */
export const toMinor = (shillings: number) => Math.round(shillings * 100);
/** Minor units -> "KES 1,500". */
export const kes = (minor: string | number) => `KES ${Math.ceil(Number(minor) / 100).toLocaleString('en-KE')}`;
