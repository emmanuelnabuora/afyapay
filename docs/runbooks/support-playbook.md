# Support playbook: customers and insurers

This playbook is for anyone answering AfyaPay support during the pilot. Support staff use the staff admin (`/admin/`) with the **support** role. Customers are found by phone number, and their details show masked. Seeing a full phone number or national ID needs a reason and a second approver (compliance or super administrator), and lasts 30 minutes.

## Ground rules

- **Never ask for or accept an M-Pesa PIN, card number, bank password or insurer portal password.** If a customer sends one, tell them to change it, and delete the message. Never copy it anywhere.
- **AfyaPay never holds money.** Payments go from the customer's M-Pesa to the insurer's own paybill. We cannot refund. Refunds are the insurer's to make.
- **Cover is the insurer's decision.** Never say a customer "is covered" because they paid. Say what the insurer last confirmed, and send cover questions to the insurer.
- **Use the app's words:**

  | App status | Meaning |
  |---|---|
  | "Payment received by M-Pesa" | M-Pesa confirmed the payment. |
  | "Payment didn't go through" | Failed or expired; no money was taken. |
  | "We're checking this payment" | M-Pesa has not given a clear answer yet. |
  | "Waiting for M-Pesa" | The prompt was sent and the customer has not finished. |

  Do not mix "paid", "saved" and "covered".

- Every lookup is in the audit log. Look up only the customer you are helping, and only for their request.
- Escalate anything that looks like fraud, a data leak or many customers with the same fault. That is an incident: see [incident-response.md](incident-response.md).

## Customers

| They say | Check | Do |
|---|---|---|
| "I paid but the app doesn't show it" | Find them by phone and look at the payment. | **Received:** it shows on their home screen and the insurer has it; nothing to do. **Checking:** tell them not to pay again; we confirm with M-Pesa automatically. If it is still checking after 1 hour, escalate to finance. **Not found:** ask for the M-Pesa message (receipt code and amount only, never the PIN). If the paybill is the insurer's, the money went to the insurer, maybe without AfyaPay; send them to the insurer. |
| "Money was taken twice" | Two "received" payments for the same policy | It is the insurer's refund. Give the customer both M-Pesa receipt codes. Tell the insurer through the portal contact and log it. |
| "I didn't get the code" | Codes are limited per hour. | Check that the number is right and the phone has signal. Wait 10 minutes and try again. Never read a code out or send one yourself. |
| "My policy request is still waiting" | The link status says "waiting for insurer". | Insurers confirm in their portal. If it has waited more than 2 working days, nudge the insurer. |
| "My policy request was rejected" | The insurer gave a reason. | Share the reason. The customer checks the policy number with their insurer and tries again. |
| "Am I covered?" | The cover status shown, as the insurer reported it | Read out what the insurer last confirmed, and the date. For anything else, send them to the insurer. |
| "I want to change my phone number" | Not yet in the app | Log the request. An engineer moves it after checks agreed with counsel. |
| "Delete my data" | Data subject request | Log it and pass it to compliance the same day. There is a legal deadline; counsel confirms the steps. |

## Insurers

| They say | Check | Do |
|---|---|---|
| "I can't sign in" or "lost my authenticator" | **Insurer users** page: the user exists and is active. | Confirm who they are with their insurer's named administrator, not the caller alone. Then choose **Reset authenticator…** and say how you confirmed them. A super administrator approves it on Approvals. The user sets up a new authenticator at their next sign-in, and their old sessions end. |
| "Statement doesn't match" | Mismatches in the portal | Mismatches list lines with no matching M-Pesa receipt, or a different amount. The insurer checks their paybill export. AfyaPay finance helps if a line looks missing on our side. |
| "Cover file won't go through" | Batch status | A file with more than 50 lines needs a second approver at the insurer. Check that both approvers have signed in. |
| "A customer says they paid" | Payment by receipt code | Confirm from the payment record. The insurer's paybill statement is the source of truth for money received. |
| "Add or remove a staff member" | Request from the insurer's named administrator | **Remove:** compliance or a super administrator chooses **Suspend** on the Insurer users page; access ends at once. **Add:** on the Insurer users page, fill in **Add an insurer user** with the insurer, their work email, name and role (viewer, operator or approver), and say who asked and how you confirmed it. A super administrator approves it on Approvals. The new user sets up an authenticator at first sign-in. |

## Handover and records

- **Logging:** log each case in the support tracker with the date, channel, masked phone number, what was asked and what was done. Never record a full ID number or phone number.
- **Response targets:** reply to customers within 1 working day. Reply to insurers within 4 working hours. On salary days (25th to the 5th), check the "checking" payments every 2 hours.

## Gaps to close before or during the pilot

- Changing a phone number, and data subject requests, need a process agreed with counsel.
- The customer app shows a support phone number and email once `SUPPORT_PHONE` and `SUPPORT_EMAIL` are set on the host. Set them before the pilot.
