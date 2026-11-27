-- 0004 Insurers, policy links and consent records.

create table insurer.insurer (
  id          uuid primary key default platform.uuid_v7(),
  code        text not null unique check (code ~ '^[A-Z0-9_]{2,20}$'),
  name        text not null,
  -- sandbox: fictional or test only; pilot/live need an insurer agreement (gate G3).
  stage       text not null default 'sandbox' check (stage in ('sandbox', 'pilot', 'live')),
  created_at  timestamptz not null default now()
);

-- A customer's claim that a policy at an insurer is theirs. Only the insurer can
-- confirm it. One open or confirmed link per policy number per insurer.
create table policy.policy_link (
  id                uuid primary key default platform.uuid_v7(),
  customer_id       uuid not null references identity.customer (id),
  insurer_id        uuid not null references insurer.insurer (id),
  policy_number     text not null check (policy_number ~ '^[A-Z0-9/-]{3,40}$'),
  status            text not null default 'pending_insurer'
                    check (status in ('pending_insurer', 'confirmed', 'rejected', 'unlinked')),
  requested_at      timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        text,
  rejection_reason  text,
  version           int not null default 1
);
create unique index policy_link_one_active_idx
  on policy.policy_link (insurer_id, policy_number)
  where status in ('pending_insurer', 'confirmed');
create index policy_link_customer_idx on policy.policy_link (customer_id);

-- Every consent a customer gives or withdraws, with the exact wording version.
-- Append-only: withdrawing consent is a new row with granted = false.
create table identity.consent_record (
  id            uuid primary key default platform.uuid_v7(),
  customer_id   uuid not null references identity.customer (id),
  purpose       text not null check (purpose in ('share_with_insurer', 'sms_reminders')),
  insurer_id    uuid references insurer.insurer (id),
  granted       boolean not null,
  text_version  text not null,
  recorded_at   timestamptz not null default now()
);
create index consent_record_customer_idx on identity.consent_record (customer_id, purpose, recorded_at);

create trigger consent_record_append_only
  before update or delete on identity.consent_record
  for each row execute function platform.forbid_mutation();
