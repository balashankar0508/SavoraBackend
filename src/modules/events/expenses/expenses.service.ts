import { z } from 'zod';
import { PoolClient } from 'pg';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { assertFileAttachable } from '../../files/files.service';
import { assertCan } from '../access/denial';
import { withEventLock } from '../access/lock';
import { EventContext } from '../access/types';
import { assertLedgerConsistent, splitExpense } from '../ledger';
import { logActivity, logAudit, postSystemMessage } from '../shared/audit';
import { emitDomainEvent } from '../shared/domainEvents';
import { loadLedgerState } from '../shared/ledgerState';
import { likePattern } from '../shared/schemas';
import { createExpenseSchema, listExpensesQuerySchema, updateExpenseSchema } from './expenses.schemas';

interface ShareRow { user_id: string; name: string; share_paise: number; input_value: number | null }

const EXPENSE_SELECT = `
  select e.id, e.event_id, e.created_by, e.paid_by, pu.name as paid_by_name, e.title, e.category, e.amount_paise,
         e.expense_date::text as expense_date, e.expense_time, e.notes, e.split_mode, e.receipt_file_id, e.status,
         e.version, e.created_at, e.updated_at
    from event_expenses e join users pu on pu.id = e.paid_by`;

/** One expense with its shares, shaped for the app. */
export async function fetchExpense(db: Pick<PoolClient, 'query'>, eventId: string, expenseId: string, viewerId: string) {
  const { rows } = await db.query(`${EXPENSE_SELECT} where e.id = $1 and e.event_id = $2`, [expenseId, eventId]);
  if (!rows[0]) throw new HttpError(404, 'expense_not_found');
  const shares: ShareRow[] = (
    await db.query(
      `select s.user_id, u.name, s.share_paise, s.input_value
         from event_expense_shares s join users u on u.id = s.user_id
        where s.expense_id = $1 order by u.name, s.user_id`,
      [expenseId],
    )
  ).rows;
  return { ...rows[0], shares, my_share_paise: shares.find(s => s.user_id === viewerId)?.share_paise ?? 0 };
}

/** Payer and everyone in the split must be ACTIVE members: a removed or pending
 * user can never be put on the books. */
async function assertParticipants(client: PoolClient, eventId: string, paidBy: string, userIds: string[]) {
  const { rows } = await client.query("select user_id from event_members where event_id = $1 and status = 'active'", [eventId]);
  const active = new Set(rows.map(r => r.user_id as string));
  if (!active.has(paidBy) || userIds.some(id => !active.has(id))) throw new HttpError(400, 'invalid_member');
}

async function writeShares(client: PoolClient, expenseId: string, shares: { user_id: string; share_paise: number; input_value: number | null }[]) {
  await client.query(
    `insert into event_expense_shares (expense_id, user_id, share_paise, input_value)
     select $1, * from unnest($2::uuid[], $3::int[], $4::int[])`,
    [expenseId, shares.map(s => s.user_id), shares.map(s => s.share_paise), shares.map(s => s.input_value)],
  );
}

async function assertLedgerStillBalanced(client: PoolClient, eventId: string) {
  const state = await loadLedgerState(client, eventId);
  assertLedgerConsistent(state);
}

// ── create ──────────────────────────────────────────────────────

export async function createExpense(eventId: string, userId: string, input: z.infer<typeof createExpenseSchema>) {
  const result = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'expense.create');
    await assertParticipants(client, eventId, input.paid_by, input.splits.map(s => s.user_id));
    const shares = splitExpense(input.amount_paise, input.split_mode, input.splits);

    // Idempotency: a retry with the same id and same content returns the original.
    const previous = (await client.query('select event_id, created_by from event_expenses where id = $1', [input.id])).rows[0];
    if (previous) {
      if (previous.event_id !== eventId || previous.created_by !== userId) throw new HttpError(409, 'duplicate_id');
      const existing = await fetchExpense(client, eventId, input.id, userId);
      const sameShares =
        existing.shares.length === shares.length &&
        shares.every(s => existing.shares.some((e: ShareRow) => e.user_id === s.user_id && e.share_paise === s.share_paise));
      const same =
        existing.title === input.title && existing.category === input.category && existing.amount_paise === input.amount_paise &&
        existing.expense_date === input.expense_date && existing.paid_by === input.paid_by && existing.split_mode === input.split_mode && sameShares;
      if (!same) throw new HttpError(409, 'duplicate_id');
      return { expense: existing, created: false };
    }

    if (input.receipt_file_id) await assertFileAttachable(client, input.receipt_file_id, eventId, userId, 'receipt');

    await client.query(
      `insert into event_expenses (id, event_id, created_by, paid_by, title, category, amount_paise, expense_date, expense_time,
                                   notes, split_mode, receipt_file_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [input.id, eventId, userId, input.paid_by, input.title, input.category, input.amount_paise, input.expense_date,
        input.expense_time ?? null, input.notes ?? null, input.split_mode, input.receipt_file_id ?? null],
    );
    await writeShares(client, input.id, shares);

    const actor = (await client.query('select name from users where id = $1', [userId])).rows[0].name as string;
    await logActivity(client, { eventId, actorId: userId, kind: 'expense_added', summary: `Added ${input.title}`, amountPaise: input.amount_paise });
    await logAudit(client, { eventId, actorId: userId, action: 'EXPENSE_CREATED', targetType: 'expense', targetId: input.id });
    await postSystemMessage(client, eventId, {
      type: 'expense_added', expense_id: input.id, title: input.title, amount_paise: input.amount_paise, actor_id: userId, actor_name: actor,
    });
    await assertLedgerStillBalanced(client, eventId);
    return { expense: await fetchExpense(client, eventId, input.id, userId), created: true };
  });
  if (result.created) {
    emitDomainEvent({ type: 'expense.added', eventId, actorId: userId, expenseId: input.id, title: input.title, amountPaise: input.amount_paise });
  }
  return result;
}

// ── update ──────────────────────────────────────────────────────

export async function updateExpense(eventId: string, userId: string, expenseId: string, input: z.infer<typeof updateExpenseSchema>) {
  const expense = await withEventLock(eventId, userId, async (client, ctx) => {
    const current = (
      await client.query('select id, created_by, status, version, receipt_file_id from event_expenses where id = $1 and event_id = $2 for update', [expenseId, eventId])
    ).rows[0];
    if (!current) throw new HttpError(404, 'expense_not_found');
    assertCan(ctx, 'expense.edit', { created_by: current.created_by });
    if (current.status !== 'active') throw new HttpError(409, 'expense_voided');
    if (input.version !== undefined && input.version !== current.version) throw new HttpError(409, 'version_conflict');

    await assertParticipants(client, eventId, input.paid_by, input.splits.map(s => s.user_id));
    const shares = splitExpense(input.amount_paise, input.split_mode, input.splits);

    let receipt: string | null = current.receipt_file_id;
    if (input.receipt_file_id === null) receipt = null;
    else if (input.receipt_file_id !== undefined && input.receipt_file_id !== current.receipt_file_id) {
      await assertFileAttachable(client, input.receipt_file_id, eventId, userId, 'receipt');
      receipt = input.receipt_file_id;
    }

    const before = await fetchExpense(client, eventId, expenseId, userId);
    await client.query(
      `update event_expenses
          set paid_by = $3, title = $4, category = $5, amount_paise = $6, expense_date = $7, expense_time = $8,
              notes = $9, split_mode = $10, receipt_file_id = $11, version = version + 1, updated_at = now()
        where id = $1 and event_id = $2`,
      [expenseId, eventId, input.paid_by, input.title, input.category, input.amount_paise, input.expense_date,
        input.expense_time ?? null, input.notes ?? null, input.split_mode, receipt],
    );
    await client.query('delete from event_expense_shares where expense_id = $1', [expenseId]);
    await writeShares(client, expenseId, shares);

    const actor = (await client.query('select name from users where id = $1', [userId])).rows[0].name as string;
    await logActivity(client, { eventId, actorId: userId, kind: 'expense_updated', summary: `Updated ${input.title}`, amountPaise: input.amount_paise });
    await logAudit(client, {
      eventId, actorId: userId, action: 'EXPENSE_UPDATED', targetType: 'expense', targetId: expenseId,
      metadata: {
        previous: {
          title: before.title, category: before.category, amount_paise: before.amount_paise, expense_date: before.expense_date,
          paid_by: before.paid_by, split_mode: before.split_mode,
          shares: before.shares.map((s: ShareRow) => ({ user_id: s.user_id, share_paise: s.share_paise })),
        },
        amount_paise: input.amount_paise,
      },
    });
    await postSystemMessage(client, eventId, {
      type: 'expense_updated', expense_id: expenseId, title: input.title, amount_paise: input.amount_paise, actor_id: userId, actor_name: actor,
    });
    await assertLedgerStillBalanced(client, eventId);
    return fetchExpense(client, eventId, expenseId, userId);
  });
  emitDomainEvent({ type: 'expense.updated', eventId, actorId: userId, expenseId, title: expense.title, amountPaise: expense.amount_paise });
  return { expense };
}

// ── void ────────────────────────────────────────────────────────

/** "Delete" in the app: the expense is voided, never erased, so the audit trail
 * and every member's history stay intact. */
export async function voidExpense(eventId: string, userId: string, expenseId: string) {
  const voided = await withEventLock(eventId, userId, async (client, ctx) => {
    const current = (
      await client.query('select id, created_by, status, title, amount_paise from event_expenses where id = $1 and event_id = $2 for update', [expenseId, eventId])
    ).rows[0];
    if (!current) throw new HttpError(404, 'expense_not_found');
    assertCan(ctx, 'expense.void', { created_by: current.created_by });
    if (current.status === 'voided') return null; // already done: a retry is a success

    await client.query("update event_expenses set status = 'voided', voided_at = now(), voided_by = $2, updated_at = now() where id = $1", [expenseId, userId]);
    const actor = (await client.query('select name from users where id = $1', [userId])).rows[0].name as string;
    await logActivity(client, { eventId, actorId: userId, kind: 'expense_voided', summary: `Removed ${current.title}`, amountPaise: current.amount_paise });
    await logAudit(client, { eventId, actorId: userId, action: 'EXPENSE_VOIDED', targetType: 'expense', targetId: expenseId, metadata: { amount_paise: current.amount_paise } });
    await postSystemMessage(client, eventId, {
      type: 'expense_voided', expense_id: expenseId, title: current.title, amount_paise: current.amount_paise, actor_id: userId, actor_name: actor,
    });
    await assertLedgerStillBalanced(client, eventId);
    return { title: current.title as string, amount: current.amount_paise as number };
  });
  if (voided) emitDomainEvent({ type: 'expense.voided', eventId, actorId: userId, expenseId, title: voided.title, amountPaise: voided.amount });
  return { ok: true };
}

// ── read ────────────────────────────────────────────────────────

export async function getExpense(ctx: EventContext, expenseId: string) {
  const expense = await fetchExpense(pool, ctx.event.id, expenseId, ctx.userId);
  if (expense.status !== 'active') throw new HttpError(404, 'expense_not_found');
  return { expense };
}

const encodeCursor = (date: string, ts: string, id: string) => Buffer.from(JSON.stringify([date, ts, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string, string] {
  try {
    const [date, ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string().min(10).max(40), z.string().uuid()]).parse([date, ts, id]);
  } catch {
    throw new HttpError(400, 'invalid_cursor');
  }
}

/** Newest first, grouped by the app into Today / Yesterday / This week. Keyset-paginated. */
export async function listExpenses(ctx: EventContext, query: z.infer<typeof listExpensesQuerySchema>) {
  const eventId = ctx.event.id;
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const like = query.q ? likePattern(query.q) : null;

  const [page, totals] = await Promise.all([
    pool.query(
      `select e.id, e.title, e.category, e.amount_paise, e.expense_date::text as expense_date, e.expense_time, e.notes,
              e.paid_by, pu.name as paid_by_name, e.created_by, (e.receipt_file_id is not null) as has_receipt, e.created_at,
              to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_ts,
              coalesce((select s.share_paise from event_expense_shares s where s.expense_id = e.id and s.user_id = $2), 0) as my_share_paise
         from event_expenses e join users pu on pu.id = e.paid_by
        where e.event_id = $1 and e.status = 'active'
          and ($3::text is null or e.title ilike $3 escape '\\' or e.category ilike $3 escape '\\'
               or e.notes ilike $3 escape '\\' or pu.name ilike $3 escape '\\')
          and ($4::text is null or e.category = $4)
          and ($5::date is null or (e.expense_date, e.created_at, e.id) < ($5::date, $6::timestamptz, $7::uuid))
        order by e.expense_date desc, e.created_at desc, e.id desc
        limit $8`,
      [eventId, ctx.userId, like, query.category ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, query.limit + 1],
    ),
    pool.query(
      `select coalesce(sum(amount_paise), 0) as spent_paise, count(*) as expense_count,
              (select count(*) from event_members where event_id = $1 and status = 'active') as active_members
         from event_expenses where event_id = $1 and status = 'active'`,
      [eventId],
    ),
  ]);

  const hasMore = page.rows.length > query.limit;
  const rows = page.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  return {
    expenses: rows.map(({ cursor_ts, ...r }) => ({ ...r, paid_by_me: r.paid_by === ctx.userId })),
    next_cursor: hasMore && last ? encodeCursor(last.expense_date, last.cursor_ts, last.id) : null,
    summary: { ...totals.rows[0], budget_paise: ctx.event.budget_paise ?? null },
  };
}
