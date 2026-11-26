-- 0001 Foundation: one schema per domain module, time-ordered ids,
-- an append-only double-entry ledger and a hash-chained audit log.
-- Money is always BIGINT minor units (cents) plus a currency code.

create schema if not exists identity;
create schema if not exists insurer;
create schema if not exists policy;
create schema if not exists payment;
create schema if not exists inbox;
create schema if not exists ledger;
create schema if not exists reconciliation;
create schema if not exists platform;
create schema if not exists governance;

-- UUID v7: 48-bit Unix milliseconds, then random bits. Sorts by creation time.
create or replace function platform.uuid_v7() returns uuid
language sql volatile as $$
  select encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
              from 1 for 6),
      52, 1), 53, 1),
    'hex')::uuid;
$$;

-- Shared guard: rows in append-only tables can never change or disappear.
create or replace function platform.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'append-only table %.%: % is not allowed; post a compensating entry instead',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'P0001';
end;
$$;

---------------------------------------------------------------------------
-- Ledger: two books. Collections is a memo of money that went straight to
-- insurers (AfyaPay never holds it). Revenue is AfyaPay's own fee income.
---------------------------------------------------------------------------

create table ledger.ledger_account (
  id          uuid primary key default platform.uuid_v7(),
  book        text not null check (book in ('collections', 'revenue')),
  code        text not null,
  name        text not null,
  currency    char(3) not null default 'KES' check (currency = 'KES'),
  created_at  timestamptz not null default now(),
  unique (book, code)
);

create table ledger.journal_entry (
  id                 uuid primary key default platform.uuid_v7(),
  book               text not null check (book in ('collections', 'revenue')),
  description        text not null,
  idempotency_key    text not null unique,
  reverses_entry_id  uuid references ledger.journal_entry (id),
  created_at         timestamptz not null default now()
);

create table ledger.journal_line (
  id            uuid primary key default platform.uuid_v7(),
  entry_id      uuid not null references ledger.journal_entry (id),
  account_id    uuid not null references ledger.ledger_account (id),
  amount_minor  bigint not null check (amount_minor <> 0),
  currency      char(3) not null default 'KES' check (currency = 'KES'),
  created_at    timestamptz not null default now()
);
create index journal_line_entry_idx on ledger.journal_line (entry_id);
create index journal_line_account_idx on ledger.journal_line (account_id);

-- An entry must have at least two lines, all in the entry's book, summing to zero.
-- Checked at commit so lines can be inserted one by one inside a transaction.
create or replace function ledger.check_entry_balanced() returns trigger
language plpgsql as $$
declare
  v_entry_id uuid;
  v_lines int;
  v_sum numeric;
  v_wrong_book int;
begin
  if tg_table_name = 'journal_entry' then
    v_entry_id := new.id;
  else
    v_entry_id := new.entry_id;
  end if;

  select count(l.id), coalesce(sum(l.amount_minor), 0),
         count(*) filter (where a.book <> e.book)
    into v_lines, v_sum, v_wrong_book
    from ledger.journal_entry e
    left join ledger.journal_line l on l.entry_id = e.id
    left join ledger.ledger_account a on a.id = l.account_id
   where e.id = v_entry_id;

  if v_lines < 2 then
    raise exception 'journal entry % needs at least two lines (has %)', v_entry_id, v_lines using errcode = 'P0002';
  end if;
  if v_sum <> 0 then
    raise exception 'journal entry % does not balance: lines sum to %', v_entry_id, v_sum using errcode = 'P0003';
  end if;
  if v_wrong_book > 0 then
    raise exception 'journal entry % has lines on accounts from another book', v_entry_id using errcode = 'P0004';
  end if;
  return null;
end;
$$;

-- Fires for the entry itself (catches an entry with no lines) and for each line.
create constraint trigger journal_entry_balanced
  after insert on ledger.journal_entry
  deferrable initially deferred
  for each row execute function ledger.check_entry_balanced();

create constraint trigger journal_line_balanced
  after insert on ledger.journal_line
  deferrable initially deferred
  for each row execute function ledger.check_entry_balanced();

create trigger journal_entry_append_only
  before update or delete on ledger.journal_entry
  for each row execute function platform.forbid_mutation();
create trigger journal_entry_no_truncate
  before truncate on ledger.journal_entry
  for each statement execute function platform.forbid_mutation();

create trigger journal_line_append_only
  before update or delete on ledger.journal_line
  for each row execute function platform.forbid_mutation();
create trigger journal_line_no_truncate
  before truncate on ledger.journal_line
  for each statement execute function platform.forbid_mutation();

---------------------------------------------------------------------------
-- Audit: every staff action, hash-chained so a removed or altered event
-- is detectable.
---------------------------------------------------------------------------

create table governance.audit_event (
  id            uuid primary key default platform.uuid_v7(),
  seq           bigint generated always as identity unique,
  occurred_at   timestamptz not null default now(),
  actor_type    text not null check (actor_type in ('customer', 'insurer_user', 'staff_user', 'system')),
  actor_id      text not null,
  action        text not null,
  subject_type  text not null,
  subject_id    text not null,
  before_state  jsonb,
  after_state   jsonb,
  prev_hash     text,
  hash          text not null
);

create or replace function governance.chain_audit_event() returns trigger
language plpgsql as $$
begin
  -- Serialise writers so each event links to the one before it.
  perform pg_advisory_xact_lock(hashtext('governance.audit_event'));
  select hash into new.prev_hash from governance.audit_event order by seq desc limit 1;
  new.hash := encode(sha256(convert_to(
    coalesce(new.prev_hash, '') || '|' || new.id::text || '|' || new.occurred_at::text || '|' ||
    new.actor_type || '|' || new.actor_id || '|' || new.action || '|' ||
    new.subject_type || '|' || new.subject_id || '|' ||
    coalesce(new.before_state::text, '') || '|' || coalesce(new.after_state::text, ''),
    'UTF8')), 'hex');
  return new;
end;
$$;

create trigger audit_event_chain
  before insert on governance.audit_event
  for each row execute function governance.chain_audit_event();

create trigger audit_event_append_only
  before update or delete on governance.audit_event
  for each row execute function platform.forbid_mutation();
create trigger audit_event_no_truncate
  before truncate on governance.audit_event
  for each statement execute function platform.forbid_mutation();
