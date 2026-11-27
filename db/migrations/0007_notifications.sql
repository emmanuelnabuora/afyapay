-- 0007 Notifications: SMS and in-app messages, in English or Kiswahili.

create schema if not exists notification;

alter table identity.customer
  add column language text not null default 'en' check (language in ('en', 'sw'));

create table notification.message (
  id                   uuid primary key default platform.uuid_v7(),
  customer_id          uuid not null references identity.customer (id),
  channel              text not null check (channel in ('sms', 'in_app')),
  template             text not null,
  language             text not null check (language in ('en', 'sw')),
  body                 text not null check (length(body) <= 480),
  essential            boolean not null,      -- payment outcomes are essential; reminders need consent
  dedupe_key           text not null,
  status               text not null default 'queued'
                       check (status in ('queued', 'sent', 'delivered', 'failed', 'suppressed', 'skipped_no_consent')),
  send_after           timestamptz not null default now(),
  provider             text,
  provider_message_id  text,
  status_reason        text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (channel, dedupe_key)
);
create index message_due_idx on notification.message (send_after) where status = 'queued';
create index message_customer_idx on notification.message (customer_id, created_at desc);
