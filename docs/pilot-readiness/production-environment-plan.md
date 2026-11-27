# Production environment plan (E10)

**Status:** draft. Nothing in this plan is built or paid for. Production is created only after counsel advises on the hosting region and the founder approves the cost and the deploy.

## The open question: where the data lives

The hosting region is the one decision this plan cannot make. Counsel needs to advise on two points:

1. Do Kenya's Data Protection Act, 2019 and the Data Protection (General) Regulations, 2021 require any of AfyaPay's processing to stay on servers in Kenya? This covers national ID numbers and health insurance policy data.
2. If data may leave Kenya, what safeguards and records do we need for a transfer, and does the DPIA cover them?

| If counsel says | Hosting options to quote (no prices assumed) |
|---|---|
| Data must stay in Kenya | A Kenyan data centre or local cloud provider with managed PostgreSQL and backups. Ask at least two providers for quotes. |
| Data may leave Kenya with safeguards | A major cloud provider's African region (South Africa today), or keep Render in its nearest region. Render has no African region. |

Staging stays where it is (Render, synthetic data only) whatever counsel decides.

## What production needs, wherever it runs

| Area | Requirement |
|---|---|
| Separation | A separate account, database and secrets from staging. No staging person or key has production access by default. |
| Database | Managed PostgreSQL 16, encrypted at rest, private network only. Automatic backups with point-in-time recovery: we lose no more than **5 minutes** of data and are back within **1 hour**. These targets are for the founder to confirm. |
| Backups | Daily copies kept for 35 days, in a second location in the same legal region. A restore drill ([restore-drill.md](restore-drill.md)) before go-live, then every quarter. |
| App | At least two instances behind HTTPS, with health checks on `/v1/health`. Re-run the [load test](load-test.md) here on a synthetic copy before go-live. |
| Edge | TLS 1.2 or higher, HSTS (already sent), a per-client rate limit, and basic attack filtering. |
| Secrets | In the provider's secret store, two-person access, rotated per [secret-rotation.md](../runbooks/secret-rotation.md). |
| Access | Named accounts with MFA, least privilege, no shared logins, and an access review every quarter. Production database access only for an incident, and logged. |
| Logs and alerts | Logs kept for 90 days with no personal data in them. Alerts go to the on-call phone for: 5xx errors, payments stuck in "checking", audit chain failure, and failed backups. |
| M-Pesa | Production Daraja credentials, and each insurer's own paybill and passkey. The callback URL is on our production domain. |
| Deploys | From `main` only, after CI passes, with the founder's approval for the first deploy and for any change to live money settings. |

## Steps, in order

1. Counsel's advice on the region. This is part of gate G1/G2 evidence.
2. Quotes from two or three providers that fit. The founder approves one.
3. Build production with infrastructure as code, reviewed like any other change.
4. Restore drill, load test and pen test retest on production, with synthetic data.
5. Gate G5 evidence complete. Compliance closes the gate. The founder approves go-live.
6. Live money turned on through the staff admin, with launch gates checked and a second approver.
