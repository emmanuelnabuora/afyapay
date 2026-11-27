-- 0008 Insurer portal access: staff sign-in (email code + required
-- authenticator app, no passwords stored) and row-level security so insurer
-- staff only ever see their own insurer's rows.

create table insurer.insurer_user (
  id                uuid primary key default platform.uuid_v7(),
  insurer_id        uuid not null references insurer.insurer (id),
  email             text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  display_name      text not null,
  role              text not null check (role in ('viewer', 'operator', 'approver')),
  status            text not null default 'active' check (status in ('active', 'suspended')),
  totp_secret_enc   text,          -- AES-256-GCM, key from MFA_SECRET_KEY in the secret store
  totp_enrolled_at  timestamptz,
  last_totp_step    bigint,        -- refuses a code that was already used
  created_at        timestamptz not null default now()
);
create index insurer_user_insurer_idx on insurer.insurer_user (insurer_id);

create table insurer.email_challenge (
  id           uuid primary key default platform.uuid_v7(),
  email        text not null,
  code_hash    text not null,
  attempts     int not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index email_challenge_email_idx on insurer.email_challenge (email, created_at);

-- The audit chain must read the previous hash whoever writes the event.
alter function governance.chain_audit_event() security definer set search_path = governance, pg_temp;

-- Row-level security. Policies apply only to the portal role; the application's
-- own role (the table owner) is unaffected. With no policy matching, the portal
-- role sees nothing.
alter table policy.policy_link enable row level security;
alter table policy.premium_schedule enable row level security;
alter table policy.cover_event enable row level security;
alter table payment.payment_intent enable row level security;
alter table payment.payment_result enable row level security;
alter table identity.customer enable row level security;

do $$
begin
  begin
    create role afyapay_portal nologin;
  exception
    when duplicate_object then null;
    when insufficient_privilege then
      raise warning 'Cannot create role afyapay_portal here; the insurer portal will refuse requests until it exists';
      return;
  end;
  begin
    execute format('grant afyapay_portal to %I', current_user);
  exception when insufficient_privilege then
    raise warning 'Cannot grant afyapay_portal to %; the insurer portal will refuse requests', current_user;
  end;

  grant usage on schema policy, payment, identity, insurer, platform, governance to afyapay_portal;
  grant select on insurer.insurer to afyapay_portal;
  grant select on policy.policy_link, policy.premium_schedule, policy.cover_event to afyapay_portal;
  grant update (status, decided_at, decided_by, rejection_reason, version) on policy.policy_link to afyapay_portal;
  grant insert on policy.premium_schedule, policy.cover_event to afyapay_portal;
  grant select on payment.payment_intent, payment.payment_result to afyapay_portal;
  grant select (id, phone_e164) on identity.customer to afyapay_portal;
  grant insert on governance.audit_event, platform.outbox_event to afyapay_portal;
  grant select (id) on platform.outbox_event to afyapay_portal; -- for insert ... returning id
end $$;

create or replace function insurer.portal_insurer_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.insurer_id', true), '')::uuid $$;

-- Policies name the role, so they are created only where it exists.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'afyapay_portal') then return; end if;
  execute 'create policy portal_own_links on policy.policy_link to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_schedules on policy.premium_schedule to afyapay_portal
      using (exists (select 1 from policy.policy_link l where l.id = policy_link_id and l.insurer_id = insurer.portal_insurer_id()))
      with check (exists (select 1 from policy.policy_link l where l.id = policy_link_id and l.insurer_id = insurer.portal_insurer_id()))';
  execute 'create policy portal_own_cover on policy.cover_event to afyapay_portal
      using (exists (select 1 from policy.policy_link l where l.id = policy_link_id and l.insurer_id = insurer.portal_insurer_id()))
      with check (exists (select 1 from policy.policy_link l where l.id = policy_link_id and l.insurer_id = insurer.portal_insurer_id()))';
  execute 'create policy portal_own_payments on payment.payment_intent to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_results on payment.payment_result to afyapay_portal
      using (exists (select 1 from payment.payment_intent p where p.id = payment_intent_id and p.insurer_id = insurer.portal_insurer_id()))';
  -- A customer is visible only through a link they made with this insurer (they consented to share).
  execute 'create policy portal_linked_customers on identity.customer to afyapay_portal
      using (exists (select 1 from policy.policy_link l where l.customer_id = customer.id and l.insurer_id = insurer.portal_insurer_id()))';
end $$;
