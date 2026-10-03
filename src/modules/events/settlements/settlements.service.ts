import { z } from 'zod';
import { PoolClient } from 'pg';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { assertFileAttachable } from '../../files/files.service';
import { assertCan } from '../access/denial';
import { withEventLock } from '../access/lock';
import { EventContext } from '../access/types';
import {
  assertLedgerConsistent, assertSettlementAllowed, computePairwise, formatINR, isFullySettled, maxSettlement,
} from '../ledger';
import { logActivity, logAudit, postSystemMessage } from '../shared/audit';
import { generateReference } from '../shared/codes';
import { emitDomainEvent } from '../shared/domainEvents';
import { balancesOf, loadLedgerState, loadNames, suggestionsOf } from '../shared/ledgerState';
import { likePattern } from '../shared/schemas';
import {
  createSettlementSchema, listSettlementsQuerySchema, paymentProfileSchema, rejectSettlementSchema, remindSchema,
} from './settlements.schemas';

const SETTLEMENT_SELECT = `
  select s.id, s.event_id, s.from_user, fu.name as from_name, s.to_user, tu.name as to_name, s.amount_paise, s.method,
         s.upi_app, s.utr, s.proof_file_id, s.reference_code, s.status, s.paid_marked_at, s.confirmed_at, s.confirmed_by,
         s.rejected_at, s.rejection_reason, s.created_at
    from event_settlements s
    join users fu on fu.id = s.from_user
    join users tu on tu.id = s.to_user`;

async function fetchSettlement(db: Pick<PoolClient, 'query'>, eventId: string, settlementId: string) {
  const { rows } = await db.query(`${SETTLEMENT_SELECT} where s.id = $1 and s.event_id = $2`, [settlementId, eventId]);
  if (!rows[0]) throw new HttpError(404, 'settlement_not_found');
  return rows[0];
}

async function assertLedgerStillBalanced(client: PoolClient, eventId: string) {
  assertLedgerConsistent(await loadLedgerState(client, eventId));
}

// ── balances screen ─────────────────────────────────────────────

export async function getBalances(ctx: EventContext) {
  const state = await loadLedgerState(pool, ctx.event.id);
  const balances = balancesOf(state);
  const names = await loadNames(pool, [...Object.keys(balances), ...state.settlements.flatMap(s => [s.from_user, s.to_user])]);
  const pairwise = computePairwise(ctx.userId, state.expenses, state.settlements);
  const paid = state.expenses.filter(e => e.paid_by === ctx.userId).reduce((n, e) => n + e.amount_paise, 0);

  const pending = state.settlements.filter(s => s.status === 'pending_confirmation');
  return {
    me: {
      net_paise: balances[ctx.userId] ?? 0,
      paid_paise: paid,
      you_owe_paise: pairwise.you_owe_paise,
      owed_paise: pairwise.owed_paise,
    },
    members: Object.entries(balances)
      .map(([user_id, balance_paise]) => ({
        user_id,
        name: names.get(user_id) ?? 'Member',
        balance_paise,
        status: balance_paise === 0 ? 'settled' : balance_paise > 0 ? 'owed' : 'owes',
        is_me: user_id === ctx.userId,
      }))
      .sort((a, b) => Number(b.is_me) - Number(a.is_me) || b.balance_paise - a.balance_paise || (a.user_id < b.user_id ? -1 : 1)),
    suggestions: suggestionsOf(state).map(t => ({
      from: t.from, from_name: names.get(t.from) ?? 'Member',
      to: t.to, to_name: names.get(t.to) ?? 'Member',
      amount_paise: t.amount_paise,
      i_pay: t.from === ctx.userId,
      i_receive: t.to === ctx.userId,
    })),
    pending: pending.map(s => ({
      id: s.id, from: s.from_user, from_name: names.get(s.from_user) ?? 'Member',
      to: s.to_user, to_name: names.get(s.to_user) ?? 'Member', amount_paise: s.amount_paise,
    })),
    settled: isFullySettled(balances) && pending.length === 0,
  };
}

// ── mark paid ───────────────────────────────────────────────────

const REFERENCE_ATTEMPTS = 5;

export async function createSettlement(eventId: string, userId: string, input: z.infer<typeof createSettlementSchema>) {
  const result = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'settlement.create', { to_user: input.to_user });

    const recipient = await client.query("select 1 from event_members where event_id = $1 and user_id = $2 and status = 'active'", [eventId, input.to_user]);
    if (!recipient.rows[0]) throw new HttpError(400, 'invalid_member');

    const previous = (await client.query('select event_id, from_user, to_user, amount_paise, method from event_settlements where id = $1', [input.id])).rows[0];
    if (previous) {
      const same = previous.event_id === eventId && previous.from_user === userId && previous.to_user === input.to_user &&
        previous.amount_paise === input.amount_paise && previous.method === input.method;
      if (!same) throw new HttpError(409, 'duplicate_id');
      return { settlement: await fetchSettlement(client, eventId, input.id), created: false };
    }

    const state = await loadLedgerState(client, eventId);
    assertSettlementAllowed(balancesOf(state), userId, input.to_user, input.amount_paise);
    if (state.settlements.some(s => s.status === 'pending_confirmation' && s.from_user === userId && s.to_user === input.to_user)) {
      throw new HttpError(409, 'pending_settlement_exists');
    }
    if (input.proof_file_id) await assertFileAttachable(client, input.proof_file_id, eventId, userId, 'proof');

    let inserted = false;
    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS && !inserted; attempt++) {
      await client.query('SAVEPOINT settlement_ref');
      try {
        await client.query(
          `insert into event_settlements (id, event_id, from_user, to_user, amount_paise, method, upi_app, utr, proof_file_id, reference_code)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [input.id, eventId, userId, input.to_user, input.amount_paise, input.method, input.upi_app ?? null,
            input.utr ?? null, input.proof_file_id ?? null, generateReference()],
        );
        inserted = true;
        await client.query('RELEASE SAVEPOINT settlement_ref');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT settlement_ref');
        const e = err as { code?: string; constraint?: string };
        if (e.code !== '23505' || e.constraint !== 'event_settlements_reference_code_key') throw err; // only a reference clash is worth retrying
      }
    }
    if (!inserted) throw new HttpError(500, 'reference_generation_failed');

    const names = await loadNames(client, [userId, input.to_user]);
    await logActivity(client, {
      eventId, actorId: userId, kind: 'settlement_marked_paid',
      summary: `${names.get(userId)} marked ${formatINR(input.amount_paise)} as paid to ${names.get(input.to_user)}`, amountPaise: input.amount_paise,
    });
    await logAudit(client, { eventId, actorId: userId, action: 'SETTLEMENT_CREATED', targetType: 'settlement', targetId: input.id, metadata: { amount_paise: input.amount_paise, method: input.method } });
    await postSystemMessage(client, eventId, {
      type: 'settlement_marked_paid', settlement_id: input.id, from_user: userId, from_name: names.get(userId),
      to_user: input.to_user, to_name: names.get(input.to_user), amount_paise: input.amount_paise,
    });
    await assertLedgerStillBalanced(client, eventId);
    return { settlement: await fetchSettlement(client, eventId, input.id), created: true };
  });
  if (result.created) {
    emitDomainEvent({ type: 'settlement.created', eventId, actorId: userId, settlementId: input.id, fromUser: userId, toUser: input.to_user, amountPaise: input.amount_paise });
  }
  return { settlement: result.settlement };
}

// ── review ──────────────────────────────────────────────────────

async function lockSettlement(client: PoolClient, eventId: string, settlementId: string) {
  const row = (
    await client.query(
      'select id, from_user, to_user, amount_paise, status from event_settlements where id = $1 and event_id = $2 for update',
      [settlementId, eventId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'settlement_not_found');
  return row as { id: string; from_user: string; to_user: string; amount_paise: number; status: string };
}

/** Only now does the balance move. The amount is re-checked against the CURRENT balances, because
 * expenses may have been edited or other payments confirmed since the payer tapped "Mark as paid". */
export async function confirmSettlement(eventId: string, userId: string, settlementId: string) {
  const result = await withEventLock(eventId, userId, async (client, ctx) => {
    const s = await lockSettlement(client, eventId, settlementId);
    assertCan(ctx, 'settlement.confirm', { from_user: s.from_user, to_user: s.to_user, status: s.status });

    const state = await loadLedgerState(client, eventId);
    assertSettlementAllowed(balancesOf(state), s.from_user, s.to_user, s.amount_paise, 'balance_changed');

    await client.query("update event_settlements set status = 'confirmed', confirmed_at = now(), confirmed_by = $2 where id = $1", [settlementId, userId]);
    const names = await loadNames(client, [s.from_user, s.to_user]);
    await logActivity(client, {
      eventId, actorId: userId, kind: 'settlement_confirmed',
      summary: `${names.get(s.to_user)} confirmed ${formatINR(s.amount_paise)} from ${names.get(s.from_user)}`, amountPaise: s.amount_paise,
    });
    await logAudit(client, { eventId, actorId: userId, action: 'SETTLEMENT_COMPLETED', targetType: 'settlement', targetId: settlementId, metadata: { amount_paise: s.amount_paise } });
    await postSystemMessage(client, eventId, {
      type: 'settlement_confirmed', settlement_id: settlementId, from_user: s.from_user, from_name: names.get(s.from_user),
      to_user: s.to_user, to_name: names.get(s.to_user), amount_paise: s.amount_paise,
    });

    const after = await loadLedgerState(client, eventId);
    assertLedgerConsistent(after);
    const balances = balancesOf(after);
    return {
      settlement: await fetchSettlement(client, eventId, settlementId),
      balances_after: { [s.from_user]: balances[s.from_user] ?? 0, [s.to_user]: balances[s.to_user] ?? 0 },
      from: s.from_user, to: s.to_user, amount: s.amount_paise,
    };
  });
  emitDomainEvent({ type: 'settlement.confirmed', eventId, actorId: userId, settlementId, fromUser: result.from, toUser: result.to, amountPaise: result.amount });
  return { settlement: result.settlement, balances_after: result.balances_after };
}

export async function rejectSettlement(eventId: string, userId: string, settlementId: string, input: z.infer<typeof rejectSettlementSchema>) {
  const s = await withEventLock(eventId, userId, async (client, ctx) => {
    const row = await lockSettlement(client, eventId, settlementId);
    assertCan(ctx, 'settlement.reject', { from_user: row.from_user, to_user: row.to_user, status: row.status });
    await client.query(
      "update event_settlements set status = 'rejected', rejected_at = now(), rejected_by = $2, rejection_reason = $3 where id = $1",
      [settlementId, userId, input.reason ?? null],
    );
    await logAudit(client, { eventId, actorId: userId, action: 'SETTLEMENT_REJECTED', targetType: 'settlement', targetId: settlementId, metadata: { reason: input.reason ?? null } });
    return row;
  });
  emitDomainEvent({ type: 'settlement.rejected', eventId, actorId: userId, settlementId, fromUser: s.from_user, toUser: s.to_user, amountPaise: s.amount_paise });
  return { ok: true };
}

export async function cancelSettlement(eventId: string, userId: string, settlementId: string) {
  const s = await withEventLock(eventId, userId, async (client, ctx) => {
    const row = await lockSettlement(client, eventId, settlementId);
    assertCan(ctx, 'settlement.cancel', { from_user: row.from_user, to_user: row.to_user, status: row.status });
    await client.query("update event_settlements set status = 'cancelled' where id = $1", [settlementId]);
    await logAudit(client, { eventId, actorId: userId, action: 'SETTLEMENT_CANCELLED', targetType: 'settlement', targetId: settlementId });
    return row;
  });
  emitDomainEvent({ type: 'settlement.cancelled', eventId, actorId: userId, settlementId, fromUser: s.from_user, toUser: s.to_user, amountPaise: s.amount_paise });
  return { ok: true };
}

// ── history ─────────────────────────────────────────────────────

const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  try {
    return z.tuple([z.string().min(10).max(40), z.string().uuid()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'invalid_cursor');
  }
}

export async function listSettlements(ctx: EventContext, query: z.infer<typeof listSettlementsQuerySchema>) {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const like = query.q ? likePattern(query.q) : null;
  const staff = ctx.role === 'owner' || ctx.role === 'admin';

  const { rows } = await pool.query(
    `${SETTLEMENT_SELECT.replace('s.created_at', "s.created_at, to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as cursor_ts")}
      where s.event_id = $1
        and ($2::text is null or s.status = $2)
        and ($3::text is null or s.reference_code ilike $3 escape '\\' or fu.name ilike $3 escape '\\' or tu.name ilike $3 escape '\\')
        and ($4::timestamptz is null or (s.created_at, s.id) < ($4::timestamptz, $5::uuid))
      order by s.created_at desc, s.id desc
      limit $6`,
    [ctx.event.id, query.status ?? null, like, cursor?.[0] ?? null, cursor?.[1] ?? null, query.limit + 1],
  );

  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    settlements: page.map(({ cursor_ts, proof_file_id, ...s }) => {
      const party = s.from_user === ctx.userId || s.to_user === ctx.userId;
      return {
        ...s,
        direction: s.from_user === ctx.userId ? 'sent' : s.to_user === ctx.userId ? 'received' : 'other',
        has_proof: proof_file_id !== null,
        // payment screenshots are private to the two people involved and the admins
        proof_file_id: party || staff ? proof_file_id : null,
      };
    }),
    next_cursor: hasMore && last ? encodeCursor(last.cursor_ts, last.id) : null,
  };
}

// ── reminders ───────────────────────────────────────────────────

export async function sendReminder(eventId: string, userId: string, input: z.infer<typeof remindSchema>) {
  const outcome = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, input.kind === 'remind' ? 'settlement.remind' : 'settlement.request', { target_user: input.target_user });

    const target = await client.query("select 1 from event_members where event_id = $1 and user_id = $2 and status = 'active'", [eventId, input.target_user]);
    if (!target.rows[0]) throw new HttpError(404, 'member_not_found');

    const state = await loadLedgerState(client, eventId);
    const amount = maxSettlement(balancesOf(state), input.target_user, userId);
    if (amount <= 0) throw new HttpError(409, 'nothing_owed'); // only a creditor can chase a debtor

    const recent = await client.query(
      `select 1 from event_reminders where event_id = $1 and from_user = $2 and to_user = $3 and kind = $4
          and sent_at > now() - interval '24 hours'`,
      [eventId, userId, input.target_user, input.kind],
    );
    if (recent.rows[0]) throw new HttpError(429, 'reminder_too_soon');

    await client.query('insert into event_reminders (event_id, from_user, to_user, kind) values ($1, $2, $3, $4)', [eventId, userId, input.target_user, input.kind]);
    await logAudit(client, { eventId, actorId: userId, action: input.kind === 'remind' ? 'REMINDER_SENT' : 'PAYMENT_REQUESTED', targetType: 'member', targetId: input.target_user, metadata: { amount_paise: amount } });

    const targetName = (await loadNames(client, [input.target_user])).get(input.target_user) ?? 'there';
    const title = ctx.event.title as string;
    const message = input.kind === 'remind'
      ? `Hi ${targetName}, a gentle reminder to settle ${formatINR(amount)} for "${title}" on Spenxo.`
      : `Hi ${targetName}, please pay ${formatINR(amount)} for "${title}". You can settle it in Spenxo.`;
    return { amount, message };
  });
  emitDomainEvent({ type: 'reminder.sent', eventId, actorId: userId, targetUser: input.target_user, kind: input.kind, amountPaise: outcome.amount });
  return { ok: true, amount_paise: outcome.amount, message: outcome.message };
}

// ── my payment profile (UPI ID reused in every event) ──────────

export async function getMyPaymentProfile(userId: string) {
  const { rows } = await pool.query('select upi_id, updated_at from user_payment_profiles where user_id = $1', [userId]);
  return { upi_id: rows[0]?.upi_id ?? null, updated_at: rows[0]?.updated_at ?? null };
}

export async function setMyPaymentProfile(userId: string, input: z.infer<typeof paymentProfileSchema>) {
  const { rows } = await pool.query(
    `insert into user_payment_profiles (user_id, upi_id) values ($1, $2)
     on conflict (user_id) do update set upi_id = excluded.upi_id, updated_at = now()
     returning upi_id, updated_at`,
    [userId, input.upi_id],
  );
  return rows[0];
}

export async function clearMyPaymentProfile(userId: string) {
  await pool.query('delete from user_payment_profiles where user_id = $1', [userId]);
  return { ok: true };
}
