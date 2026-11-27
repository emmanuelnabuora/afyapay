-- 0006 Premium schedules and cover events. Both come from the insurer.
-- Payments move the premium position; only insurer events move cover.

-- The insurer's premium plan for a linked policy. Append-only: a new plan is a
-- new row with a later effective date; the latest one in effect applies.
create table policy.premium_schedule (
  id               uuid primary key default platform.uuid_v7(),
  policy_link_id   uuid not null references policy.policy_link (id),
  frequency        text not null check (frequency in ('daily', 'weekly', 'monthly', 'annual')),
  amount_minor     bigint not null check (amount_minor > 0 and amount_minor % 100 = 0),
  currency         char(3) not null default 'KES' check (currency = 'KES'),
  starts_on        date not null,           -- first period starts here (East Africa dates)
  source           text not null check (source in ('insurer_portal', 'insurer_file', 'insurer_api')),
  recorded_by      text not null,           -- insurer user or file reference
  created_at       timestamptz not null default now(),
  unique (policy_link_id, starts_on)
);
create trigger premium_schedule_append_only
  before update or delete on policy.premium_schedule
  for each row execute function platform.forbid_mutation();

-- What the insurer says about cover. Append-only and insurer-sourced only:
-- nothing AfyaPay computes (a payment, a schedule) may write here.
create table policy.cover_event (
  id               uuid primary key default platform.uuid_v7(),
  policy_link_id   uuid not null references policy.policy_link (id),
  seq              int not null,
  status           text not null check (status in ('active', 'lapsed', 'ended')),
  covered_until    date,
  effective_on     date not null,
  source           text not null check (source in ('insurer_portal', 'insurer_file', 'insurer_api')),
  recorded_by      text not null,
  insurer_reference text,
  recorded_at      timestamptz not null default now(),
  unique (policy_link_id, seq),
  check ((status = 'active') = (covered_until is not null)),
  check (covered_until is null or covered_until >= effective_on)
);
create trigger cover_event_append_only
  before update or delete on policy.cover_event
  for each row execute function platform.forbid_mutation();
create trigger cover_event_no_truncate
  before truncate on policy.cover_event
  for each statement execute function platform.forbid_mutation();

-- Allowed changes. No event yet means "not active".
--   (none)  -> active
--   active  -> active (renewed or reconfirmed), lapsed, ended
--   lapsed  -> active (reinstated), ended
--   ended   -> nothing
create or replace function policy.check_cover_transition() returns trigger
language plpgsql as $$
declare
  prev record;
  link_status text;
begin
  select status into link_status from policy.policy_link where id = new.policy_link_id;
  if link_status is distinct from 'confirmed' then
    raise exception 'cover events need a policy link the insurer has confirmed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.policy_link_id::text, 0));
  select status, seq into prev from policy.cover_event
   where policy_link_id = new.policy_link_id order by seq desc limit 1;

  if prev is null then
    if new.seq <> 1 then raise exception 'first cover event must have seq 1'; end if;
    if new.status <> 'active' then raise exception 'cover cannot be % before it was active', new.status; end if;
  else
    if new.seq <> prev.seq + 1 then raise exception 'cover event seq must follow %', prev.seq; end if;
    if prev.status = 'ended' then raise exception 'cover has ended; no further changes'; end if;
    if prev.status = 'lapsed' and new.status = 'lapsed' then raise exception 'cover is already lapsed'; end if;
  end if;
  return new;
end $$;

create trigger cover_event_transition
  before insert on policy.cover_event
  for each row execute function policy.check_cover_transition();

create index payment_result_intent_idx on payment.payment_result (payment_intent_id);
