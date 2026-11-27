-- 0005 Payments: M-Pesa STK push straight to the insurer's own paybill.
-- AfyaPay never receives the money; these tables record what happened.

-- The insurer's own paybill. Credentials are references to the secret store,
-- never the secret itself.
create table insurer.collection_account (
  id                 uuid primary key default platform.uuid_v7(),
  insurer_id         uuid not null references insurer.insurer (id),
  shortcode          text not null check (shortcode ~ '^[0-9]{5,7}$'),
  mode               text not null check (mode in ('simulated', 'daraja_sandbox', 'daraja_live')),
  passkey_ref        text,           -- name of the secret holding the Lipa na M-Pesa passkey
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);
create unique index collection_account_one_active_idx on insurer.collection_account (insurer_id) where active;

create table payment.payment_intent (
  id              uuid primary key default platform.uuid_v7(),
  customer_id     uuid not null references identity.customer (id),
  policy_link_id  uuid not null references policy.policy_link (id),
  insurer_id      uuid not null references insurer.insurer (id),
  collection_account_id uuid not null references insurer.collection_account (id),
  amount_minor    bigint not null check (amount_minor >= 100 and amount_minor <= 15000000 and amount_minor % 100 = 0),
  currency        char(3) not null default 'KES' check (currency = 'KES'),
  status          text not null default 'created'
                  check (status in ('created', 'prompt_sent', 'confirmed', 'failed', 'expired', 'needs_review')),
  failure_code    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  version         int not null default 1
);
-- One open prompt per policy at a time, so a double tap cannot charge twice.
create unique index payment_intent_one_open_idx on payment.payment_intent (policy_link_id)
  where status in ('created', 'prompt_sent');
create index payment_intent_customer_idx on payment.payment_intent (customer_id, created_at desc);

create table payment.stk_request (
  id                   uuid primary key default platform.uuid_v7(),
  payment_intent_id    uuid not null unique references payment.payment_intent (id),
  merchant_request_id  text not null,
  checkout_request_id  text not null unique,
  response_code        text not null,
  created_at           timestamptz not null default now()
);

-- Every raw callback, stored before anything else happens. A repeated callback
-- for the same checkout request is ignored by the unique key.
create table inbox.provider_callback (
  id                  uuid primary key default platform.uuid_v7(),
  provider            text not null check (provider in ('mpesa')),
  kind                text not null check (kind in ('stk_callback')),
  provider_reference  text not null,
  payload             jsonb not null,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  unique (provider, kind, provider_reference)
);

-- The confirmed outcome of a payment. Written once, never changed.
create table payment.payment_result (
  id                 uuid primary key default platform.uuid_v7(),
  payment_intent_id  uuid not null unique references payment.payment_intent (id),
  result_code        int not null,
  result_desc        text not null,
  mpesa_receipt      text unique,
  amount_minor       bigint,
  confirmed_via      text not null check (confirmed_via in ('status_query')),
  journal_entry_id   uuid references ledger.journal_entry (id),
  created_at         timestamptz not null default now()
);
create trigger payment_result_append_only
  before update or delete on payment.payment_result
  for each row execute function platform.forbid_mutation();
