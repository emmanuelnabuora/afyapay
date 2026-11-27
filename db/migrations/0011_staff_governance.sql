-- 0011 Staff governance: AfyaPay staff sign-in (email code + required
-- authenticator app, no passwords), staff roles, maker-checker approval
-- requests, settings, launch gates with evidence, and a stable audit hash.
--
-- The rules that matter are enforced here, not only in the application:
--   * the proposer of a request can never decide it;
--   * only a super administrator approves role and setting changes;
--   * roles and settings change only through an approved request;
--   * only compliance closes a launch gate, and only with evidence;
--   * live money stays off until gates G1 to G5 are closed.

---------------------------------------------------------------------------
-- Audit hash v2. v1 hashed occurred_at::text, which depends on the session's
-- TimeZone setting. v2 hashes a fixed UTC format, so the chain can be checked
-- from any session. Rows written before this migration keep hash_version null
-- (v1) and are checked the v1 way.
---------------------------------------------------------------------------
alter table governance.audit_event add column hash_version smallint;
alter table governance.audit_event alter column hash_version set default 2;

create or replace function governance.audit_hash(
  version smallint, prev_hash text, id uuid, occurred_at timestamptz, actor_type text, actor_id text,
  action text, subject_type text, subject_id text, before_state jsonb, after_state jsonb
) returns text
language sql stable as $$
  select encode(sha256(convert_to(
    coalesce(prev_hash, '') || '|' || id::text || '|' ||
    case when coalesce(version, 1) = 1 then occurred_at::text
         else to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end || '|' ||
    actor_type || '|' || actor_id || '|' || action || '|' || subject_type || '|' || subject_id || '|' ||
    coalesce(before_state::text, '') || '|' || coalesce(after_state::text, ''),
    'UTF8')), 'hex')
$$;

create or replace function governance.chain_audit_event() returns trigger
language plpgsql security definer set search_path = governance, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext('governance.audit_event'));
  -- seq is taken again under the lock: the identity default runs before this
  -- trigger, so two writers could otherwise link in a different order from seq.
  new.seq := nextval(pg_get_serial_sequence('governance.audit_event', 'seq'));
  select hash into new.prev_hash from governance.audit_event order by seq desc limit 1;
  new.hash_version := 2;
  new.hash := governance.audit_hash(2::smallint, new.prev_hash, new.id, new.occurred_at, new.actor_type, new.actor_id,
    new.action, new.subject_type, new.subject_id, new.before_state, new.after_state);
  return new;
end;
$$;

-- Follows the chain from its first event, link by link, recomputing each
-- hash. Reports the first problem: a changed event, a break (an event
-- removed), a fork, or events the chain never reaches. Links are followed
-- rather than seq, because events written before 0011 could link out of seq
-- order when two were written at once.
create index audit_event_prev_hash_idx on governance.audit_event (prev_hash);

create or replace function governance.verify_audit_chain()
returns table (checked bigint, total bigint, head_hash text, first_bad_seq bigint, problem text)
language plpgsql stable as $$
declare
  r governance.audit_event;
  prev text := null;
  n bigint := 0;
  all_rows bigint;
  links int;
begin
  select count(*) into all_rows from governance.audit_event;
  loop
    select count(*) into links from governance.audit_event e where e.prev_hash is not distinct from prev;
    exit when links = 0;
    select * into r from governance.audit_event e where e.prev_hash is not distinct from prev order by e.seq limit 1;
    if links > 1 then
      return query select n, all_rows, prev, r.seq, 'two events claim the same previous event'::text; return;
    end if;
    if r.hash <> governance.audit_hash(r.hash_version, r.prev_hash, r.id, r.occurred_at, r.actor_type, r.actor_id,
         r.action, r.subject_type, r.subject_id, r.before_state, r.after_state) then
      return query select n, all_rows, prev, r.seq, 'event content does not match its hash'::text; return;
    end if;
    n := n + 1;
    prev := r.hash;
  end loop;
  if n < all_rows then
    return query select n, all_rows, prev,
      (select min(e.seq) from governance.audit_event e where e.prev_hash is not null and not exists (select 1 from governance.audit_event p where p.hash = e.prev_hash)),
      'the chain is broken: an event is missing or changed'::text;
    return;
  end if;
  return query select n, all_rows, prev, null::bigint, null::text;
end;
$$;

---------------------------------------------------------------------------
-- Staff users and sign-in. No password exists, so none is stored.
---------------------------------------------------------------------------
create table governance.staff_user (
  id                uuid primary key default platform.uuid_v7(),
  email             text not null unique check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  display_name      text not null,
  status            text not null default 'active' check (status in ('active', 'suspended')),
  totp_secret_enc   text,          -- AES-256-GCM, key from MFA_SECRET_KEY in the secret store
  totp_enrolled_at  timestamptz,
  last_totp_step    bigint,
  created_by        text not null,
  created_at        timestamptz not null default now()
);

create table governance.staff_email_challenge (
  id           uuid primary key default platform.uuid_v7(),
  email        text not null,
  code_hash    text not null,
  attempts     int not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index staff_email_challenge_email_idx on governance.staff_email_challenge (email, created_at);

---------------------------------------------------------------------------
-- Approval requests (maker-checker).
---------------------------------------------------------------------------
create table governance.approval_request (
  id             uuid primary key default platform.uuid_v7(),
  kind           text not null check (kind in ('role_grant', 'role_revoke', 'setting_change')),
  payload        jsonb not null,
  reason         text not null check (length(reason) between 5 and 500),
  proposed_by    uuid not null references governance.staff_user (id),
  status         text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'withdrawn')),
  decided_by     uuid references governance.staff_user (id),
  decision_note  text,
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  check (decided_by is null or decided_by <> proposed_by),
  check ((status = 'proposed') = (decided_at is null)),
  check ((status in ('approved', 'rejected')) = (decided_by is not null)),
  check (kind not in ('role_grant', 'role_revoke') or (payload ? 'staffUserId' and payload ? 'role')),
  check (kind <> 'setting_change' or (payload ? 'key' and payload ? 'value'))
);
create index approval_request_status_idx on governance.approval_request (status, created_at);

---------------------------------------------------------------------------
-- Roles. Append-only events; a user's roles are the latest event per role.
-- An event needs an approved request, except the first two super
-- administrators, which a person with database access creates once.
---------------------------------------------------------------------------
create table governance.staff_role_event (
  seq                  bigint generated always as identity primary key,
  staff_user_id        uuid not null references governance.staff_user (id),
  role                 text not null check (role in ('support', 'finance', 'compliance', 'super_admin')),
  action               text not null check (action in ('grant', 'revoke')),
  approval_request_id  uuid unique references governance.approval_request (id),
  created_at           timestamptz not null default now()
);
create index staff_role_event_user_idx on governance.staff_role_event (staff_user_id, role, seq);

create or replace function governance.has_role(staff uuid, wanted text) returns boolean
language sql stable as $$
  select coalesce((
    select e.action = 'grant' from governance.staff_role_event e
     where e.staff_user_id = staff and e.role = wanted
     order by e.seq desc limit 1), false)
$$;

create or replace function governance.check_role_event() returns trigger
language plpgsql as $$
declare
  a governance.approval_request;
  admins int;
begin
  if new.approval_request_id is null then
    perform pg_advisory_xact_lock(hashtext('governance.staff_role_event'));
    select count(distinct staff_user_id) into admins from governance.staff_role_event e
     where e.role = 'super_admin' and governance.has_role(e.staff_user_id, 'super_admin');
    if new.role <> 'super_admin' or new.action <> 'grant' or admins >= 2 then
      raise exception 'role changes need an approved request (only the first two super administrators can be set up directly)' using errcode = 'P0001';
    end if;
    return new;
  end if;
  select * into a from governance.approval_request where id = new.approval_request_id;
  if a.status <> 'approved'
     or a.kind <> 'role_' || new.action
     or a.payload->>'staffUserId' <> new.staff_user_id::text
     or a.payload->>'role' <> new.role then
    raise exception 'role event does not match an approved request' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger staff_role_event_check before insert on governance.staff_role_event
  for each row execute function governance.check_role_event();
create trigger staff_role_event_append_only before update or delete on governance.staff_role_event
  for each row execute function platform.forbid_mutation();

---------------------------------------------------------------------------
-- Settings. Append-only; the current value is the latest event per key.
---------------------------------------------------------------------------
create table governance.setting_event (
  seq                  bigint generated always as identity primary key,
  key                  text not null check (key in ('staff_ip_allowlist', 'live_money_enabled')),
  value                jsonb not null,
  approval_request_id  uuid not null unique references governance.approval_request (id),
  created_at           timestamptz not null default now(),
  check (key <> 'staff_ip_allowlist' or jsonb_typeof(value) = 'array'),
  check (key <> 'live_money_enabled' or jsonb_typeof(value) = 'boolean')
);

create or replace function governance.setting(wanted text) returns jsonb
language sql stable as $$
  select value from governance.setting_event where key = wanted order by seq desc limit 1
$$;

---------------------------------------------------------------------------
-- Launch gates. Closing needs the compliance role and at least one piece of
-- evidence. Status is the latest event per gate.
---------------------------------------------------------------------------
create table governance.launch_gate (
  code         text primary key check (code ~ '^G[0-8]$'),
  title        text not null,
  needed_for   text not null check (needed_for in ('pilot', 'later'))
);
insert into governance.launch_gate (code, title, needed_for) values
  ('G0', 'Sandbox', 'pilot'),
  ('G1', 'Legal perimeter opinion', 'pilot'),
  ('G2', 'Entity and data registration', 'pilot'),
  ('G3', 'Insurer pilot agreement', 'pilot'),
  ('G4', 'Payment provider live access', 'pilot'),
  ('G5', 'Security readiness', 'pilot'),
  ('G6', 'Distribution licence route', 'later'),
  ('G7', 'Custody route', 'later'),
  ('G8', 'Credit route', 'later');
create trigger launch_gate_fixed before update or delete on governance.launch_gate
  for each row execute function platform.forbid_mutation();

create table governance.gate_evidence (
  id            uuid primary key default platform.uuid_v7(),
  gate_code     text not null references governance.launch_gate (code),
  title         text not null check (length(title) between 3 and 200),
  file_name     text,
  content_type  text check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  content       bytea check (octet_length(content) <= 10485760),
  uploaded_by   uuid not null references governance.staff_user (id),
  created_at    timestamptz not null default now(),
  check ((content is null) = (content_type is null) and (content is null) = (file_name is null))
);
create trigger gate_evidence_append_only before update or delete on governance.gate_evidence
  for each row execute function platform.forbid_mutation();

create table governance.gate_event (
  seq         bigint generated always as identity primary key,
  gate_code   text not null references governance.launch_gate (code),
  status      text not null check (status in ('closed', 'reopened')),
  note        text not null check (length(note) between 5 and 1000),
  actor_id    uuid not null references governance.staff_user (id),
  created_at  timestamptz not null default now()
);

create or replace function governance.gate_closed(wanted text) returns boolean
language sql stable as $$
  select coalesce((select status = 'closed' from governance.gate_event where gate_code = wanted order by seq desc limit 1), false)
$$;

create or replace function governance.check_gate_event() returns trigger
language plpgsql as $$
begin
  if not governance.has_role(new.actor_id, 'compliance') then
    raise exception 'only compliance can close or reopen a launch gate' using errcode = 'P0001';
  end if;
  if new.status = 'closed' and not exists (select 1 from governance.gate_evidence where gate_code = new.gate_code) then
    raise exception 'launch gate % needs evidence before it can be closed', new.gate_code using errcode = 'P0001';
  end if;
  if (new.status = 'closed') = governance.gate_closed(new.gate_code) then
    raise exception 'launch gate % is already in that state', new.gate_code using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger gate_event_check before insert on governance.gate_event
  for each row execute function governance.check_gate_event();
create trigger gate_event_append_only before update or delete on governance.gate_event
  for each row execute function platform.forbid_mutation();

-- Live money needs the switch on AND gates G1 to G5 closed, checked each time.
create or replace function governance.live_money_allowed() returns boolean
language sql stable as $$
  select coalesce((governance.setting('live_money_enabled'))::boolean, false)
     and (select bool_and(governance.gate_closed(g)) from unnest(array['G1', 'G2', 'G3', 'G4', 'G5']) g)
$$;

---------------------------------------------------------------------------
-- Request decisions and setting changes.
---------------------------------------------------------------------------
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
    if not governance.has_role(new.decided_by, 'super_admin') then
      raise exception 'only a super administrator can decide this request' using errcode = 'P0001';
    end if;
    if new.kind in ('role_grant', 'role_revoke') and new.payload->>'staffUserId' = new.decided_by::text then
      raise exception 'nobody can decide a change to their own roles' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger approval_request_decision before update or delete on governance.approval_request
  for each row execute function governance.check_approval_decision();

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
  return new;
end;
$$;
create trigger setting_event_check before insert on governance.setting_event
  for each row execute function governance.check_setting_event();
create trigger setting_event_append_only before update or delete on governance.setting_event
  for each row execute function platform.forbid_mutation();
