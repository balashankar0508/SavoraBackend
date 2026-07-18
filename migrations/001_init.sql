-- ══════════════════════════════════════════════════════════════
-- Savora Database Schema — standalone Postgres (no Supabase)
-- Ported from the app's former supabase/schema.sql: RLS and the
-- auth.users FK are removed; `users` is now the root identity
-- table and owns its own password_hash. Authorization moves to
-- the application layer (every query filters by user_id).
-- ══════════════════════════════════════════════════════════════

create extension if not exists "uuid-ossp";

-- ── Users ─────────────────────────────────────────────────────
create table if not exists users (
  id             uuid primary key default uuid_generate_v4(),
  name           text not null,
  email          text not null unique,
  password_hash  text not null,
  email_verified boolean not null default false,
  created_at     timestamptz not null default now()
);

-- ── Transactions ───────────────────────────────────────────────
create table if not exists transactions (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references users(id) on delete cascade,
  type              text not null check (type in ('income', 'expense')),
  amount            numeric(12, 2) not null check (amount > 0),
  category          text not null,
  notes             text,
  transaction_date  date not null default current_date,
  merchant_name     text,
  source            text not null default 'manual' check (source in ('manual', 'upi_import', 'voice')),
  created_at        timestamptz not null default now()
);

create index if not exists idx_transactions_user_date on transactions(user_id, transaction_date desc);
create index if not exists idx_transactions_user_type on transactions(user_id, type);
create index if not exists idx_transactions_category  on transactions(user_id, category);

-- ── Goals ──────────────────────────────────────────────────────
create table if not exists goals (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id) on delete cascade,
  title           text not null,
  target_amount   numeric(12, 2) not null check (target_amount > 0),
  current_amount  numeric(12, 2) not null default 0 check (current_amount >= 0),
  target_date     date not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_goals_user on goals(user_id);

-- ── Subscriptions ─────────────────────────────────────────────
create table if not exists subscriptions (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null unique references users(id) on delete cascade,
  plan         text not null default 'free' check (plan in ('free', 'monthly', 'yearly')),
  status       text not null default 'active' check (status in ('active', 'expired', 'cancelled')),
  tier         text not null default 'free' check (tier in ('free', 'premium', 'premium_plus', 'ultimate')),
  expiry_date  date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Auto-insert a free subscription on user creation, kept as a DB trigger
-- (not app code) so every user gets one regardless of code path, and so
-- this remains the *only* place that ever writes a subscriptions row on
-- signup. 'ultimate' is granted manually via direct SQL only — no app
-- code path may ever set tier='ultimate'.
create or replace function handle_new_user_subscription()
returns trigger language plpgsql as $$
begin
  insert into subscriptions (user_id, plan, status, tier)
  values (new.id, 'free', 'active', 'free')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_user_created_subscription on users;
create trigger on_user_created_subscription
  after insert on users
  for each row execute procedure handle_new_user_subscription();

-- ── AI receipt-parsing quota (daily, per user) ──────────────────
create table if not exists ai_usage (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references users(id) on delete cascade,
  usage_date  date not null default current_date,
  count       int not null default 0,
  unique (user_id, usage_date)
);

-- Atomically checks + increments today's AI usage against a tier's daily
-- limit, in one statement (avoids a check-then-increment race between
-- concurrent requests). p_daily_limit: -1 = unlimited, 0 = blocked.
-- Returns true if the call is allowed (and was just counted).
create or replace function try_consume_ai_quota(p_user_id uuid, p_daily_limit int)
returns boolean
language plpgsql
as $$
declare
  new_count int;
begin
  if p_daily_limit < 0 then
    return true;
  end if;
  if p_daily_limit = 0 then
    return false;
  end if;

  insert into ai_usage (user_id, usage_date, count)
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update set count = ai_usage.count + 1
  where ai_usage.count < p_daily_limit
  returning count into new_count;

  return new_count is not null;
end;
$$;
