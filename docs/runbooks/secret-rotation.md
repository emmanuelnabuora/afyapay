# Secret rotation runbook

Rotate a secret on a schedule, when someone who knew it leaves, or at once if it may have leaked. Secrets live only in the host's secret store (environment variables on Render today). They are never kept in Git, chat or email. Generate each new value with at least 32 random bytes, for example `openssl rand -base64 48`.

Every rotation is logged in the incident log (if it was a leak) or the change log, with the date and who did it. It never records the value.

## The secrets

| Secret | What it protects | What rotating it does | How often |
|---|---|---|---|
| `PII_ENCRYPTION_KEY` | National ID numbers (encrypted, plus a lookup hash) | Nothing visible, with the steps below | Yearly, or at once on a leak |
| `MFA_SECRET_KEY` | Staff and insurer authenticator secrets (encrypted) | Nothing visible, with the steps below | Yearly, or at once on a leak |
| `AUTH_SECRET` | Customer, insurer and staff sign-in tokens; one-time code and refresh token hashes | **Everyone is signed out.** Codes in flight stop working. | Yearly, or at once on a leak |
| `MPESA_CALLBACK_SECRET` | The secret path M-Pesa calls back on | Nothing visible, with the steps below | Yearly, or at once on a leak |
| `DATABASE_URL` password | The database | A short restart | Yearly, or when an engineer leaves |
| Daraja consumer key and secret, passkey | Our M-Pesa API access | Changed in the Safaricom portal first, then in the host | As Safaricom requires, or on a leak |

## Encryption keys: `PII_ENCRYPTION_KEY` and `MFA_SECRET_KEY`

The app reads data under the old key while `*_PREVIOUS` holds it. New data always uses the current key. Nothing is lost if the steps are followed in order.

1. **Take a backup first.** Keep it, together with the old key, in the password manager until step 6 is done. A restore needs the key that was current when the backup was taken.
2. In the host, set `PII_ENCRYPTION_KEY_PREVIOUS` to the old value and `PII_ENCRYPTION_KEY` to the new one. Do the same for `MFA_SECRET_KEY` if you are rotating it. Restart.
3. Check that the app still works. Look up a synthetic customer by national ID in the staff admin, and sign in as staff with an authenticator.
4. Dry run: `node dist/database/rotate-keys.js`. It counts the values still under the old key and prints no values.
5. Apply: `node dist/database/rotate-keys.js --apply`. It re-encrypts everything in one transaction and writes `security.keys_reencrypted` to the audit log. Run the dry run again; every `reencrypted` count must be 0.
6. Remove the `*_PREVIOUS` variables and restart. Check step 3 again.
7. After the backup retention period has passed, destroy the old key and the step 1 backup.

**If the old key leaked,** also treat the data as exposed. Follow [incident-response.md](incident-response.md), because rotating does not undo what was already read.

## `AUTH_SECRET`

1. Set the new value in the host and restart. All access tokens, refresh tokens and pending codes stop working.
2. Customers, insurer staff and AfyaPay staff sign in again. Authenticator apps keep working, because they are protected by `MFA_SECRET_KEY`, not this secret.
3. For a planned rotation, pick a quiet hour, never a salary-day peak, and tell insurers the day before.

## `MPESA_CALLBACK_SECRET`

1. Set `MPESA_CALLBACK_SECRET_PREVIOUS` to the old value and `MPESA_CALLBACK_SECRET` to the new one, then restart. New payment prompts use the new callback path; callbacks for older prompts still arrive on the old one.
2. After 24 hours (prompts expire in minutes), remove `MPESA_CALLBACK_SECRET_PREVIOUS` and restart.

A missed callback never loses a payment. Every payment is confirmed by a status query to M-Pesa before anything is written to the ledger.

## After any rotation

- Confirm the old value is gone from the host and from anyone's notes.
- If a person left, check that their staff or insurer account is suspended and their authenticator reset.
- Run the audit check in the staff admin.
