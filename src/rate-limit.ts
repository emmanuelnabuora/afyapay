import { createHash } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  /** Requests a minute for one signed-in client (one bearer token). */
  perToken: number;
  /** Requests a minute from one IP address without a token. Kept high: mobile carriers put many customers behind one address. */
  perIp: number;
  now?: () => number;
}

export function rateLimitOptionsFromEnv(): RateLimitOptions {
  const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return { perToken: num(process.env.RATE_LIMIT_PER_MINUTE, 120), perIp: num(process.env.RATE_LIMIT_ANON_PER_MINUTE, 600) };
}

/** M-Pesa callbacks come from Safaricom's few addresses and are checked another way; health checks come from the host. */
const EXEMPT = (path: string) => path.startsWith('/v1/hooks/') || path === '/v1/health';

/**
 * A per-client limit on the API, in fixed one-minute windows, held in memory
 * (per instance). A limit of 0 turns that limit off. Over the limit, the API
 * answers 429 with Retry-After. Production should also limit at the edge.
 */
export function applyRateLimit(app: Express, opts: RateLimitOptions = rateLimitOptionsFromEnv()): void {
  const now = opts.now ?? Date.now;
  let window = Math.floor(now() / 60_000);
  let counts = new Map<string, number>();

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/v1/') || EXEMPT(req.path)) return next();
    const current = Math.floor(now() / 60_000);
    if (current !== window) {
      window = current;
      counts = new Map();
    }
    const auth = req.header('authorization') ?? '';
    const [key, limit] = auth.startsWith('Bearer ')
      ? [`t:${createHash('sha256').update(auth.slice(7)).digest('base64url').slice(0, 22)}`, opts.perToken]
      : [`ip:${req.ip ?? ''}`, opts.perIp];
    if (limit <= 0) return next();
    const used = (counts.get(key) ?? 0) + 1;
    counts.set(key, used);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - used)));
    if (used > limit) {
      res.setHeader('Retry-After', String(60 - (Math.floor(now() / 1000) % 60)));
      res.status(429).json({ code: 'rate.limited', message: 'Too many requests. Wait a minute and try again.' });
      return;
    }
    next();
  });
}
