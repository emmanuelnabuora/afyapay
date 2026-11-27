import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import { static as serveStatic } from 'express';

/** Where `vite build web` puts the customer app. */
export const WEB_DIST = join(__dirname, '..', 'web', 'dist');

/**
 * Serves the customer web app from the same service and origin as the API,
 * so there is no extra hosting and no cross-origin access. Everything outside
 * /v1 is the app; unknown paths get index.html (the apps use hash routes), and
 * paths under /insurer and /admin get the insurer portal and the staff admin.
 * A strict Content-Security-Policy allows only this origin, plus Google Fonts.
 */
export function mountWebApp(app: Express, dist = WEB_DIST): boolean {
  if (!existsSync(join(dist, 'index.html'))) return false;
  const headers = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
  const isApp = (req: Request) => req.method === 'GET' && !req.path.startsWith('/v1/') && req.path !== '/v1';
  app.use((req: Request, res: Response, next: NextFunction) => (isApp(req) ? headers(req, res, next) : next()));
  app.use(serveStatic(dist, { index: 'index.html', maxAge: '1h', setHeaders: (res, path) => path.endsWith('index.html') && res.setHeader('Cache-Control', 'no-cache') }));
  const under = (req: Request, dir: string) => req.path === `/${dir}` || req.path.startsWith(`/${dir}/`);
  const page = (req: Request) => join(dist, ...(under(req, 'insurer') ? ['insurer'] : under(req, 'admin') ? ['admin'] : []), 'index.html');
  app.use((req: Request, res: Response, next: NextFunction) => (isApp(req) && !/\.[a-z0-9]+$/i.test(req.path) ? res.setHeader('Cache-Control', 'no-cache') && res.sendFile(page(req)) : next()));
  return true;
}
