/**
 * Re-encrypts stored secrets after PII_ENCRYPTION_KEY or MFA_SECRET_KEY has
 * been rotated (docs/runbooks/secret-rotation.md). Run it with the NEW key as
 * the current value and the old one as *_PREVIOUS:
 *
 *   node dist/database/rotate-keys.js            # dry run: counts only
 *   node dist/database/rotate-keys.js --apply    # re-encrypts, in one transaction
 *
 * It touches national ID numbers (encrypted value and lookup hash) and the
 * authenticator secrets of staff and insurer users. It never prints a value.
 * When it reports nothing left to re-encrypt, the *_PREVIOUS keys can go.
 */
import { Client, ClientBase } from 'pg';
import { decryptField, encryptField, isCurrentField, lookupHash } from '../common/field-crypto';
import { decryptSecretWithKeyInfo, encryptSecret } from '../modules/insurer/totp';

export interface RotationReport {
  nationalIds: { total: number; reencrypted: number };
  staffAuthenticators: { total: number; reencrypted: number };
  insurerAuthenticators: { total: number; reencrypted: number };
  applied: boolean;
}

/**
 * Re-encrypts, inside the caller's transaction, every value still under a
 * previous key. With apply false it only counts.
 */
export async function reencrypt(db: ClientBase, apply: boolean): Promise<RotationReport> {
  const ids = await db.query<{ customer_id: string; id_enc: string }>('select customer_id, id_enc from identity.national_id for update');
  let idCount = 0;
  for (const row of ids.rows) {
    if (isCurrentField(row.id_enc)) continue;
    const plain = decryptField(row.id_enc);
    idCount++;
    if (apply) {
      await db.query('update identity.national_id set id_enc = $2, id_hmac = $3 where customer_id = $1', [row.customer_id, encryptField(plain), lookupHash(plain, 'national-id')]);
    }
  }

  const authenticators = async (table: 'governance.staff_user' | 'insurer.insurer_user') => {
    const rows = await db.query<{ id: string; totp_secret_enc: string }>(`select id, totp_secret_enc from ${table} where totp_secret_enc is not null for update`);
    let n = 0;
    for (const row of rows.rows) {
      const { plain, current } = decryptSecretWithKeyInfo(row.totp_secret_enc);
      if (current) continue;
      n++;
      if (apply) await db.query(`update ${table} set totp_secret_enc = $2 where id = $1`, [row.id, encryptSecret(plain)]);
    }
    return { total: rows.rowCount ?? 0, reencrypted: n };
  };
  const staff = await authenticators('governance.staff_user');
  const insurer = await authenticators('insurer.insurer_user');
  if (apply) {
    await db.query(
      "insert into governance.audit_event (actor_type, actor_id, action, subject_type, subject_id) values ('system', 'rotate-keys', 'security.keys_reencrypted', 'system', 'encryption-keys')",
    );
  }
  return { nationalIds: { total: ids.rowCount ?? 0, reencrypted: idCount }, staffAuthenticators: staff, insurerAuthenticators: insurer, applied: apply };
}

/** Runs `reencrypt` in one transaction: all rows move to the current key, or none do. */
export async function rotateKeys(connectionString: string, apply: boolean): Promise<RotationReport> {
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query('begin');
    const report = await reencrypt(db, apply);
    await db.query(apply ? 'commit' : 'rollback');
    return report;
  } catch (err) {
    await db.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  rotateKeys(url, process.argv.includes('--apply'))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
