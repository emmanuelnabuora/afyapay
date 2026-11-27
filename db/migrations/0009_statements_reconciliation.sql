-- 0009 Reconciliation: insurer statements matched against confirmed M-Pesa
-- payments. Each line either matches or becomes an exception a person resolves.

-- How to read one insurer's statement file: which header holds which field.
create table reconciliation.statement_mapping (
  insurer_id     uuid primary key references insurer.insurer (id),
  receipt_col    text not null,
  policy_col     text not null,
  amount_col     text not null,
  date_col       text not null,
  date_format    text not null default 'YYYY-MM-DD' check (date_format in ('YYYY-MM-DD', 'DD/MM/YYYY')),
  updated_by     text not null,
  updated_at     timestamptz not null default now()
);

create table reconciliation.statement (
  id              uuid primary key default platform.uuid_v7(),
  insurer_id      uuid not null references insurer.insurer (id),
  file_name       text not null,
  file_sha256     text not null,
  uploaded_by     text not null,
  line_count      int not null,
  matched_count   int not null,
  exception_count int not null,
  period_from     date,
  period_to       date,
  created_at      timestamptz not null default now(),
  unique (insurer_id, file_sha256)
);

create table reconciliation.statement_line (
  id                 uuid primary key default platform.uuid_v7(),
  statement_id       uuid not null references reconciliation.statement (id),
  insurer_id         uuid not null references insurer.insurer (id),
  line_no            int not null,
  mpesa_receipt      text,
  policy_number      text,
  amount_minor       bigint,
  paid_on            date,
  outcome            text not null check (outcome in ('matched', 'already_matched', 'exception')),
  payment_intent_id  uuid references payment.payment_intent (id),
  unique (statement_id, line_no)
);
create index statement_line_receipt_idx on reconciliation.statement_line (insurer_id, mpesa_receipt);
create unique index statement_line_one_match_idx on reconciliation.statement_line (payment_intent_id) where outcome = 'matched';

create trigger statement_append_only before update or delete on reconciliation.statement
  for each row execute function platform.forbid_mutation();
create trigger statement_line_append_only before update or delete on reconciliation.statement_line
  for each row execute function platform.forbid_mutation();

create table reconciliation.exception (
  id                 uuid primary key default platform.uuid_v7(),
  insurer_id         uuid not null references insurer.insurer (id),
  kind               text not null check (kind in ('unparseable_line', 'duplicate_line', 'unknown_receipt',
                                                    'amount_mismatch', 'policy_mismatch', 'date_mismatch', 'missing_from_statement')),
  statement_line_id  uuid references reconciliation.statement_line (id),
  payment_intent_id  uuid references payment.payment_intent (id),
  detail             text not null,
  status             text not null default 'open' check (status in ('open', 'resolved')),
  owner_user_id      text,
  due_at             timestamptz not null,
  resolution_note    text,
  resolved_by        text,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  check ((status = 'resolved') = (resolved_at is not null and resolution_note is not null and resolved_by is not null))
);
create index exception_open_idx on reconciliation.exception (insurer_id, due_at) where status = 'open';
-- A payment missing from statements is raised once while it is open.
create unique index exception_missing_once_idx on reconciliation.exception (payment_intent_id)
  where kind = 'missing_from_statement' and status = 'open';

alter table reconciliation.statement_mapping enable row level security;
alter table reconciliation.statement enable row level security;
alter table reconciliation.statement_line enable row level security;
alter table reconciliation.exception enable row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'afyapay_portal') then return; end if;
  grant usage on schema reconciliation to afyapay_portal;
  grant select, insert, update on reconciliation.statement_mapping to afyapay_portal;
  grant select, insert on reconciliation.statement, reconciliation.statement_line to afyapay_portal;
  grant select, insert on reconciliation.exception to afyapay_portal;
  grant update (status, owner_user_id, resolution_note, resolved_by, resolved_at) on reconciliation.exception to afyapay_portal;
  execute 'create policy portal_own_mapping on reconciliation.statement_mapping to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_statements on reconciliation.statement to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_lines on reconciliation.statement_line to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_exceptions on reconciliation.exception to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
end $$;
