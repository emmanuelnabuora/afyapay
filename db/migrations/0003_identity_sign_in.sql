-- 0003 Customer sign-in: phone number + one-time code, rotating refresh tokens.
-- Codes and refresh tokens are stored only as keyed hashes, never in clear.

create table identity.customer (
  id          uuid primary key default platform.uuid_v7(),
  phone_e164  text not null unique check (phone_e164 ~ '^\+254[17][0-9]{8}$'),
  status      text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table identity.otp_challenge (
  id           uuid primary key default platform.uuid_v7(),
  phone_e164   text not null check (phone_e164 ~ '^\+254[17][0-9]{8}$'),
  code_hash    text not null,
  attempts     int not null default 0 check (attempts >= 0),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index otp_challenge_phone_created_idx on identity.otp_challenge (phone_e164, created_at);

-- One row per refresh token. Using a token rotates it: the old row is revoked and
-- points at its replacement. Reusing a revoked token revokes the whole family,
-- because it means the token was stolen and someone else already used it.
create table identity.session (
  id                  uuid primary key default platform.uuid_v7(),
  customer_id         uuid not null references identity.customer (id),
  family_id           uuid not null,
  refresh_token_hash  text not null unique,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  revoked_reason      text check (revoked_reason in ('rotated', 'logout', 'reuse_detected', 'suspended')),
  replaced_by         uuid references identity.session (id)
);
create index session_family_idx on identity.session (family_id);
create index session_customer_idx on identity.session (customer_id);
