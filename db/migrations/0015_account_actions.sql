-- 0015 Account actions from the staff admin (support playbook gaps).
-- Suspending a staff or insurer user takes effect at once (it only removes
-- access) and is audited. Resetting an authenticator, or reactivating a
-- suspended account, gives access back, so it is an approval request
-- ('account_action') that a super administrator other than the proposer, and
-- other than the account's owner, approves.

alter table governance.approval_request drop constraint approval_request_kind_check;
alter table governance.approval_request add constraint approval_request_kind_check
  check (kind in ('role_grant', 'role_revoke', 'setting_change', 'customer_unmask', 'account_action'));
alter table governance.approval_request add constraint approval_request_account_action_payload_check
  check (kind <> 'account_action' or (
    payload->>'accountType' in ('staff_user', 'insurer_user')
    and payload->>'accountId' ~ '^[0-9a-f-]{36}$'
    and payload->>'action' in ('reset_authenticator', 'reactivate')));

create or replace function governance.check_approval_decision() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'approval requests are never deleted' using errcode = 'P0001'; end if;
  if old.status <> 'proposed' then raise exception 'approval request % is already %', old.id, old.status using errcode = 'P0001'; end if;
  if (new.kind, new.payload, new.reason, new.proposed_by, new.created_at) is distinct from (old.kind, old.payload, old.reason, old.proposed_by, old.created_at) then
    raise exception 'approval request details cannot change' using errcode = 'P0001';
  end if;
  if new.status = 'withdrawn' and new.decided_by is not null then
    raise exception 'only the proposer withdraws a request' using errcode = 'P0001';
  end if;
  if new.status in ('approved', 'rejected') then
    if new.decided_by = new.proposed_by then
      raise exception 'the person who proposed a request cannot decide it' using errcode = 'P0001';
    end if;
    if new.kind = 'customer_unmask' then
      if not (governance.has_role(new.decided_by, 'compliance') or governance.has_role(new.decided_by, 'super_admin')) then
        raise exception 'only compliance or a super administrator can decide this request' using errcode = 'P0001';
      end if;
    elsif not governance.has_role(new.decided_by, 'super_admin') then
      raise exception 'only a super administrator can decide this request' using errcode = 'P0001';
    end if;
    if new.kind in ('role_grant', 'role_revoke') and new.payload->>'staffUserId' = new.decided_by::text then
      raise exception 'nobody can decide a change to their own roles' using errcode = 'P0001';
    end if;
    if new.kind = 'account_action' and new.payload->>'accountId' = new.decided_by::text then
      raise exception 'nobody can decide an action on their own account' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

