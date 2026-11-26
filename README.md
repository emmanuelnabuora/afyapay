# AfyaPay

AfyaPay helps Kenyan households pay insurance premiums in small, regular amounts by M-Pesa, straight to their insurer.

AfyaPay is a technology service to insurers. Customer money goes from M-Pesa directly to the insurer's own paybill. AfyaPay never holds customer funds, and only the insurer can activate, extend or end cover.

**Status:** discovery complete (26 Nov 2026). Building starts with Sprint 0. Nothing in this repository is live, and no licence, approval or compliance status is claimed.

## Running locally

Requires Node 22 and PostgreSQL 16.

```sh
npm install
cp .env.example .env            # dummy values only
npm run migrate                 # needs DATABASE_URL
npm run build && npm start      # GET http://localhost:3000/v1/health
```

Tests use a throwaway database, which they reset:

```sh
TEST_DATABASE_URL=postgres://afyapay:afyapay@localhost:5432/afyapay_test npm test
```

Synthetic data for demos and staging (fictional insurers, every record marked `synthetic: true`):

```sh
npm run synthetic -- --seed 7 --customers 50 > data/synthetic/sample.json
```

## Layout

- `src/modules/<module>`: one NestJS module per domain (identity, insurer, policy, payment, inbox, ledger, reconciliation, platform, governance), each owning the database schema of the same name.
- `db/migrations`: plain SQL migrations, applied in order by `scripts/migrate.ts`.
- `src/modules/platform`: Idempotency-Key handling for every POST, the transactional outbox and the PostgreSQL job queue.
- `src/common/mask.ts`: masks phone numbers, ID numbers, tokens and secrets before anything is logged.
- `test`: integration tests against a real PostgreSQL.

The ledger and audit tables are append-only, enforced by database triggers: an UPDATE, DELETE or TRUNCATE fails, and every journal entry must balance to zero at commit. See `CLAUDE.md` for the rules every change follows.
