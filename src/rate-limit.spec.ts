import express from 'express';
import request from 'supertest';
import { applyRateLimit } from './rate-limit';

describe('applyRateLimit', () => {
  let t = 0;
  const app = express();
  applyRateLimit(app, { perToken: 3, perIp: 2, now: () => t });
  app.get('/v1/x', (_req, res) => res.json({ ok: true }));
  app.post('/v1/hooks/mpesa/x', (_req, res) => res.json({ ok: true }));
  app.get('/', (_req, res) => res.send('page'));

  beforeEach(() => {
    t += 120_000; // a fresh window for each test
  });

  it('limits each signed-in client separately, then answers 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i++) await request(app).get('/v1/x').set('Authorization', 'Bearer one').expect(200);
    const over = await request(app).get('/v1/x').set('Authorization', 'Bearer one').expect(429);
    expect(over.body.code).toBe('rate.limited');
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    await request(app).get('/v1/x').set('Authorization', 'Bearer two').expect(200);
  });

  it('limits requests without a token by address, and starts again next minute', async () => {
    await request(app).get('/v1/x').expect(200);
    await request(app).get('/v1/x').expect(200);
    await request(app).get('/v1/x').expect(429);
    t += 60_000;
    await request(app).get('/v1/x').expect(200);
  });

  it('never limits M-Pesa callbacks or the web pages', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/v1/hooks/mpesa/x').expect(200);
      await request(app).get('/').expect(200);
    }
  });
});
