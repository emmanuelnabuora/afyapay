# Incident response runbook

Use this runbook when something threatens customers' money records, their personal data, or the service itself. If in doubt, open an incident. Closing one that turns out to be nothing costs little.

## Roles

During the pilot one person may hold more than one role. Write down who holds each role at the start of every incident.

| Role | Who (pilot) | Does |
|---|---|---|
| Incident lead | Founder, or the on-call engineer until the founder joins | Decides, keeps the timeline, and says when it is over |
| Engineer | On-call engineer | Investigates, contains and fixes |
| Communications | Founder | Talks to insurers, customers, Safaricom and the regulator; nobody else speaks outside |
| Counsel | AfyaPay's lawyer | Advises on breach notices and the wording of anything sent out |

Contact details live in the team's password manager, not in Git.

## Severity

| Level | Examples | Response |
|---|---|---|
| **SEV1** | Personal data exposed or likely exposed. A payment recorded wrongly at scale. Ledger or audit chain altered. Staff admin compromised. Service down during a salary-day peak. | Start at once, at any hour. Founder and counsel told within 1 hour. |
| **SEV2** | One customer's payment is wrong. Statement reconciliation is broken. An insurer is unable to confirm policies. Callbacks are failing and payments are piling up in "We're checking this payment". | Start within 2 hours, in working hours. |
| **SEV3** | A screen is broken but a workaround exists. A scan finding needs a fix. | Next working day, through the normal backlog. |

## The first 30 minutes

1. **Open a log.** Create a dated note with the time, who is involved and what is known. Add to it as you go, with times in East Africa Time.
2. **Stop the harm, without destroying evidence.** Pick what fits from the list below.
   - **Payments wrong or suspicious:** turn off live money. This is a `live_money_enabled = false` request in the staff admin, approved by a second super administrator. If that is too slow, a super administrator suspends the service on the host, or revokes the Daraja credentials in the Safaricom portal. Money only ever moves from customer to insurer through M-Pesa, so stopping AfyaPay never strands funds.
   - **Staff or insurer account compromised:** an engineer sets the account's `status` to `suspended`. The guard checks status on every request, so this takes effect at once. Then rotate any secret the account could have seen; see [secret-rotation.md](secret-rotation.md).
   - **A secret leaked:** rotate it now with [secret-rotation.md](secret-rotation.md).
   - **Attack traffic:** block it at the host or edge. AfyaPay has no general API rate limit yet.
3. **Keep the evidence.**
   - Do not delete logs, rows or files.
   - Take a database backup.
   - Export the host's logs for the window.
   - Note the audit chain's head hash (`governance.audit_event`).
4. **Set the severity.** Tell the founder, and counsel too for SEV1.

## Personal data breaches

Kenya's Data Protection Act, 2019 requires the Office of the Data Protection Commissioner to be notified of a breach within 72 hours of becoming aware of it. Affected people must also be told when there is a real risk of harm. **Counsel confirms whether a notice is needed and writes it.** Start that clock from the moment the breach is suspected, and record that time in the log.

Insurers are separate data controllers for their own customers. Tell any affected insurer as soon as counsel agrees the wording, and in line with the pilot agreement.

## Fix, check, close

1. Find the root cause and fix it. The fix is a normal reviewed pull request, unless the founder approves an emergency change.
2. Check the result.
   - Run `governance.verify_audit_chain()` (the audit check in the staff admin).
   - Compare ledger totals with M-Pesa statements. Look at reconciliation mismatches.
3. Undo the containment steps that are no longer needed, such as turning live money back on. Turning it back on still needs the launch gates and a second approver.
4. Within 5 working days, write a blameless review. Cover what happened, the timeline, the impact, why it happened, and the actions with owners and dates. Link it from this folder.

## Practice

Rehearse one scenario before the pilot, and every quarter after that. Good scenarios:

- An insurer operator's laptop is stolen.
- M-Pesa callbacks stop arriving.
- `PII_ENCRYPTION_KEY` is pasted in a chat.

Record each rehearsal with the date and what was learned.
