-- 0012 Masked customer lookup. Staff see a customer's phone number masked.
-- Seeing it in full is an approval request ('customer_unmask') that someone
-- else with the compliance or super administrator role approves; the
-- approval lets only the person who asked see it, for 30 minutes.

alter table governance.approval_request drop constraint approval_request_kind_check;
alter table governance.approval_request add constraint approval_request_kind_check
  check (kind in ('role_grant', 'role_revoke', 'setting_change', 'customer_unmask'));
alter table governance.approval_request add constraint approval_request_unmask_payload_check
  check (kind <> 'customer_unmask' or (payload ? 'customerId' and payload->>'field' = 'phone'));

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
  end if;
  return new;
end;
$$;

-- True only for the person who asked, for 30 minutes after the approval.
create or replace function governance.unmask_allowed(request uuid, staff uuid, customer uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from governance.approval_request r
     where r.id = request and r.kind = 'customer_unmask' and r.status = 'approved'
       and r.proposed_by = staff and r.payload->>'customerId' = customer::text
       and r.decided_at > now() - interval '30 minutes')
$$;
