# Backup and restore drill (E10)

**Result:** pass. A full dump and restore took 5.7 s end to end, and the restored copy matched the source exactly.

## How it was run

`SOURCE_URL=... TARGET_URL=... scripts/restore-drill.sh`

The script does five things:

1. It dumps the source with `pg_dump --format=custom`.
2. It restores the dump into an **empty** scratch database with `pg_restore`. It refuses a target that already has tables. It also refuses non-local hosts unless `ALLOW_REMOTE=1` is set.
3. It compares every table's row count, source against restored copy.
4. It checks that all database triggers came back, including the append-only ones.
5. It tries to delete from `ledger.journal_entry` inside a rolled-back transaction, and expects the database to refuse.

After the script, two checks were made by hand:

- The app booted against the restored copy and `/v1/health` answered `{"status":"ok","database":"up"}`.
- The migrator said "Nothing to apply".

## Results (27 Nov 2026, development database, synthetic data)

| Measure | Value |
|---|---|
| Dump size | 4.1 MB |
| Tables | 43 |
| Rows | 60,808 |
| Triggers restored | 31 of 31 |
| Append-only after restore | delete refused |
| Dump time | 0.6 s |
| Restore time | 1.0 s |
| Verify time | 4.1 s |
| Total | 5.7 s |

## What this does not yet prove

- **Hosted backups:** this was a logical dump on one machine. Production also needs the hosting provider's automatic backups with point-in-time recovery. The **production environment plan** must set the recovery targets, for example losing at most 5 minutes of data and being back within 1 hour. Repeat the drill there, restoring a provider backup into a fresh instance.
- **Time at scale:** the restore time grows with data. Re-time the drill when the pilot database is larger, and at least once a quarter.
- **Encryption key:** a restore is only useful with the same `PII_ENCRYPTION_KEY`. Without it, national ID numbers cannot be decrypted. The secret rotation runbook must keep old keys recoverable.
