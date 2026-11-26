-- 0002 Platform services: idempotency keys, transactional outbox, job queue.

-- Every POST carries an Idempotency-Key. The first request stores its result;
-- a retry with the same key and body gets the same result back; the same key
-- with a different body is refused. Keys expire after 24 hours.
create table platform.idempotency_key (
  scope            text not null,
  key              text not null check (length(key) between 8 and 128),
  request_hash     text not null,
  status           text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  expires_at       timestamptz not null default now() + interval '24 hours',
  primary key (scope, key)
);
create index idempotency_key_expires_idx on platform.idempotency_key (expires_at);

-- Transactional outbox: written in the same transaction as the business change,
-- then published by a relay. An event is never lost and never sent before commit.
create table platform.outbox_event (
  id              uuid primary key default platform.uuid_v7(),
  topic           text not null,
  aggregate_type  text not null,
  aggregate_id    text not null,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  published_at    timestamptz,
  attempts        int not null default 0,
  last_error      text
);
create index outbox_event_unpublished_idx on platform.outbox_event (created_at) where published_at is null;

-- Job queue on PostgreSQL. Workers claim jobs with FOR UPDATE SKIP LOCKED, so
-- two workers never run the same job. Failed jobs retry with backoff.
create table platform.job (
  id            uuid primary key default platform.uuid_v7(),
  kind          text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'dead')),
  run_at        timestamptz not null default now(),
  attempts      int not null default 0,
  max_attempts  int not null default 5 check (max_attempts > 0),
  locked_until  timestamptz,
  last_error    text,
  dedupe_key    text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index job_ready_idx on platform.job (kind, run_at) where status in ('queued', 'running');
