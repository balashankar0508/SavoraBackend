-- Goal contribution history, previously kept only in the app's local storage.
create table if not exists goal_contributions (
  id                 uuid primary key default uuid_generate_v4(),
  goal_id            uuid not null references goals(id) on delete cascade,
  user_id            uuid not null references users(id) on delete cascade,
  amount             numeric(12, 2) not null check (amount > 0),
  note               text,
  contribution_date  date not null default current_date,
  created_at         timestamptz not null default now()
);

create index if not exists idx_goal_contributions_goal
  on goal_contributions(goal_id, contribution_date desc, created_at desc);
