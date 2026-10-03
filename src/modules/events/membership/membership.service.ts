import { PoolClient } from 'pg';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { assertCan } from '../access/denial';
import { withEventLock } from '../access/lock';
import { EventContext, EventRole } from '../access/types';
import { balancesOf, loadLedgerState, loadNames } from '../shared/ledgerState';
import { logActivity, logAudit, postSystemMessage } from '../shared/audit';
import { emitDomainEvent } from '../shared/domainEvents';

const MAX_ACTIVE_MEMBERS = 100;

export async function listMembers(ctx: EventContext) {
  const { rows } = await pool.query(
    `select m.user_id as id, u.name, m.role, m.joined_at,
            coalesce((select sum(x.amount_paise) from event_expenses x
                       where x.event_id = m.event_id and x.paid_by = m.user_id and x.status = 'active'), 0) as paid_paise
       from event_members m join users u on u.id = m.user_id
      where m.event_id = $1 and m.status = 'active'
      order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.joined_at, m.user_id`,
    [ctx.event.id],
  );
  return { members: rows.map(m => ({ ...m, is_me: m.id === ctx.userId })) };
}

/** Loads a member row under the lock; the caller names which statuses are acceptable. */
async function getMember(client: PoolClient, eventId: string, userId: string, statuses: string[]) {
  const { rows } = await client.query(
    'select user_id, role, status from event_members where event_id = $1 and user_id = $2 and status = any($3::text[]) for update',
    [eventId, userId, statuses],
  );
  return rows[0] as { user_id: string; role: EventRole; status: string } | undefined;
}

/** A member may only go once they owe and are owed nothing and have no payment awaiting confirmation. */
async function assertCanDepart(client: PoolClient, eventId: string, userId: string, balanceCode: string) {
  const state = await loadLedgerState(client, eventId);
  if ((balancesOf(state)[userId] ?? 0) !== 0) throw new HttpError(409, balanceCode);
  if (state.settlements.some(s => s.status === 'pending_confirmation' && (s.from_user === userId || s.to_user === userId))) {
    throw new HttpError(409, 'member_has_pending_settlement');
  }
}

export async function approveRequest(eventId: string, actorId: string, targetId: string) {
  const name = await withEventLock(eventId, actorId, async (client, ctx) => {
    assertCan(ctx, 'member.approve_request');
    const target = await getMember(client, eventId, targetId, ['pending']);
    if (!target) throw new HttpError(404, 'join_request_not_found');
    const count = (await client.query("select count(*)::int as n from event_members where event_id = $1 and status = 'active'", [eventId])).rows[0].n;
    if (count >= MAX_ACTIVE_MEMBERS) throw new HttpError(409, 'event_member_limit');

    await client.query("update event_members set status = 'active', joined_at = now() where event_id = $1 and user_id = $2", [eventId, targetId]);
    const who = (await loadNames(client, [targetId])).get(targetId) ?? 'A member';
    await logActivity(client, { eventId, actorId, kind: 'member_joined', summary: `${who} joined the event` });
    await logAudit(client, { eventId, actorId, action: 'JOIN_REQUEST_APPROVED', targetType: 'member', targetId });
    await postSystemMessage(client, eventId, { type: 'member_joined', user_id: targetId, user_name: who });
    return who;
  });
  emitDomainEvent({ type: 'member.approved', eventId, actorId, userId: targetId });
  return { ok: true, name };
}

export async function rejectRequest(eventId: string, actorId: string, targetId: string) {
  await withEventLock(eventId, actorId, async (client, ctx) => {
    assertCan(ctx, 'member.approve_request');
    const target = await getMember(client, eventId, targetId, ['pending']);
    if (!target) throw new HttpError(404, 'join_request_not_found');
    await client.query("update event_members set status = 'removed', removed_at = now() where event_id = $1 and user_id = $2", [eventId, targetId]);
    await logAudit(client, { eventId, actorId, action: 'JOIN_REQUEST_REJECTED', targetType: 'member', targetId });
  });
  emitDomainEvent({ type: 'member.rejected', eventId, actorId, userId: targetId });
  return { ok: true };
}

export async function promote(eventId: string, actorId: string, targetId: string) {
  return withEventLock(eventId, actorId, async (client, ctx) => {
    const target = await getMember(client, eventId, targetId, ['active']);
    if (!target) throw new HttpError(404, 'active_member_not_found');
    assertCan(ctx, 'member.promote', { user_id: targetId, role: target.role });
    await client.query("update event_members set role = 'admin' where event_id = $1 and user_id = $2", [eventId, targetId]);
    await logAudit(client, { eventId, actorId, action: 'MEMBER_PROMOTED', targetType: 'member', targetId });
    return { ok: true };
  });
}

export async function demote(eventId: string, actorId: string, targetId: string) {
  return withEventLock(eventId, actorId, async (client, ctx) => {
    const target = await getMember(client, eventId, targetId, ['active']);
    if (!target) throw new HttpError(404, 'active_member_not_found');
    assertCan(ctx, 'member.demote', { user_id: targetId, role: target.role });
    await client.query("update event_members set role = 'member' where event_id = $1 and user_id = $2", [eventId, targetId]);
    await logAudit(client, { eventId, actorId, action: 'MEMBER_DEMOTED', targetType: 'member', targetId });
    return { ok: true };
  });
}

export async function removeMember(eventId: string, actorId: string, targetId: string) {
  await withEventLock(eventId, actorId, async (client, ctx) => {
    const target = await getMember(client, eventId, targetId, ['active']);
    if (!target) throw new HttpError(404, 'member_not_found');
    assertCan(ctx, 'member.remove', { user_id: targetId, role: target.role });
    await assertCanDepart(client, eventId, targetId, 'settle_member_balance_first');

    // role goes back to 'member': a removed user can never keep a privileged role
    await client.query("update event_members set status = 'removed', role = 'member', removed_at = now() where event_id = $1 and user_id = $2", [eventId, targetId]);
    const who = (await loadNames(client, [targetId])).get(targetId) ?? 'A member';
    await logActivity(client, { eventId, actorId, kind: 'member_removed', summary: `${who} was removed` });
    await logAudit(client, { eventId, actorId, action: 'MEMBER_REMOVED', targetType: 'member', targetId });
    await postSystemMessage(client, eventId, { type: 'member_removed', user_id: targetId, user_name: who });
  });
  emitDomainEvent({ type: 'member.removed', eventId, actorId, userId: targetId });
  return { ok: true };
}

export async function leaveEvent(eventId: string, userId: string) {
  await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'member.leave');
    await assertCanDepart(client, eventId, userId, 'settle_balance_before_leaving');
    await client.query("update event_members set status = 'left', role = 'member', removed_at = now() where event_id = $1 and user_id = $2", [eventId, userId]);
    const who = (await loadNames(client, [userId])).get(userId) ?? 'A member';
    await logActivity(client, { eventId, actorId: userId, kind: 'member_left', summary: `${who} left the event` });
    await logAudit(client, { eventId, actorId: userId, action: 'MEMBER_LEFT', targetType: 'member', targetId: userId });
    await postSystemMessage(client, eventId, { type: 'member_left', user_id: userId, user_name: who });
  });
  emitDomainEvent({ type: 'member.left', eventId, actorId: userId, userId });
  return { ok: true };
}

/** A member's saved UPI ID, for the payer's "open UPI app" step. Only visible
 * to someone in the same event, and only for another active member of it. */
export async function getMemberPaymentProfile(ctx: EventContext, targetId: string) {
  const { rows } = await pool.query(
    `select u.name, p.upi_id
       from event_members m join users u on u.id = m.user_id
       left join user_payment_profiles p on p.user_id = m.user_id
      where m.event_id = $1 and m.user_id = $2 and m.status = 'active'`,
    [ctx.event.id, targetId],
  );
  if (!rows[0]) throw new HttpError(404, 'member_not_found');
  return { user_id: targetId, name: rows[0].name, upi_id: rows[0].upi_id ?? null };
}
