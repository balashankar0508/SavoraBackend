alter table events add column if not exists end_date date;
alter table events add column if not exists currency text not null default 'INR';
alter table events add column if not exists description text;
alter table events add column if not exists join_policy text not null default 'code_join';
alter table events add column if not exists archived_at timestamptz;
alter table events drop constraint if exists events_status_check;
alter table events add constraint events_status_check check(status in ('active','completed','archived'));
alter table events add constraint events_currency_check check(currency ~ '^[A-Z]{3}$');
alter table events add constraint events_join_policy_check check(join_policy in ('admin_only','code_join','code_request_approval'));

alter table event_members add column if not exists status text not null default 'active';
alter table event_members add column if not exists invited_by uuid references users(id) on delete set null;
alter table event_members add column if not exists removed_at timestamptz;
alter table event_members add column if not exists updated_at timestamptz not null default now();
alter table event_members drop constraint if exists event_members_role_check;
alter table event_members add constraint event_members_role_check check(role in ('owner','admin','member'));
alter table event_members add constraint event_members_status_check check(status in ('invited','active','removed','left'));
create unique index if not exists event_members_one_owner on event_members(event_id) where role='owner' and status='active';
create index if not exists event_members_event_status on event_members(event_id,status);

alter table event_expenses add column if not exists status text not null default 'active';
alter table event_expenses add column if not exists voided_at timestamptz;
alter table event_expenses add column if not exists voided_by uuid references users(id) on delete set null;
alter table event_expenses add constraint event_expenses_status_check check(status in ('active','voided'));
create index if not exists event_expenses_event_status_created on event_expenses(event_id,status,created_at desc);
create index if not exists event_expenses_paid_by on event_expenses(paid_by);

create table if not exists event_audit_logs (
  id uuid primary key default uuid_generate_v4(),
  event_id uuid not null references events(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  action text not null,
  target_type text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists event_audit_event_created on event_audit_logs(event_id,created_at desc,id desc);

create index if not exists events_owner on events(owner_id);
create index if not exists events_status on events(status);
create index if not exists event_settlements_from_user on event_settlements(from_user);
create index if not exists event_settlements_to_user on event_settlements(to_user);

alter table event_messages add column if not exists deleted_at timestamptz;
alter table event_messages add column if not exists deleted_by uuid references users(id) on delete set null;
