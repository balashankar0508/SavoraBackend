alter table events add column if not exists event_type text not null default 'custom';
alter table events add column if not exists location text;
alter table events add column if not exists cover_emoji text not null default '🎉';
alter table events add column if not exists updated_at timestamptz not null default now();

alter table event_members add column if not exists role text not null default 'member'
  check (role in ('owner', 'member'));
update event_members m set role = 'owner'
from events e where m.event_id = e.id and m.user_id = e.owner_id;

create table if not exists event_budget_categories (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  budget_paise integer not null check (budget_paise >= 0),
  icon text not null default '•',
  color text not null default '#6259D9',
  unique(event_id, name)
);
create index if not exists event_budget_categories_event on event_budget_categories(event_id);

alter table event_expenses add column if not exists notes text;
alter table event_expenses add column if not exists expense_time text;
alter table event_expenses add column if not exists payment_method text not null default 'other';
alter table event_expenses add column if not exists receipt_name text;
alter table event_expenses add column if not exists receipt_mime text;
alter table event_expenses add column if not exists receipt_data text;
alter table event_expenses add column if not exists updated_at timestamptz not null default now();

alter table event_settlements add column if not exists payment_method text not null default 'other';
alter table event_settlements add column if not exists confirmed_at timestamptz;

create table if not exists event_messages (
  id uuid primary key,
  event_id uuid not null references events(id) on delete cascade,
  sender_id uuid not null references users(id),
  ciphertext text not null,
  nonce text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists event_messages_event_created
  on event_messages(event_id, created_at desc, id desc);

create table if not exists event_reactions (
  message_id uuid not null references event_messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key(message_id, user_id, emoji)
);

create table if not exists event_activity (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  kind text not null,
  summary text not null,
  amount_paise integer,
  created_at timestamptz not null default now()
);
create index if not exists event_activity_event_created
  on event_activity(event_id, created_at desc);
