alter table events add column if not exists settlement_requires_approval boolean not null default true;

alter table event_members add column if not exists payment_upi_id text;

alter table event_settlements add column if not exists status text not null default 'pending_payment';
alter table event_settlements add column if not exists proof_name text;
alter table event_settlements add column if not exists proof_mime text;
alter table event_settlements add column if not exists proof_data text;
alter table event_settlements add column if not exists proof_submitted_at timestamptz;
alter table event_settlements add column if not exists reviewed_by uuid references users(id) on delete set null;
alter table event_settlements add column if not exists reviewed_at timestamptz;
alter table event_settlements add column if not exists rejection_reason text;

update event_settlements
set status = case when confirmed then 'completed' else 'pending_payment' end
where status is null or status = 'pending_payment';

alter table event_settlements drop constraint if exists event_settlements_status_check;
alter table event_settlements add constraint event_settlements_status_check
  check (status in ('pending_payment', 'pending_approval', 'completed', 'rejected', 'cancelled'));

create index if not exists event_settlements_event_status
  on event_settlements(event_id, status, created_at desc);
