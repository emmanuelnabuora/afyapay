import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database/database.module';
import { OTP_MAX_ATTEMPTS, PRE_LAUNCH_SYNTHETIC_CODE } from '../src/modules/identity/auth.service';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app: INestApplication;
let pool: Pool;
const http = () => request(app.getHttpServer());

async function signIn(phone: string) {
  const otp = await http().post('/auth/otp').send({ phone }).expect(202);
  const verified = await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200);
  return verified.body as { accessToken: string; refreshToken: string };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  pool = app.get(PG_POOL);
});

afterAll(async () => {
  await app?.close();
});

describe('phone sign-in', () => {
  it('signs up a new synthetic customer and returns tokens that open /me', async () => {
    const tokens = await signIn('0700 000 101');
    expect(tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    const me = await http().get('/me').set('Authorization', `Bearer ${tokens.accessToken}`).expect(200);
    expect(me.body.phone).toBe('***101');

    const audit = await pool.query("select action from governance.audit_event where actor_id = $1", [me.body.id]);
    expect(audit.rows.map((r) => r.action)).toContain('customer.signed_up');
  });

  it('signs the same number back in to the same customer', async () => {
    const a = await signIn('+254700000102');
    const b = await signIn('0700000102');
    const idA = (await http().get('/me').set('Authorization', `Bearer ${a.accessToken}`)).body.id;
    const idB = (await http().get('/me').set('Authorization', `Bearer ${b.accessToken}`)).body.id;
    expect(idA).toBe(idB);
  });

  it('refuses real-looking numbers before go-live, and invalid numbers', async () => {
    const real = await http().post('/auth/otp').send({ phone: '0712345678' }).expect(422);
    expect(real.body.code).toBe('phone.synthetic_only');
    const bad = await http().post('/auth/otp').send({ phone: '12345' }).expect(422);
    expect(bad.body.code).toBe('phone.invalid');
  });

  it('never stores the code in clear', async () => {
    const otp = await http().post('/auth/otp').send({ phone: '0700000103' }).expect(202);
    const { rows } = await pool.query('select code_hash from identity.otp_challenge where id = $1', [otp.body.challengeId]);
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].code_hash).not.toContain(PRE_LAUNCH_SYNTHETIC_CODE);
  });

  it('locks a code after too many wrong attempts, and a used code cannot be reused', async () => {
    const otp = await http().post('/auth/otp').send({ phone: '0700000104' }).expect(202);
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      const res = await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: '000000' }).expect(400);
      expect(res.body.code).toBe('otp.incorrect');
    }
    const locked = await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(429);
    expect(locked.body.code).toBe('otp.too_many_attempts');

    const otp2 = await http().post('/auth/otp').send({ phone: '0700000104' }).expect(202);
    await http().post('/auth/otp/verify').send({ challengeId: otp2.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(200);
    const reused = await http().post('/auth/otp/verify').send({ challengeId: otp2.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(400);
    expect(reused.body.code).toBe('otp.expired');
  });

  it('allows 5 code requests per number per hour', async () => {
    for (let i = 0; i < 5; i++) await http().post('/auth/otp').send({ phone: '0700000105' }).expect(202);
    const res = await http().post('/auth/otp').send({ phone: '0700000105' }).expect(429);
    expect(res.body.code).toBe('otp.rate_limited');
  });

  it('rejects an expired code', async () => {
    const otp = await http().post('/auth/otp').send({ phone: '0700000106' }).expect(202);
    await pool.query("update identity.otp_challenge set expires_at = now() - interval '1 second' where id = $1", [otp.body.challengeId]);
    await http().post('/auth/otp/verify').send({ challengeId: otp.body.challengeId, code: PRE_LAUNCH_SYNTHETIC_CODE }).expect(400);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and signs out everywhere when an old one is reused', async () => {
    const first = await signIn('0700000107');
    const second = (await http().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200)).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const reuse = await http().post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401);
    expect(reuse.body.code).toBe('auth.refresh_reused');
    // The newest token in the family was revoked too.
    await http().post('/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
  });

  it('logout stops refresh', async () => {
    const t = await signIn('0700000108');
    await http().post('/auth/logout').send({ refreshToken: t.refreshToken }).expect(204);
    await http().post('/auth/refresh').send({ refreshToken: t.refreshToken }).expect(401);
  });

  it('protects /me', async () => {
    await http().get('/me').expect(401);
    await http().get('/me').set('Authorization', 'Bearer nonsense').expect(401);
  });

  it('stores refresh tokens only as hashes', async () => {
    const t = await signIn('0700000109');
    const { rowCount } = await pool.query('select 1 from identity.session where refresh_token_hash = $1', [t.refreshToken]);
    expect(rowCount).toBe(0);
  });
});
