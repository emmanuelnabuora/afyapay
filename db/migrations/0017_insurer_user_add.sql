-- 0017 Adding insurer users from the staff admin (support playbook gap).
-- Support, compliance or a super administrator asks, after confirming the
-- request with the insurer's named administrator. A super administrator other
-- than the proposer approves (the existing decision trigger), and the user is
-- created in the same transaction. The new user sets up an authenticator at
-- first sign-in.

alter table governance.approval_request drop constraint approval_request_kind_check;
alter table governance.approval_request add constraint approval_request_kind_check
  check (kind in ('role_grant', 'role_revoke', 'setting_change', 'customer_unmask', 'account_action', 'insurer_user_add'));
alter table governance.approval_request add constraint approval_request_insurer_user_add_payload_check
  check (kind <> 'insurer_user_add' or (
    payload->>'insurerId' ~ '^[0-9a-f-]{36}$'
    and payload->>'email' ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'
    and payload->>'email' = lower(payload->>'email')
    and length(payload->>'displayName') between 2 and 120
    and payload->>'role' in ('viewer', 'operator', 'approver')));
