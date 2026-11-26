# AfyaPay: rules for working in this repository

These rules come from the founder's master brief and the approved discovery decisions (see `docs/decisions.md`). They apply to every change.

## Hard rules

- **No custody.** Money flows customer → M-Pesa → the insurer's own paybill. Never add code, config or data structures that hold, pool or pay out customer funds.
- **Never claim compliance.** No UI text, docs or comments may state that AfyaPay holds a licence, approval or compliance status without verified evidence recorded against a launch gate.
- **Never store** M-Pesa PINs, card numbers, card security codes, banking passwords or insurer portal passwords. No column, log field or cache may hold them.
- **No secrets in Git.** Secrets live in the vault; code reads references. `.env` files are ignored; only `.env.example` with dummy values is committed.
- **No real customer data** outside production. Tests, seeds, demos and fixtures use synthetic data only (fictional insurers such as "Pwani Mutual" and "Jamii Assurance").
- **No production deploys** and no paid infrastructure without the founder's explicit approval.
- **Cover is insurer-owned.** Only an insurer-sourced event may change a policy's cover state. Payments update the premium position, never cover.

## Money and ledger

- Amounts are `BIGINT` minor units plus a currency code. Never floats or decimals in code paths that touch money.
- Ledger and audit tables are append-only, enforced in the database. Corrections are compensating entries approved by a second person (maker-checker).
- Every write endpoint takes an `Idempotency-Key`. Provider callbacks go to the inbox first and are confirmed by a status query before any ledger entry.

## Wording

Use the fixed status vocabulary from the Step 4 doc. Never mix "saved", "paid" and "covered".

## Architecture

Modular monolith (NestJS, PostgreSQL), one schema per domain module, adapters for every external provider, transactional outbox. See `docs/decisions.md`.
