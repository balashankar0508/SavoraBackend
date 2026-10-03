import { randomUUID } from 'crypto';
import { z } from 'zod';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { logger } from '../../../lib/logger';
import { deleteEventFiles } from '../../files/files.service';
import { assertCan } from '../access/denial';
import { withEventLock, withTransaction } from '../access/lock';
import { listPermissions } from '../access/policy';
import { EventContext } from '../access/types';
import { createInviteCode } from '../invitations/invitations.service';
import { computeEventStats, computePairwise, isFullySettled } from '../ledger';
import { logActivity, logAudit, postSystemMessage } from '../shared/audit';
import { emitDomainEvent } from '../shared/domainEvents';
import { balancesOf, loadLedgerState, loadNames, suggestionsOf } from '../shared/ledgerState';
import { likePattern } from '../shared/schemas';
import {
  createEventSchema, duplicateEventSchema, listEventsQuerySchema, updateEventSchema, updateSettingsSchema,
} from './events.schemas';

export const EVENT_COLUMNS = `id, owner_id, title, event_type, description, location,
  start_date::text as start_date, end_date::text as end_date, currency, budget_paise, status,
  join_policy, allow_member_expenses, members_edit_others, completed_at, archived_at, created_at, updated_at`;

const todayISO = () => new Date().toISOString().slice(0, 10);
const pct = (part: number, whole: number | null) => (whole ? Math.round((part * 100) / whole) : null);

// ── list ────────────────────────────────────────────────────────

export async function listEvents(userId: string, query: z.infer<typeof listEventsQuerySchema>) {
  const statuses = query.status ? [query.status] : ['active', 'completed'];
  const { rows } = await pool.query(
    `select e.id, e.title, e.event_type, e.location, e.start_date::text as start_date, e.end_date::text as end_date,
            e.budget_paise, e.status, e.currency, e.created_at, m.role as my_role,
            coalesce((select sum(x.amount_paise) from event_expenses x where x.event_id = e.id and x.status = 'active'), 0) as spent_paise,
            (select count(*) from event_members mm where mm.event_id = e.id and mm.status = 'active') as member_count,
            (select count(*) from event_settlements s where s.event_id = e.id and s.status = 'pending_confirmation'
                and (s.from_user = $1 or s.to_user = $1)) as pending_settlements
       from events e
       join event_members m on m.event_id = e.id and m.user_id = $1 and m.status = 'active'
      where e.status = any($2::text[])
        and ($3::text is null or e.title ilike $3 escape '\\' or e.location ilike $3 escape '\\')
      order by (e.status = 'active') desc, e.start_date desc, e.created_at desc
      limit $4`,
    [userId, statuses, query.q ? likePattern(query.q) : null, query.limit],
  );

  const events = rows.map(r => ({
    ...r,
    progress_pct: pct(r.spent_paise, r.budget_paise),
    remaining_paise: r.budget_paise === null ? null : r.budget_paise - r.spent_paise,
  }));
  const summary = {
    total_spent_paise: events.reduce((n, e) => n + e.spent_paise, 0),
    active_budget_paise: events.filter(e => e.status === 'active').reduce((n, e) => n + (e.budget_paise ?? 0), 0),
    pending_settlements: events.reduce((n, e) => n + e.pending_settlements, 0),
    active_count: events.filter(e => e.status === 'active').length,
    completed_count: events.filter(e => e.status === 'completed').length,
  };
  return { events, summary };
}

// ── create / duplicate ──────────────────────────────────────────

export async function createEvent(userId: string, input: z.infer<typeof createEventSchema>) {
  const endDate = input.end_date ?? input.start_date;
  const event = await withTransaction(async client => {
    // serialises retries of the same client id before the row exists
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.id]);

    const previous = (await client.query(`select ${EVENT_COLUMNS} from events where id = $1`, [input.id])).rows[0];
    if (previous) {
      const same =
        previous.owner_id === userId && previous.title === input.title && previous.event_type === input.event_type &&
        previous.start_date === input.start_date && previous.end_date === endDate &&
        (previous.location ?? '') === (input.location ?? '') && (previous.description ?? '') === (input.description ?? '') &&
        previous.budget_paise === (input.budget_paise ?? null) && previous.join_policy === input.join_policy;
      if (same) return previous; // a retry of a create that already succeeded
      throw new HttpError(409, 'duplicate_id');
    }

    await client.query(
      `insert into events (id, owner_id, title, event_type, description, location, start_date, end_date, budget_paise,
                           join_policy, allow_member_expenses, members_edit_others)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [input.id, userId, input.title, input.event_type, input.description ?? null, input.location ?? null,
        input.start_date, endDate, input.budget_paise ?? null, input.join_policy, input.allow_member_expenses, input.members_edit_others],
    );
    await client.query("insert into event_members (event_id, user_id, role, status, joined_at) values ($1, $2, 'owner', 'active', now())", [input.id, userId]);
    await createInviteCode(client, input.id, userId);
    await logActivity(client, { eventId: input.id, actorId: userId, kind: 'event_created', summary: `Created ${input.title}` });
    await logAudit(client, { eventId: input.id, actorId: userId, action: 'EVENT_CREATED' });
    return (await client.query(`select ${EVENT_COLUMNS} from events where id = $1`, [input.id])).rows[0];
  });
  emitDomainEvent({ type: 'event.created', eventId: event.id, actorId: userId });
  return event;
}

export async function duplicateEvent(eventId: string, userId: string, input: z.infer<typeof duplicateEventSchema>) {
  const copy = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'event.duplicate');
    const src = (await client.query(`select ${EVENT_COLUMNS} from events where id = $1`, [eventId])).rows[0];

    // keep the original length unless the caller picks dates
    const startDate: string = input.start_date ?? src.start_date;
    const days = Math.round((Date.parse(src.end_date) - Date.parse(src.start_date)) / 86_400_000);
    const endDate: string = input.end_date ?? new Date(Date.parse(startDate) + days * 86_400_000).toISOString().slice(0, 10);

    const id = randomUUID();
    await client.query(
      `insert into events (id, owner_id, title, event_type, description, location, start_date, end_date, budget_paise,
                           join_policy, allow_member_expenses, members_edit_others)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, userId, `${String(src.title).slice(0, 90)} (copy)`, src.event_type, src.description, src.location, startDate, endDate,
        src.budget_paise, src.join_policy, src.allow_member_expenses, src.members_edit_others],
    );
    await client.query("insert into event_members (event_id, user_id, role, status, joined_at) values ($1, $2, 'owner', 'active', now())", [id, userId]);
    await createInviteCode(client, id, userId);
    await logActivity(client, { eventId: id, actorId: userId, kind: 'event_created', summary: `Created ${src.title} (copy)` });
    await logAudit(client, { eventId: id, actorId: userId, action: 'EVENT_CREATED', metadata: { duplicated_from: eventId } });
    return (await client.query(`select ${EVENT_COLUMNS} from events where id = $1`, [id])).rows[0];
  });
  emitDomainEvent({ type: 'event.created', eventId: copy.id, actorId: userId });
  return copy;
}

// ── read ────────────────────────────────────────────────────────

/** The dashboard payload: light by design (no file bodies, only recent items). */
export async function getEventDetail(ctx: EventContext) {
  const eventId = ctx.event.id;
  const state = await loadLedgerState(pool, eventId);
  const balances = balancesOf(state);

  const [event, members, recent, requests] = await Promise.all([
    pool.query(`select ${EVENT_COLUMNS} from events where id = $1`, [eventId]),
    pool.query(
      `select m.user_id as id, u.name, m.role, m.joined_at,
              coalesce((select sum(x.amount_paise) from event_expenses x
                         where x.event_id = m.event_id and x.paid_by = m.user_id and x.status = 'active'), 0) as paid_paise
         from event_members m join users u on u.id = m.user_id
        where m.event_id = $1 and m.status = 'active'
        order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.joined_at, m.user_id`,
      [eventId],
    ),
    pool.query(
      `select e.id, e.title, e.category, e.amount_paise, e.expense_date::text as expense_date, e.expense_time,
              e.paid_by, u.name as paid_by_name, e.created_at,
              (select s.share_paise from event_expense_shares s where s.expense_id = e.id and s.user_id = $2) as my_share_paise
         from event_expenses e join users u on u.id = e.paid_by
        where e.event_id = $1 and e.status = 'active'
        order by e.expense_date desc, e.created_at desc, e.id desc limit 5`,
      [eventId, ctx.userId],
    ),
    ctx.role === 'member'
      ? Promise.resolve({ rows: [{ n: null }] })
      : pool.query("select count(*)::int as n from event_members where event_id = $1 and status = 'pending'", [eventId]),
  ]);

  const names = new Map(members.rows.map(m => [m.id as string, m.name as string]));
  const row = event.rows[0];
  const stats = computeEventStats({
    budget_paise: row.budget_paise, memberIds: state.memberIds, expenses: state.expenses, window: 'all', today: todayISO(),
  });

  const pairwise = computePairwise(ctx.userId, state.expenses, state.settlements);
  const pending = state.settlements.filter(s => s.status === 'pending_confirmation');
  const suggestions = suggestionsOf(state).map(t => ({
    ...t, from_name: names.get(t.from) ?? null, to_name: names.get(t.to) ?? null,
  }));

  return {
    event: row,
    me: { user_id: ctx.userId, role: ctx.role },
    permissions: listPermissions(ctx),
    stats: {
      spent_paise: stats.total_spent_paise,
      remaining_paise: stats.remaining_paise,
      budget_used_pct: stats.budget_used_pct,
      member_count: state.memberIds.length,
      expense_count: stats.expense_count,
      per_person_paise: stats.per_person_paise,
    },
    members: members.rows,
    recent_expenses: recent.rows,
    balances: {
      me: {
        net_paise: balances[ctx.userId] ?? 0,
        paid_paise: members.rows.find(m => m.id === ctx.userId)?.paid_paise ?? 0,
        you_owe_paise: pairwise.you_owe_paise,
        owed_paise: pairwise.owed_paise,
      },
      items: Object.entries(balances)
        .filter(([id]) => names.has(id))
        .map(([user_id, balance_paise]) => ({ user_id, balance_paise })),
      suggestions: suggestions.filter(s => s.from === ctx.userId || s.to === ctx.userId),
      settled: isFullySettled(balances),
    },
    settlements: {
      pending_count: pending.length,
      awaiting_my_confirmation: pending.filter(s => s.to_user === ctx.userId).length,
      my_pending_payments: pending.filter(s => s.from_user === ctx.userId).length,
      all_settled: isFullySettled(balances) && pending.length === 0,
    },
    pending_requests_count: requests.rows[0].n,
  };
}

// ── edit ────────────────────────────────────────────────────────

export async function updateEvent(eventId: string, userId: string, input: z.infer<typeof updateEventSchema>) {
  return withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'event.edit');
    const before = (await client.query(`select ${EVENT_COLUMNS} from events where id = $1`, [eventId])).rows[0];

    const start = input.start_date ?? before.start_date;
    const end = input.end_date ?? before.end_date;
    if (end < start) throw new HttpError(400, 'end_date_before_start_date');

    const columns = Object.keys(input) as (keyof typeof input)[];
    const sets = columns.map((c, i) => `${c} = $${i + 2}`);
    const { rows } = await client.query(
      `update events set ${sets.join(', ')}, updated_at = now() where id = $1 returning ${EVENT_COLUMNS}`,
      [eventId, ...columns.map(c => input[c] ?? null)],
    );
    const changed = Object.fromEntries(columns.map(c => [c, { from: before[c] ?? null, to: rows[0][c] ?? null }]));
    await logAudit(client, { eventId, actorId: userId, action: 'EVENT_UPDATED', metadata: { changed } });
    await logActivity(client, { eventId, actorId: userId, kind: 'event_updated', summary: 'Updated event details' });
    return rows[0];
  });
}

export async function updateSettings(eventId: string, userId: string, input: z.infer<typeof updateSettingsSchema>) {
  return withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'settings.edit');
    const columns = Object.keys(input) as (keyof typeof input)[];
    const { rows } = await client.query(
      `update events set ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
        where id = $1 returning ${EVENT_COLUMNS}`,
      [eventId, ...columns.map(c => input[c])],
    );
    const changed = Object.fromEntries(columns.map(c => [c, { from: ctx.event[c], to: input[c] }]));
    await logAudit(client, { eventId, actorId: userId, action: 'SETTINGS_UPDATED', metadata: { changed } });
    return rows[0];
  });
}

// ── lifecycle ───────────────────────────────────────────────────

export async function completeEvent(eventId: string, userId: string) {
  const event = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'event.complete');
    const state = await loadLedgerState(client, eventId);
    if (state.settlements.some(s => s.status === 'pending_confirmation')) throw new HttpError(409, 'pending_settlements_exist');
    if (!isFullySettled(balancesOf(state))) throw new HttpError(409, 'settle_balances_first');

    const { rows } = await client.query(
      `update events set status = 'completed', completed_at = now(), updated_at = now() where id = $1 returning ${EVENT_COLUMNS}`,
      [eventId],
    );
    await logActivity(client, { eventId, actorId: userId, kind: 'event_completed', summary: 'Completed the event' });
    await logAudit(client, { eventId, actorId: userId, action: 'EVENT_COMPLETED' });
    await postSystemMessage(client, eventId, { type: 'event_completed', actor_id: userId });
    return rows[0];
  });
  emitDomainEvent({ type: 'event.completed', eventId, actorId: userId });
  return event;
}

export async function reopenEvent(eventId: string, userId: string) {
  const event = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'event.reopen');
    const { rows } = await client.query(
      `update events set status = 'active', completed_at = null, updated_at = now() where id = $1 returning ${EVENT_COLUMNS}`,
      [eventId],
    );
    await logActivity(client, { eventId, actorId: userId, kind: 'event_reopened', summary: 'Reopened the event' });
    await logAudit(client, { eventId, actorId: userId, action: 'EVENT_REOPENED' });
    await postSystemMessage(client, eventId, { type: 'event_reopened', actor_id: userId });
    return rows[0];
  });
  emitDomainEvent({ type: 'event.reopened', eventId, actorId: userId });
  return event;
}

export async function archiveEvent(eventId: string, userId: string) {
  const event = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'event.archive');
    const { rows } = await client.query(
      `update events set status = 'archived', archived_at = now(), updated_at = now() where id = $1 returning ${EVENT_COLUMNS}`,
      [eventId],
    );
    await logActivity(client, { eventId, actorId: userId, kind: 'event_archived', summary: 'Archived the event' });
    await logAudit(client, { eventId, actorId: userId, action: 'EVENT_ARCHIVED' });
    return rows[0];
  });
  emitDomainEvent({ type: 'event.archived', eventId, actorId: userId });
  return event;
}

/** Permanently erases the event and everything in it (rows cascade; stored files are removed after commit). */
export async function deleteEvent(eventId: string, userId: string) {
  const { title, memberIds } = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'event.delete');
    const members = await client.query("select user_id from event_members where event_id = $1 and status = 'active'", [eventId]);
    await client.query('delete from events where id = $1', [eventId]);
    return { title: ctx.event.title as string, memberIds: members.rows.map(r => r.user_id as string) };
  });
  // the event is already gone; a failure here only leaves orphaned bytes to clean up
  await deleteEventFiles(eventId).catch(err => logger.error({ err, eventId }, 'failed to remove files of deleted event'));
  emitDomainEvent({ type: 'event.deleted', eventId, actorId: userId, title, memberIds });
  return { ok: true };
}

export async function transferOwnership(eventId: string, userId: string, newOwnerId: string) {
  return withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'ownership.transfer');
    if (newOwnerId === userId) throw new HttpError(400, 'already_owner');
    const target = await client.query(
      "select role from event_members where event_id = $1 and user_id = $2 and status = 'active' for update",
      [eventId, newOwnerId],
    );
    if (!target.rows[0]) throw new HttpError(404, 'active_member_not_found');

    // order matters: a unique index allows only one active owner at any moment
    await client.query("update event_members set role = 'member' where event_id = $1 and user_id = $2", [eventId, userId]);
    await client.query("update event_members set role = 'owner' where event_id = $1 and user_id = $2", [eventId, newOwnerId]);
    await client.query('update events set owner_id = $2, updated_at = now() where id = $1', [eventId, newOwnerId]);

    const name = (await loadNames(client, [newOwnerId])).get(newOwnerId) ?? 'a member';
    await logActivity(client, { eventId, actorId: userId, kind: 'ownership_transferred', summary: `Transferred ownership to ${name}` });
    await logAudit(client, {
      eventId, actorId: userId, action: 'OWNER_TRANSFERRED', targetType: 'member', targetId: newOwnerId,
      metadata: { previous_owner_id: userId },
    });
    return { ok: true };
  });
}
