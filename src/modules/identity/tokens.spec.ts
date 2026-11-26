import { keyedHash, safeEqualHex, signAccessToken, verifyAccessToken } from './tokens';

const secret = 'unit-test-secret-unit-test-secret-000';

describe('access tokens', () => {
  it('round-trips valid claims', () => {
    const token = signAccessToken({ sub: 'c1', sid: 's1', typ: 'customer' }, 900, secret);
    expect(verifyAccessToken(token, secret)).toMatchObject({ sub: 'c1', sid: 's1', typ: 'customer' });
  });

  it('rejects expired, tampered and wrongly signed tokens', () => {
    const token = signAccessToken({ sub: 'c1', sid: 's1', typ: 'customer' }, 900, secret, Date.now() - 1_000_000);
    expect(verifyAccessToken(token, secret)).toBeNull();

    const good = signAccessToken({ sub: 'c1', sid: 's1', typ: 'customer' }, 900, secret);
    const [h, , s] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'c2', sid: 's1', typ: 'customer', iat: 0, exp: 9_999_999_999 })).toString('base64url');
    expect(verifyAccessToken(`${h}.${forged}.${s}`, secret)).toBeNull();
    expect(verifyAccessToken(good, 'another-secret-another-secret-0000000')).toBeNull();
    expect(verifyAccessToken('not.a.token', secret)).toBeNull();
  });

  it('refuses alg none', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'c1', sid: 's', typ: 'customer', iat: 0, exp: 9_999_999_999 })).toString('base64url');
    expect(verifyAccessToken(`${header}.${payload}.`, secret)).toBeNull();
  });
});

describe('keyed hashes', () => {
  it('differ by purpose and compare in constant time', () => {
    const a = keyedHash('123456', 'otp', secret);
    expect(a).not.toBe(keyedHash('123456', 'refresh', secret));
    expect(safeEqualHex(a, keyedHash('123456', 'otp', secret))).toBe(true);
    expect(safeEqualHex(a, keyedHash('654321', 'otp', secret))).toBe(false);
  });
});
