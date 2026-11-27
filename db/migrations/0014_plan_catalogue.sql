-- 0014 Plan catalogue (Journey 7, sandbox only). Insurers supply their own
-- plans; customers search and compare them and can register interest. Buying
-- through AfyaPay stays off until launch gate G6 (a licensed broker partner or
-- AfyaPay's own licence) is closed AND the buying switch is approved on.
--
-- Ranking uses price and the customer's filters only. There is deliberately
-- no commission or fee column anywhere in this schema.

create schema if not exists catalogue;

create table catalogue.plan (
  id                        uuid primary key default platform.uuid_v7(),
  insurer_id                uuid not null references insurer.insurer (id),
  code                      text not null check (code ~ '^[A-Z0-9-]{2,30}$'),
  name                      text not null check (length(name) between 3 and 80),
  cover_type                text not null check (cover_type in ('health_individual', 'health_family', 'personal_accident')),
  summary                   text not null check (length(summary) between 10 and 400),
  min_household             smallint not null default 1 check (min_household between 1 and 12),
  max_household             smallint not null default 1 check (max_household between 1 and 12),
  base_monthly_minor        bigint not null check (base_monthly_minor > 0),
  per_extra_member_minor    bigint not null default 0 check (per_extra_member_minor >= 0),
  currency                  char(3) not null default 'KES' check (currency = 'KES'),
  counties                  text[] not null default '{}',  -- empty means every county
  inpatient_limit_minor     bigint check (inpatient_limit_minor > 0),
  outpatient_limit_minor    bigint check (outpatient_limit_minor > 0),
  waiting_period_days       smallint not null default 0 check (waiting_period_days between 0 and 730),
  benefits                  jsonb not null default '[]' check (jsonb_typeof(benefits) = 'array'),
  exclusions                jsonb not null default '[]' check (jsonb_typeof(exclusions) = 'array'),
  sponsored                 boolean not null default false,  -- shown with a label; never moves a plan up
  status                    text not null default 'active' check (status in ('active', 'withdrawn')),
  updated_by                text not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (insurer_id, code),
  check (max_household >= min_household)
);
create index plan_search_idx on catalogue.plan (status, cover_type);

-- Interest a signed-in customer registers in a plan. The insurer sees it,
-- with the phone number, only because the customer consented to that.
create table catalogue.plan_interest (
  id               uuid primary key default platform.uuid_v7(),
  plan_id          uuid not null references catalogue.plan (id),
  insurer_id       uuid not null references insurer.insurer (id),
  customer_id      uuid not null references identity.customer (id),
  household_size   smallint not null check (household_size between 1 and 12),
  county           text,
  quoted_monthly_minor bigint not null check (quoted_monthly_minor > 0),
  consent_version  text not null,
  status           text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  insurer_note     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index plan_interest_one_open_idx on catalogue.plan_interest (plan_id, customer_id) where status <> 'closed';
create index plan_interest_insurer_idx on catalogue.plan_interest (insurer_id, created_at);

alter table identity.consent_record drop constraint consent_record_purpose_check;
alter table identity.consent_record add constraint consent_record_purpose_check
  check (purpose in ('share_with_insurer', 'sms_reminders', 'plan_interest'));

-- The buying switch is a governed setting: an approved request, and refused by
-- the database unless G6 is closed. Buying is available only while both hold.
alter table governance.setting_event drop constraint setting_event_key_check;
alter table governance.setting_event add constraint setting_event_key_check
  check (key in ('staff_ip_allowlist', 'live_money_enabled', 'plan_buying_enabled'));
alter table governance.setting_event add constraint setting_event_plan_buying_type_check
  check (key <> 'plan_buying_enabled' or jsonb_typeof(value) = 'boolean');

create or replace function governance.check_setting_event() returns trigger
language plpgsql as $$
declare
  a governance.approval_request;
begin
  select * into a from governance.approval_request where id = new.approval_request_id;
  if a.status <> 'approved' or a.kind <> 'setting_change' or a.payload->>'key' <> new.key or a.payload->'value' <> new.value then
    raise exception 'setting change does not match an approved request' using errcode = 'P0001';
  end if;
  if new.key = 'live_money_enabled' and new.value = 'true'::jsonb
     and not (select bool_and(governance.gate_closed(g)) from unnest(array['G1', 'G2', 'G3', 'G4', 'G5']) g) then
    raise exception 'live money stays off until launch gates G1 to G5 are closed' using errcode = 'P0001';
  end if;
  if new.key = 'plan_buying_enabled' and new.value = 'true'::jsonb and not governance.gate_closed('G6') then
    raise exception 'buying plans stays off until launch gate G6 is closed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function governance.plan_buying_allowed() returns boolean
language sql stable as $$
  select coalesce((governance.setting('plan_buying_enabled'))::boolean, false) and governance.gate_closed('G6')
$$;

-- Insurer portal: each insurer manages only its own plans and sees only the
-- interest registered in them.
alter table catalogue.plan enable row level security;
alter table catalogue.plan_interest enable row level security;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'afyapay_portal') then return; end if;
  grant usage on schema catalogue to afyapay_portal;
  grant select, insert, update on catalogue.plan to afyapay_portal;
  grant select, update (status, insurer_note, updated_at) on catalogue.plan_interest to afyapay_portal;
  execute 'create policy portal_own_plans on catalogue.plan to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_interest on catalogue.plan_interest to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
end $$;

-- The insurer may see the phone number of a customer who registered interest
-- in one of its plans, because the customer consented to exactly that.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'afyapay_portal') then return; end if;
  execute 'create policy portal_interested_customers on identity.customer for select to afyapay_portal
      using (exists (select 1 from catalogue.plan_interest i where i.customer_id = customer.id and i.insurer_id = insurer.portal_insurer_id()))';
end $$;
