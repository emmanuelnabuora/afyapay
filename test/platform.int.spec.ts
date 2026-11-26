import { Body, Controller, HttpCode, INestApplication, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { DatabaseModule, PG_POOL } from '../src/database/database.module';
import { SkipIdempotency } from '../src/modules/platform/idempotency.interceptor';
import { JobQueueService } from '../src/modules/platform/job-queue.service';
import { OutboxService } from '../src/modules/platform/outbox.service';
import { PlatformModule } from '../src/modules/platform/platform.module';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let calls = 0;

@Controller('things')
class ThingsController {
  @Post()
  create(@Body() body: { name: string }) {
    calls++;
    return { id: `thing-${calls}`, name: body.name };
  }

  @Post('accepted')
  @HttpCode(202)
  accept() {
    return { ok: true };
  }

  @Post('fails')
  fails() {
    calls++;
    throw new Error('boom');
  }

  @Post('hook')
  @SkipIdempotency()
  hook() {
    return { received: true };
  }
}

@Module({ imports: [DatabaseModule, PlatformModule], controllers: [ThingsController] })
class TestAppModule {}

let app: INestApplication;
let pool: Pool;
let outbox: OutboxService;
let jobs: JobQueueService;
const uniq = () => `k${Date.now()}${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
  outbox = app.get(OutboxService);
  jobs = app.get(JobQueueService);
});

afterAll(async () => {
  await app?.close();
});

describe('Idempotency-Key', () => {
  it('requires the header on POST', async () => {
    await request(app.getHttpServer()).post('/things').send({ name: 'a' }).expect(400);
  });

  it('replays the first response for a retry with the same key and body', async () => {
    const key = uniq();
    const first = await request(app.getHttpServer()).post('/things').set('Idempotency-Key', key).send({ name: 'a' }).expect(201);
    const before = calls;
    const retry = await request(app.getHttpServer()).post('/things').set('Idempotency-Key', key).send({ name: 'a' }).expect(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(calls).toBe(before); // handler did not run twice
  });

  it('treats the same body with keys in a different order as the same request', async () => {
    const key = uniq();
    await request(app.getHttpServer()).post('/things').set('Idempotency-Key', key).send({ name: 'a', x: 1 }).expect(201);
    await request(app.getHttpServer()).post('/things').set('Idempotency-Key', key).send({ x: 1, name: 'a' }).expect(201);
  });

  it('refuses the same key with a different body', async () => {
    const key = uniq();
    await request(app.getHttpServer()).post('/things').set('Idempotency-Key', key).send({ name: 'a' }).expect(201);
    const res = await request(app.getHttpServer()).post('/things').set('Idempotency-Key', key).send({ name: 'b' }).expect(409);
    expect(res.body.code).toBe('request.idempotency_key_reused');
  });

  it('stores the route status code, not a default', async () => {
    const key = uniq();
    await request(app.getHttpServer()).post('/things/accepted').set('Idempotency-Key', key).send({}).expect(202);
    await request(app.getHttpServer()).post('/things/accepted').set('Idempotency-Key', key).send({}).expect(202);
  });

  it('frees the key when the request fails, so the client can retry', async () => {
    const key = uniq();
    await request(app.getHttpServer()).post('/things/fails').set('Idempotency-Key', key).send({}).expect(500);
    const { rowCount } = await pool.query('select 1 from platform.idempotency_key where key = $1', [key]);
    expect(rowCount).toBe(0);
  });

  it('lets webhooks marked @SkipIdempotency through without a key', async () => {
    await request(app.getHttpServer()).post('/things/hook').send({}).expect(201);
  });
});

describe('outbox', () => {
  it('keeps an event only if the business transaction commits', async () => {
    const committed = uniq();
    const rolledBack = uniq();
    for (const [id, outcome] of [
      [committed, 'commit'],
      [rolledBack, 'rollback'],
    ] as const) {
      const tx = await pool.connect();
      await tx.query('begin');
      await outbox.enqueue(tx, { topic: 'payment.confirmed', aggregateType: 'payment_intent', aggregateId: id, payload: { amountMinor: 3300 } });
      await tx.query(outcome);
      tx.release();
    }
    const { rows } = await pool.query('select aggregate_id from platform.outbox_event where aggregate_id = any($1)', [[committed, rolledBack]]);
    expect(rows.map((r) => r.aggregate_id)).toEqual([committed]);
  });

  it('marks events published only when the handler succeeds', async () => {
    const ok = uniq();
    const bad = uniq();
    for (const id of [ok, bad]) {
      const tx = await pool.connect();
      await tx.query('begin');
      await outbox.enqueue(tx, { topic: 'test.relay', aggregateType: 't', aggregateId: id, payload: {} });
      await tx.query('commit');
      tx.release();
    }
    await outbox.relay(async (e) => {
      if (e.aggregateId === bad) throw new Error('downstream unavailable');
    }, 1000);
    const { rows } = await pool.query<{ aggregate_id: string; published: boolean; last_error: string | null }>(
      'select aggregate_id, published_at is not null as published, last_error from platform.outbox_event where aggregate_id = any($1)',
      [[ok, bad]],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.aggregate_id, r]));
    expect(byId[ok].published).toBe(true);
    expect(byId[bad].published).toBe(false);
    expect(byId[bad].last_error).toBe('downstream unavailable');
  });
});

describe('job queue', () => {
  it('never gives the same job to two workers', async () => {
    const kind = `test.${uniq()}`;
    for (let i = 0; i < 20; i++) await jobs.enqueue(kind, { i });
    const [a, b] = await Promise.all([jobs.claim([kind], 15), jobs.claim([kind], 15)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('queues a dedupe key only once', async () => {
    const kind = `test.${uniq()}`;
    const dedupeKey = uniq();
    expect(await jobs.enqueue(kind, {}, { dedupeKey })).not.toBeNull();
    expect(await jobs.enqueue(kind, {}, { dedupeKey })).toBeNull();
  });

  it('retries with backoff and goes dead after the last attempt', async () => {
    const kind = `test.${uniq()}`;
    const id = (await jobs.enqueue(kind, {}, { maxAttempts: 2 }))!;
    await jobs.claim([kind]);
    expect(await jobs.fail(id, 'first failure')).toBe('retry');
    const { rows } = await pool.query<{ wait: number }>("select extract(epoch from run_at - now())::int as wait from platform.job where id = $1", [id]);
    expect(rows[0].wait).toBeGreaterThan(20); // about 30 seconds
    await pool.query('update platform.job set run_at = now() where id = $1', [id]);
    await jobs.claim([kind]);
    expect(await jobs.fail(id, 'second failure')).toBe('dead');
    expect(await jobs.claim([kind])).toHaveLength(0);
  });

  it('lets another worker take a job whose lease ran out', async () => {
    const kind = `test.${uniq()}`;
    await jobs.enqueue(kind, {});
    expect(await jobs.claim([kind], 1, 60)).toHaveLength(1);
    expect(await jobs.claim([kind], 1, 60)).toHaveLength(0);
    await pool.query("update platform.job set locked_until = now() - interval '1 second' where kind = $1", [kind]);
    const again = await jobs.claim([kind], 1, 60);
    expect(again).toHaveLength(1);
    expect(again[0].attempts).toBe(2);
  });
});
