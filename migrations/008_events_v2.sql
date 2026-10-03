-- ══════════════════════════════════════════════════════════════
-- Events v2 — full rebuild (see EVENTS_REBUILD_PLAN.md §5).
--
-- DESTRUCTIVE: drops every pre-v2 event table. The Events feature was in
-- testing only, so existing event data is intentionally discarded.
-- Personal transactions, goals, subscriptions and auth tables are untouched.
--
-- All money is integer paise. Per-amount columns are `integer` (max
-- 1,000,000,000 paise = INR 1,00,00,000); SUMs are bigint and are parsed to
-- JS numbers by the pg type parser in db/pool.ts.
-- ══════════════════════════════════════════════════════════════

drop table if exists
  event_reactions,
  event_messages,
  event_activity,
  event_audit_logs,
  event_budget_categories,
  event_settlements,
  event_expenses,
  event_invites,
  event_members,
  events
cascade;

-- ── Events ─────────────────────────────────────────────────────
create table events (
  id                     uuid primary key default uuid_generate_v4(),
  owner_id               uuid not null references users(id),
  title                  text not null check (char_length(title) between 1 and 100),
  event_type             text not null default 'other'
                           check (event_type in ('trip', 'birthday', 'dinner', 'wedding', 'other')),
  description            text check (description is null or char_length(description) <= 1000),
  location               text check (location is null or char_length(location) <= 120),
  start_date             date not null,
  end_date               date not null,
  currency               text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  budget_paise           integer check (budget_paise is null or (budget_paise > 0 and budget_paise <= 1000000000)),
  status                 text not null default 'active' check (status in ('active', 'completed', 'archived')),
  join_policy            text not null default 'code' check (join_policy in ('admins_only', 'code', 'code_approval')),
  allow_member_expenses  boolean not null default true,
  members_edit_others    boolean not null default false,
  completed_at           timestamptz,
  archived_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (end_date >= start_date)
);

create index events_owner on events(owner_id);
create index events_status on events(status);

-- ── Members ────────────────────────────────────────────────────
create table event_members (
  event_id    uuid not null references events(id) on delete cascade,
  user_id     uuid not null references users(id),
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  status      text not null default 'active' check (status in ('pending', 'active', 'removed', 'left')),
  invited_by  uuid references users(id) on delete set null,
  joined_at   timestamptz,
  removed_at  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (event_id, user_id),
  -- pending/removed/left members can never hold a privileged role
  check (role = 'member' or status = 'active')
);

create index event_members_user on event_members(user_id, status);
create index event_members_event_status on event_members(event_id, status);
create unique index event_members_one_owner on event_members(event_id)
  where role = 'owner' and status = 'active';

-- ── Files (metadata only; bytes live on the storage driver) ───
create table files (
  id           uuid primary key default uuid_generate_v4(),
  owner_id     uuid not null references users(id),
  event_id     uuid not null references events(id) on delete cascade,
  purpose      text not null check (purpose in ('receipt', 'proof', 'chat')),
  storage_key  text not null unique,
  mime         text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  sha256       text not null,
  created_at   timestamptz not null default now()
);

create index files_event on files(event_id);

-- ── Invitations ────────────────────────────────────────────────
-- One row per event. code_hmac is the lookup key; code_enc lets admins
-- display the current code again. Revoke sets revoked_at; regenerate
-- replaces the row.
create table event_invite_codes (
  event_id    uuid primary key references events(id) on delete cascade,
  code_hmac   text not null unique,
  code_enc    text not null,
  expires_at  timestamptz not null,
  created_by  uuid not null references users(id),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table event_email_invitations (
  id            uuid primary key default uuid_generate_v4(),
  event_id      uuid not null references events(id) on delete cascade,
  email         text not null check (email = lower(email)),
  invited_by    uuid not null references users(id),
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'cancelled', 'expired')),
  last_sent_at  timestamptz not null default now(),
  send_count    integer not null default 1,
  created_at    timestamptz not null default now()
);

create unique index event_email_invitations_pending
  on event_email_invitations(event_id, email) where status = 'pending';

-- ── Expenses ───────────────────────────────────────────────────
create table event_expenses (
  id               uuid primary key,  -- client-generated; doubles as idempotency key
  event_id         uuid not null references events(id) on delete cascade,
  created_by       uuid not null references users(id),
  paid_by          uuid not null references users(id),
  title            text not null check (char_length(title) between 1 and 120),
  category         text not null check (char_length(category) between 1 and 40),
  amount_paise     integer not null check (amount_paise > 0 and amount_paise <= 1000000000),
  expense_date     date not null,
  expense_time     text check (expense_time is null or expense_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  notes            text check (notes is null or char_length(notes) <= 1000),
  split_mode       text not null check (split_mode in ('equal', 'exact', 'percentage', 'shares')),
  receipt_file_id  uuid references files(id) on delete set null,
  status           text not null default 'active' check (status in ('active', 'voided')),
  voided_at        timestamptz,
  voided_by        uuid references users(id) on delete set null,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index event_expenses_event_status_created on event_expenses(event_id, status, created_at desc);
create index event_expenses_event_date on event_expenses(event_id, expense_date desc);
create index event_expenses_paid_by on event_expenses(paid_by);

-- Normalised shares (replaces the old JSONB column). Rows always sum to
-- the parent expense's amount_paise; enforced by the ledger, re-checked by
-- assertLedgerConsistent before every commit.
create table event_expense_shares (
  expense_id   uuid not null references event_expenses(id) on delete cascade,
  user_id      uuid not null references users(id),
  share_paise  integer not null check (share_paise >= 0 and share_paise <= 1000000000),
  input_value  integer check (input_value is null or input_value >= 0),
  primary key (expense_id, user_id)
);

create index event_expense_shares_user on event_expense_shares(user_id);

-- ── Settlements ────────────────────────────────────────────────
-- Created when the payer taps "Mark as paid". The balance only changes
-- once the recipient (or owner) confirms.
create table event_settlements (
  id                uuid primary key,  -- client-generated; idempotency key
  event_id          uuid not null references events(id) on delete cascade,
  from_user         uuid not null references users(id),
  to_user           uuid not null references users(id),
  amount_paise      integer not null check (amount_paise > 0 and amount_paise <= 1000000000),
  method            text not null check (method in ('upi', 'bank', 'cash', 'other')),
  upi_app           text check (upi_app is null or upi_app in ('gpay', 'phonepe', 'paytm', 'bhim', 'other')),
  utr               text check (utr is null or char_length(utr) between 6 and 64),
  proof_file_id     uuid references files(id) on delete set null,
  reference_code    text not null unique,
  status            text not null default 'pending_confirmation'
                      check (status in ('pending_confirmation', 'confirmed', 'rejected', 'cancelled')),
  paid_marked_at    timestamptz not null default now(),
  confirmed_at      timestamptz,
  confirmed_by      uuid references users(id) on delete set null,
  rejected_at       timestamptz,
  rejected_by       uuid references users(id) on delete set null,
  rejection_reason  text check (rejection_reason is null or char_length(rejection_reason) <= 300),
  created_at        timestamptz not null default now(),
  check (from_user <> to_user)
);

create index event_settlements_event_status on event_settlements(event_id, status, created_at desc);
create index event_settlements_from_user on event_settlements(from_user);
create index event_settlements_to_user on event_settlements(to_user);
-- at most one open settlement per payer→recipient pair
create unique index event_settlements_one_pending on event_settlements(event_id, from_user, to_user)
  where status = 'pending_confirmation';

-- ── Chat ───────────────────────────────────────────────────────
-- text/attachment bodies are AES-256-GCM encrypted by the server
-- (event id bound as AAD). System messages carry a plain JSON payload.
create table event_messages (
  id                  uuid primary key,  -- client-generated for text/attachment; idempotency key
  event_id            uuid not null references events(id) on delete cascade,
  sender_id           uuid references users(id),
  kind                text not null check (kind in ('text', 'attachment', 'system')),
  ciphertext          bytea,
  iv                  bytea,
  key_version         smallint not null default 1,
  attachment_file_id  uuid references files(id) on delete set null,
  system_payload      jsonb,
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid references users(id) on delete set null,
  check (
    (kind = 'system' and ciphertext is null and iv is null and system_payload is not null and sender_id is null)
    or (kind in ('text', 'attachment') and ciphertext is not null and iv is not null and sender_id is not null)
  ),
  check (kind <> 'attachment' or attachment_file_id is not null)
);

create index event_messages_event_created on event_messages(event_id, created_at desc, id desc);

-- ── Activity feed and audit trail ──────────────────────────────
create table event_activity (
  id            uuid primary key default uuid_generate_v4(),
  event_id      uuid not null references events(id) on delete cascade,
  actor_id      uuid references users(id) on delete set null,
  kind          text not null,
  summary       text not null,
  amount_paise  integer,
  created_at    timestamptz not null default now()
);

create index event_activity_event_created on event_activity(event_id, created_at desc);

create table event_audit_logs (
  id           uuid primary key default uuid_generate_v4(),
  event_id     uuid not null references events(id) on delete cascade,
  actor_id     uuid references users(id) on delete set null,
  action       text not null,
  target_type  text,
  target_id    uuid,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index event_audit_event_created on event_audit_logs(event_id, created_at desc, id desc);

-- ── Notifications ──────────────────────────────────────────────
create table event_notification_prefs (
  event_id     uuid not null references events(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  expenses     boolean not null default true,
  members      boolean not null default false,
  settlements  boolean not null default true,
  chat         boolean not null default true,
  primary key (event_id, user_id)
);

-- Enforces "1 reminder/request per pair per 24 h".
create table event_reminders (
  id         uuid primary key default uuid_generate_v4(),
  event_id   uuid not null references events(id) on delete cascade,
  from_user  uuid not null references users(id) on delete cascade,
  to_user    uuid not null references users(id) on delete cascade,
  kind       text not null check (kind in ('remind', 'request')),
  sent_at    timestamptz not null default now()
);

create index event_reminders_pair on event_reminders(event_id, from_user, to_user, sent_at desc);

create table device_tokens (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  platform    text not null default 'android' check (platform in ('android', 'ios')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index device_tokens_user on device_tokens(user_id);

-- ── Payment profile (set once, reused across events) ──────────
create table user_payment_profiles (
  user_id     uuid primary key references users(id) on delete cascade,
  -- (Postgres regex repetition is capped at 255, so length is a separate check)
  upi_id      text not null check (char_length(upi_id) between 5 and 256 and upi_id ~ '^[a-z0-9._-]+@[a-z0-9.-]+$'),
  updated_at  timestamptz not null default now()
);
