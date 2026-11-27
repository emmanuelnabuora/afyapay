# Rehearsal: an insurer operator's laptop is stolen

**Date:** 27 Nov 2026 (technical drill). The team tabletop is still to run.
**Scenario:** at 10:40 EAT, Pwani Mutual's administrator calls. One of their portal operators had their laptop stolen from a matatu an hour ago. The laptop was signed in to the AfyaPay insurer portal and to the operator's work email. The operator's authenticator app is on their phone, which they still have.

Everything below used synthetic data on a development copy. The insurer, people and times are fictional.

## Part 1: technical drill (done)

The drill followed [incident-response.md](../incident-response.md), "Staff or insurer account compromised", and checked each step against the app. It is now a repeatable test in `test/admin-operations.int.spec.ts` ("incident drill").

| Step | Runbook says | What happened |
|---|---|---|
| 1 | Compliance or a super administrator chooses **Suspend** | Worked. A suspension needs a reason, and support alone cannot suspend. |
| 2 | Access ends at once | Worked. The laptop's open session was refused on its next request. |
| 3 | Find what the account did | Worked. Every insurer action (policy decisions, cover and premium updates, cover files, statements, plans) writes an audit event with the operator as actor. Filter the audit log by that account. |
| 4 | Keep evidence: audit chain head hash | Worked. `governance.verify_audit_chain()` reported the chain intact and gave the head hash to note in the log. |
| 5 | Give the operator access back on a new laptop (reset authenticator, reactivate, both approved by a super administrator) | **Gap found.** See below. |

### Gap found and fixed

Before this change, the stolen laptop's session came back. Suspending refused it, but once the account was reactivated or re-enrolled, the old token worked again until its own 30 minutes ran out. In a real incident we would likely reactivate within that window, as soon as the operator has a new laptop.

**Fix (migration `0016_end_sessions.sql`):** suspending an account, or resetting its authenticator, now records the moment. Every session issued before then is refused for good, including after reactivation. A database trigger records it, so a change made by hand in an emergency also ends sessions. This covers staff accounts as well as insurer accounts. Two new tests show the old session staying refused while the new one works.

### Other findings

- The stolen laptop was also signed in to the operator's work email, which receives the sign-in codes. The thief still needs the authenticator on the operator's phone, so the portal stays closed. The insurer must still end that email session on their side. This is added to the runbook.
- If an authenticator was on the stolen device, reset it before reactivating. The runbook now says to do both when in doubt.

## Part 2: team tabletop (to run)

About 45 minutes, before the pilot. People: the founder (incident lead and communications) and the on-call engineer. Counsel joins for the last 10 minutes or by phone. One person reads the prompts out in order and does not reveal the next one early. The engineer uses a staging copy, never production.

| Time | Prompt | What we want to see |
|---|---|---|
| 0 min | The call above. | Someone opens a dated log and writes down who holds each role. |
| 5 min | "Which operator, and what can they do in the portal?" | The engineer finds them on the **Insurer users** page and names their role. |
| 10 min | "Stop it." | Compliance or a super administrator suspends the account, with a reason. Note the time it took. |
| 15 min | "Did the thief do anything?" | The audit log is filtered by the operator's account for the last two hours. We agree what counts as suspicious, for example cover changes nobody asked for. |
| 20 min | Twist: the log shows one cover update at 10:12 that the operator says they did not make. | Severity goes up. Cover is insurer-owned, so Pwani decides the correct cover and makes the correction in their portal. We do not change it ourselves. |
| 25 min | "Is customers' personal data exposed?" | The team decides whether the operator's screens showed personal data, and when the 72-hour clock would start if counsel says this is a breach. Write that time in the log. |
| 30 min | "What do we tell Pwani, and who says it?" | Only the founder speaks to the insurer. Draft two or three sentences and have counsel check them. |
| 40 min | "The operator has a new laptop. Give access back." | Support raises reset authenticator and reactivate, after confirming with Pwani's named administrator. A second super administrator approves. The old session stays refused. |
| 45 min | Close. | Agree actions, owners and dates, and fill in the record below. |

### Record (fill in after the tabletop)

- Date and people:
- Time to suspend after the call:
- What was slow or unclear:
- Runbook changes:
- Actions, owners and dates:

## Next rehearsals

Each quarter after the pilot starts. Still to rehearse: "M-Pesa callbacks stop arriving" and "`PII_ENCRYPTION_KEY` is pasted in a chat". Key rotation itself is already tested in `test/key-rotation.int.spec.ts`.
