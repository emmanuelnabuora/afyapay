import { Client } from 'pg';
import { decryptField, encryptField, lookupHash, lookupHashes } from '../src/common/field-crypto';
import { reencrypt } from '../src/database/rotate-keys';
import { decryptSecret, encryptSecret } from '../src/modules/insurer/totp';
import { callbackSecretMatches } from '../src/modules/payment/payment.service';

// Test-only keys. The "old" ones are the standard test keys from test/env.ts.
const OLD_PII = process.env.PII_ENCRYPTION_KEY!;
const OLD_MFA = process.env.MFA_SECRET_KEY!;
const NEW_PII = 'test-only-rotated-pii-key-not-real-00000';
const NEW_MFA = 'test-only-rotated-mfa-key-not-real-00000';

function useKeys(pii: string, mfa: string, previous?: { pii: string; mfa: string }) {
  process.env.PII_ENCRYPTION_KEY = pii;
  process.env.MFA_SECRET_KEY = mfa;
  if (previous) {
    process.env.PII_ENCRYPTION_KEY_PREVIOUS = previous.pii;
    process.env.MFA_SECRET_KEY_PREVIOUS = previous.mfa;
  } else {
    delete process.env.PII_ENCRYPTION_KEY_PREVIOUS;
    delete process.env.MFA_SECRET_KEY_PREVIOUS;
  }
}

describe('key rotation', () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => {
    useKeys(OLD_PII, OLD_MFA);
    await db.end();
  });

  it('reads old values with the previous key, and re-encrypts them under the new one', async () => {
    // Everything runs in a transaction that is rolled back, so other test files never see the new key's rows.
    await db.query('begin');
    try {
      useKeys(OLD_PII, OLD_MFA);
      const phone = `+2541${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      const customer = (await db.query<{ id: string }>('insert into identity.customer (phone_e164) values ($1) returning id', [phone])).rows[0].id;
      await db.query("insert into identity.national_id (customer_id, id_enc, id_hmac, id_length, last_two) values ($1, $2, $3, 8, '26')", [
        customer,
        encryptField('27182826'),
        lookupHash('27182826', 'national-id'),
      ]);
      const email = `rotation${Date.now()}@sandbox.test`;
      const staff = (await db.query<{ id: string }>("insert into governance.staff_user (email, display_name, created_by, totp_secret_enc) values ($1, 'Synthetic rotation staff', 'test', $2) returning id", [email, encryptSecret('JBSWY3DPEHPK3PXP')])).rows[0].id;

      // New key only: old values can no longer be read.
      useKeys(NEW_PII, NEW_MFA);
      const stored = async () => (await db.query<{ id_enc: string; id_hmac: string }>('select id_enc, id_hmac from identity.national_id where customer_id = $1', [customer])).rows[0];
      const storedTotp = async () => (await db.query<{ totp_secret_enc: string }>('select totp_secret_enc from governance.staff_user where id = $1', [staff])).rows[0].totp_secret_enc;
      const before = await stored();
      expect(() => decryptField(before.id_enc)).toThrow();
      const beforeTotp = await storedTotp();
      expect(() => decryptSecret(beforeTotp)).toThrow();

      // New key plus the previous one: old values read, and lookups find them under either hash.
      useKeys(NEW_PII, NEW_MFA, { pii: OLD_PII, mfa: OLD_MFA });
      expect(decryptField((await stored()).id_enc)).toBe('27182826');
      expect(decryptSecret(await storedTotp())).toBe('JBSWY3DPEHPK3PXP');
      expect(lookupHashes('27182826', 'national-id')).toContain((await stored()).id_hmac);

      const dry = await reencrypt(db, false);
      expect(dry.applied).toBe(false);
      expect(dry.nationalIds.reencrypted).toBeGreaterThanOrEqual(1);
      expect(dry.staffAuthenticators.reencrypted).toBeGreaterThanOrEqual(1);
      expect(decryptField((await stored()).id_enc)).toBe('27182826'); // dry run changed nothing

      await reencrypt(db, true);
      expect((await reencrypt(db, false)).nationalIds.reencrypted).toBe(0);

      // Previous key gone: everything still reads, and the lookup hash is the new key's.
      useKeys(NEW_PII, NEW_MFA);
      expect(decryptField((await stored()).id_enc)).toBe('27182826');
      expect((await stored()).id_hmac).toBe(lookupHash('27182826', 'national-id'));
      expect(decryptSecret(await storedTotp())).toBe('JBSWY3DPEHPK3PXP');
      const audit = await db.query("select 1 from governance.audit_event where action = 'security.keys_reencrypted'");
      expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    } finally {
      await db.query('rollback');
      useKeys(OLD_PII, OLD_MFA);
    }
  });

  it('accepts the previous M-Pesa callback secret during a rotation', () => {
    const current = process.env.MPESA_CALLBACK_SECRET!;
    const old = 'test-only-old-callback-secret-00';
    expect(callbackSecretMatches(old)).toBe(false);
    process.env.MPESA_CALLBACK_SECRET_PREVIOUS = old;
    try {
      expect(callbackSecretMatches(old)).toBe(true);
      expect(callbackSecretMatches(current)).toBe(true);
      expect(callbackSecretMatches('wrong-wrong-wrong-wrong')).toBe(false);
    } finally {
      delete process.env.MPESA_CALLBACK_SECRET_PREVIOUS;
    }
  });
});
