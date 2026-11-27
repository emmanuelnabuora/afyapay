import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { mountWebApp } from './web-app';

describe('mountWebApp', () => {
  const dist = mkdtempSync(join(tmpdir(), 'afyapay-web-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>AfyaPay</title>');
  writeFileSync(join(dist, 'app.js'), 'console.log(1)');
  const app = express();
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
  });

  it('falls back to index.html for app paths and serves assets', async () => {
    expect((await request(app).get('/pay/abc').expect(200)).text).toContain('AfyaPay');
    expect((await request(app).get('/app.js').expect(200)).text).toContain('console.log');
    await request(app).get('/missing.js').expect(404);
  });

  it('leaves the API alone', async () => {
    const res = await request(app).get('/v1/health').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toBeUndefined();
    await request(app).get('/v1/nope').expect(404);
  });
});
