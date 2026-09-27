create table events (
 id uuid primary key default uuid_generate_v4(), owner_id uuid not null references users(id),
 title text not null, event_date date not null, budget_paise integer not null check(budget_paise > 0),
 status text not null default 'active' check(status in ('active','completed')), created_at timestamptz not null default now()
);
create table event_members (
 event_id uuid not null references events(id) on delete cascade, user_id uuid not null references users(id),
 joined_at timestamptz not null default now(), primary key(event_id,user_id)
);
create index event_members_user on event_members(user_id);
create table event_invites (
 token_hash text primary key, event_id uuid not null references events(id) on delete cascade,
 expires_at timestamptz not null default now() + interval '7 days'
);
create table event_expenses (
 id uuid primary key, event_id uuid not null references events(id) on delete cascade,
 created_by uuid not null references users(id), paid_by uuid not null references users(id),
 title text not null, category text not null, amount_paise integer not null check(amount_paise > 0),
 expense_date date not null, splits jsonb not null, created_at timestamptz not null default now()
);
create index event_expenses_event on event_expenses(event_id);
create table event_settlements (
 id uuid primary key, event_id uuid not null references events(id) on delete cascade,
 from_user uuid not null references users(id), to_user uuid not null references users(id),
 amount_paise integer not null check(amount_paise > 0), confirmed boolean not null default false,
 created_at timestamptz not null default now(), check(from_user <> to_user)
);
create index event_settlements_event on event_settlements(event_id);
