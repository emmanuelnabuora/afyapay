-- 0016 Sessions end for good when an account is suspended or its
-- authenticator is reset (incident drill, 27 Nov 2026).
--
-- Before this, the guards only checked the account's current status and
-- enrolment. A token taken from a stolen laptop stopped working on suspension,
-- but worked again once the account was reactivated or re-enrolled, until the
-- token's own 30 minutes ran out. Now every token issued before
-- sessions_valid_after is refused. A trigger sets it, so a change made by
-- hand in an emergency ends sessions too.

alter table governance.staff_user add column sessions_valid_after timestamptz;
alter table insurer.insurer_user add column sessions_valid_after timestamptz;

create or replace function governance.end_sessions_on_lockout() returns trigger
language plpgsql as $$
begin
  if (new.status = 'suspended' and old.status is distinct from 'suspended')
     or (new.totp_enrolled_at is null and old.totp_enrolled_at is not null) then
    new.sessions_valid_after := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger staff_user_end_sessions before update on governance.staff_user
  for each row execute function governance.end_sessions_on_lockout();
create trigger insurer_user_end_sessions before update on insurer.insurer_user
  for each row execute function governance.end_sessions_on_lockout();
