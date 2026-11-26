import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Database } from './database/database.module';
import { HealthController } from './health.controller';

describe('GET /health', () => {
  let app: INestApplication;
  let up = true;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: Database, useValue: { ping: async () => up } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports ok when the database answers', async () => {
    up = true;
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok', database: 'up' });
  });

  it('returns 503 when the database is down', async () => {
    up = false;
    await request(app.getHttpServer()).get('/health').expect(503);
  });
});
