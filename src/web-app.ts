import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import { static as serveStatic } from 'express';

const isApi = (req: Request) => req.path === '/v1' || req.path.startsWith('/v1/');

/**
 * Security headers on every response, API and pages alike. API responses are
 * never cached (they can hold personal data) and may not be framed or run as a
 * page. HSTS is sent only over HTTPS (Render terminates TLS in front of us).
 */
export function applySecurityHeaders(app: Express): void {
  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (isApi(req)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    next();
  });
}

/** Where `vite build web` puts the customer app. */
export const WEB_DIST = join(__dirname, '..', 'web', 'dist');

/**
 * Serves the customer web app from the same service and origin as the API,
 * so there is no extra hosting and no cross-origin access. Everything outside
 * /v1 is the app; unknown paths get index.html (the apps use hash routes), and
 * paths under /insurer and /admin get the insurer portal and the staff admin.
 * A strict Content-Security-Policy allows only this origin; fonts are self-hosted.
 */
export function mountWebApp(app: Express, dist = WEB_DIST): boolean {
  if (!existsSync(join(dist, 'index.html'))) return false;
  const headers = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  };
  const isApp = (req: Request) => (req.method === 'GET' || req.method === 'HEAD') && !isApi(req);
  app.use((req: Request, res: Response, next: NextFunction) => (isApp(req) ? headers(req, res, next) : next()));
  // Answer /insurer and /admin ourselves, so the redirect carries the full CSP
  // (the static server's own redirect sets a bare one).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isApp(req) || (req.path !== '/insurer' && req.path !== '/admin')) return next();
    const query = req.originalUrl.slice(req.path.length);
    res.redirect(301, `${req.path}/${query}`);
  });
  app.use(serveStatic(dist, { redirect: false, index: 'index.html', maxAge: '1h', setHeaders: (res, path) => path.endsWith('index.html') && res.setHeader('Cache-Control', 'no-cache') }));
  const under = (req: Request, dir: string) => req.path === `/${dir}` || req.path.startsWith(`/${dir}/`);
  const page = (req: Request) => join(dist, ...(under(req, 'insurer') ? ['insurer'] : under(req, 'admin') ? ['admin'] : []), 'index.html');
  app.use((req: Request, res: Response, next: NextFunction) => (isApp(req) && !/\.[a-z0-9]+$/i.test(req.path) ? res.setHeader('Cache-Control', 'no-cache') && res.sendFile(page(req)) : next()));
  return true;
}
