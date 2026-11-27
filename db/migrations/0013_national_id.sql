-- 0013 National ID numbers (founder decision, 2026-11-27). Stored encrypted
-- (AES-256-GCM, key from PII_ENCRYPTION_KEY in the secret store) with a keyed
-- hash for exact-match lookup; only the last two digits are kept in clear for
-- masking. Insurer portal staff have no access. Seeing a number in full is a
-- customer_unmask request with field 'national_id'.
-- Retention and lawful basis are for the DPIA and counsel before real use.

create table identity.national_id (
  customer_id  uuid primary key references identity.customer (id),
  id_enc       text not null check (id_enc like 'f1.%'),
  id_hmac      text not null unique check (id_hmac ~ '^[0-9a-f]{64}$'),
  id_length    smallint not null check (id_length in (7, 8)),
  last_two     char(2) not null check (last_two ~ '^\d{2}$'),
  recorded_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table identity.national_id enable row level security; -- no policy: the portal role sees nothing

alter table governance.approval_request drop constraint approval_request_unmask_payload_check;
alter table governance.approval_request add constraint approval_request_unmask_payload_check
  check (kind <> 'customer_unmask' or (payload ? 'customerId' and payload->>'field' in ('phone', 'national_id')));

drop function governance.unmask_allowed(uuid, uuid, uuid);
-- True only for the person who asked, for that field, for 30 minutes after the approval.
create function governance.unmask_allowed(request uuid, staff uuid, customer uuid, wanted text) returns boolean
language sql stable as $$
  select exists (
    select 1 from governance.approval_request r
     where r.id = request and r.kind = 'customer_unmask' and r.status = 'approved'
       and r.proposed_by = staff and r.payload->>'customerId' = customer::text and r.payload->>'field' = wanted
       and r.decided_at > now() - interval '30 minutes')
$$;
