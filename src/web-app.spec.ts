import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { applySecurityHeaders, mountWebApp } from './web-app';

describe('mountWebApp', () => {
  const dist = mkdtempSync(join(tmpdir(), 'afyapay-web-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>AfyaPay</title>');
  writeFileSync(join(dist, 'app.js'), 'console.log(1)');
  mkdirSync(join(dist, 'insurer'));
  writeFileSync(join(dist, 'insurer', 'index.html'), '<!doctype html><title>Insurer portal</title>');
  mkdirSync(join(dist, 'admin'));
  writeFileSync(join(dist, 'admin', 'index.html'), '<!doctype html><title>Staff admin</title>');
  const app = express();
  applySecurityHeaders(app);
  mountWebApp(app, dist);
  app.get('/v1/health', (_req, res) => res.json({ ok: true }));

  it('does nothing when the app has not been built', () => {
    expect(mountWebApp(express(), join(dist, 'missing'))).toBe(false);
  });

  it('serves index.html with a strict content security policy', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('AfyaPay');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('falls back to index.html for app paths and serves assets', async () => {
    expect((await request(app).get('/pay/abc').expect(200)).text).toContain('AfyaPay');
    expect((await request(app).get('/app.js').expect(200)).text).toContain('console.log');
    await request(app).get('/missing.js').expect(404);
  });

  it('serves the insurer portal under /insurer', async () => {
    await request(app).get('/insurer').expect(301);
    const res = await request(app).get('/insurer/').expect(200);
    expect(res.text).toContain('Insurer portal');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await request(app).get('/insurer/requests').expect(200)).text).toContain('Insurer portal');
    expect((await request(app).get('/insurers-page').expect(200)).text).toContain('AfyaPay');
    expect((await request(app).get('/admin/').expect(200)).text).toContain('Staff admin');
    expect((await request(app).get('/admin/gates').expect(200)).text).toContain('Staff admin');
  });

  it('leaves the API alone', async () => {
    const res = await request(app).get('/v1/health').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined(); // plain HTTP here
    await request(app).get('/v1/nope').expect(404);
  });
});
