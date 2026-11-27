-- 0010 Bulk cover changes with a second approver, and PDF statements held
-- for manual review.

-- A file of cover changes from an insurer. Over the threshold it waits for a
-- second person; the database refuses an approval by the proposer.
create table policy.cover_batch (
  id            uuid primary key default platform.uuid_v7(),
  insurer_id    uuid not null references insurer.insurer (id),
  file_name     text not null,
  item_count    int not null check (item_count > 0),
  needs_second_approver boolean not null,
  status        text not null default 'proposed' check (status in ('proposed', 'applied', 'rejected')),
  proposed_by   text not null,
  decided_by    text,
  decision_note text,
  applied_count int,
  failed_count  int,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  check (decided_by is null or decided_by <> proposed_by or not needs_second_approver),
  check ((status = 'proposed') = (decided_at is null))
);
create index cover_batch_insurer_idx on policy.cover_batch (insurer_id, created_at desc);

create or replace function policy.check_cover_batch_decision() returns trigger
language plpgsql as $$
begin
  if old.status <> 'proposed' then raise exception 'cover batch % is already %', old.id, old.status using errcode = 'P0001'; end if;
  if new.needs_second_approver is distinct from old.needs_second_approver or new.proposed_by is distinct from old.proposed_by
     or new.item_count is distinct from old.item_count or new.insurer_id is distinct from old.insurer_id then
    raise exception 'cover batch details cannot change' using errcode = 'P0001';
  end if;
  if old.needs_second_approver and new.decided_by = old.proposed_by then
    raise exception 'the person who proposed a cover batch cannot approve it' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger cover_batch_decision before update on policy.cover_batch
  for each row execute function policy.check_cover_batch_decision();
create trigger cover_batch_no_delete before delete on policy.cover_batch
  for each row execute function platform.forbid_mutation();

create table policy.cover_batch_item (
  id                uuid primary key default platform.uuid_v7(),
  batch_id          uuid not null references policy.cover_batch (id),
  insurer_id        uuid not null references insurer.insurer (id),
  line_no           int not null,
  policy_number     text not null,
  status            text not null,
  covered_until     date,
  effective_on      date,
  insurer_reference text,
  unique (batch_id, line_no)
);
create trigger cover_batch_item_append_only before update or delete on policy.cover_batch_item
  for each row execute function platform.forbid_mutation();

-- The outcome of applying each item, written once when the batch is applied.
create table policy.cover_batch_result (
  item_id   uuid primary key references policy.cover_batch_item (id),
  insurer_id uuid not null references insurer.insurer (id),
  applied   boolean not null,
  error     text
);
create trigger cover_batch_result_append_only before update or delete on policy.cover_batch_result
  for each row execute function platform.forbid_mutation();

-- PDF statements an insurer cannot send as a spreadsheet. Held for a person
-- to transcribe; the result is uploaded as a normal statement and linked here.
create table reconciliation.statement_document (
  id               uuid primary key default platform.uuid_v7(),
  insurer_id       uuid not null references insurer.insurer (id),
  file_name        text not null,
  file_sha256      text not null,
  content          bytea not null check (octet_length(content) <= 10485760),
  uploaded_by      text not null,
  status           text not null default 'awaiting_review' check (status in ('awaiting_review', 'transcribed', 'rejected')),
  statement_id     uuid references reconciliation.statement (id),
  review_note      text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (insurer_id, file_sha256),
  check ((status = 'transcribed') = (statement_id is not null))
);

-- A held PDF is reviewed once, by someone other than the uploader, and its
-- file never changes. Documents are never deleted.
alter table reconciliation.statement_document
  add check (reviewed_by is null or reviewed_by <> uploaded_by),
  add check ((status = 'awaiting_review') = (reviewed_at is null));
create or replace function reconciliation.check_statement_document_review() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'statement documents are never deleted' using errcode = 'P0001'; end if;
  if old.status <> 'awaiting_review' then raise exception 'statement document % is already %', old.id, old.status using errcode = 'P0001'; end if;
  if (new.insurer_id, new.file_name, new.file_sha256, new.content, new.uploaded_by, new.created_at)
     is distinct from (old.insurer_id, old.file_name, old.file_sha256, old.content, old.uploaded_by, old.created_at) then
    raise exception 'statement document details cannot change' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger statement_document_review before update or delete on reconciliation.statement_document
  for each row execute function reconciliation.check_statement_document_review();

alter table policy.cover_batch enable row level security;
alter table policy.cover_batch_item enable row level security;
alter table policy.cover_batch_result enable row level security;
alter table reconciliation.statement_document enable row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'afyapay_portal') then return; end if;
  grant select, insert on policy.cover_batch, policy.cover_batch_item, policy.cover_batch_result to afyapay_portal;
  grant update (status, decided_by, decision_note, applied_count, failed_count, decided_at) on policy.cover_batch to afyapay_portal;
  grant select, insert on reconciliation.statement_document to afyapay_portal;
  grant update (status, statement_id, review_note, reviewed_by, reviewed_at) on reconciliation.statement_document to afyapay_portal;
  execute 'create policy portal_own_batches on policy.cover_batch to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_batch_items on policy.cover_batch_item to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_batch_results on policy.cover_batch_result to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
  execute 'create policy portal_own_documents on reconciliation.statement_document to afyapay_portal
      using (insurer_id = insurer.portal_insurer_id()) with check (insurer_id = insurer.portal_insurer_id())';
end $$;
