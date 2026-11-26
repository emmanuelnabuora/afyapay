# Discovery decisions

All seven discovery steps were approved by the founder on 26 November 2026. The full documents are the source of truth; this file is a short index for engineers.

| Step | Document | Decisions |
| --- | --- | --- |
| 1 Product strategy and requirements | [Step 1](https://claude.ai/artifact/TuUVu5TXVSLGMZ3J38pqHB) | D1 to D7 |
| 2 Regulatory activity and dependency matrix | [Step 2](https://claude.ai/artifact/B1WyhR9miRRKRhYYM3uzvT) | R1 to R6 |
| 3 Architecture and transaction flows | [Step 3](https://claude.ai/artifact/CTckM1ELBr5tYCBmCE8r2Y) | A1 to A5 |
| 4 Sitemap and journeys | [Step 4](https://claude.ai/artifact/XeR9puqvVmRk9yYyCX8V5S) | J1 to J6 |
| 5 Design concepts | [Step 5 canvas](https://claude.ai/artifact/KcMcWj5KHtJcjtTtArAYNm) | Visual direction |
| 6 Data, API and security | [Step 6](https://claude.ai/artifact/WvEKQtKZNPHwyeenpNBVsD) | S1 to S6 |
| 7 Backlog, sprint plan and costs | [Step 7](https://claude.ai/artifact/Sn1CgTKXktQX4KceTWBc6n) | B1 to B5 |

## What was decided, in short

- **Business model:** a technology service to insurers. Funds go customer → M-Pesa → insurer paybill. AfyaPay never holds funds. Insurers pay fees; customers pay no AfyaPay fee at MVP. No customer-facing AI at MVP.
- **Sequencing:** payments and reconciliation first. Marketplace comparison and purchase (Journey 7) is built in sandbox only and goes live after gate G6 (a licensed broker partner or AfyaPay's own licence).
- **Launch gates:** G0 to G8. The MVP pilot needs G0 to G5: sandbox, counsel's opinion, data registration and DPIA, insurer pilot agreement, live M-Pesa access, security readiness. Only compliance closes a gate, with evidence.
- **Three tracks per policy:** money received, premium position, cover. Cover changes only on insurer-sourced events.
- **Architecture:** modular monolith (NestJS, PostgreSQL), two ledger books (Collections memo, Revenue), raw SQL ledger, Postgres job queue, transactional outbox, insurer integration files-first, PWA before native apps.
- **Data, API, security:** REST with OpenAPI contract first, phone + OTP for customers, mandatory MFA (no SMS) for staff, database-enforced append-only ledger, retention defaults pending counsel. Production hosting region is open for counsel; staging may use the nearest major cloud region.
- **Plan:** 10 epics, 8 two-week sprints, target start 11 January 2027, pilot technically ready 30 April 2027. Estimated KES 8 to 13 million to pilot (estimates, not quotes).

Legal points in these documents are the team's understanding, not counsel's opinion.
