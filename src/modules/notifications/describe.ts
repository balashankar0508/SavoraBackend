import { DomainEvent } from '../events/shared/domainEvents';
import { formatINR } from '../events/ledger';

/** Which switch in Event Settings controls a notification (null = always delivered). */
export type PrefCategory = 'expenses' | 'members' | 'settlements' | 'chat';

/** Defaults when a member never opened the settings (matches the design: member activity is off). */
export const PREF_DEFAULTS: Record<PrefCategory, boolean> = { expenses: true, members: false, settlements: true, chat: true };

export type Audience =
  | { kind: 'members_except_actor' }
  | { kind: 'staff_except_actor' }
  | { kind: 'users'; userIds: string[] };

export interface PushPayload {
  title: string;
  body: string;
  /** FCM data values must be strings. `route` tells the app which screen to open. */
  data: Record<string, string>;
  /** Replaces an earlier notification with the same tag instead of stacking (chat). */
  tag?: string;
}

export interface PlannedPush {
  audience: Audience;
  category: PrefCategory | null;
  payload: PushPayload;
}

/** The names the message needs; the planner looks them up. */
export interface Facts {
  eventTitle: string;
  actorName: string;
  names: Record<string, string>; // user id -> display name
}

/** Screens the app can open from a notification (data.route). */
export type NotificationRoute = 'event' | 'expenses' | 'balances' | 'settlements' | 'chat' | 'members' | 'events';

const who = (f: Facts, id: string) => f.names[id] ?? 'Someone';

/**
 * What each domain event tells whom. Pure: no database, no clock.
 *
 * Privacy: chat pushes never contain the message text, and no payment details
 * (UPI IDs, UTRs) are ever sent through the push service.
 */
export function describeEvent(e: DomainEvent, f: Facts): PlannedPush[] {
  const base = (route: NotificationRoute, extra: Record<string, string> = {}) =>
    ({ route, ...('eventId' in e ? { eventId: e.eventId } : {}), ...extra });
  const push = (audience: Audience, category: PrefCategory | null, title: string, body: string, route: NotificationRoute, extra: Record<string, string> = {}, tag?: string): PlannedPush =>
    ({ audience, category, payload: { title, body, data: base(route, extra), ...(tag ? { tag } : {}) } });

  const everyone: Audience = { kind: 'members_except_actor' };
  const t = f.eventTitle;

  switch (e.type) {
    case 'expense.added':
      return [push(everyone, 'expenses', t, `${f.actorName} added ${e.title} — ${formatINR(e.amountPaise)}`, 'expenses', { expenseId: e.expenseId })];
    case 'expense.updated':
      return [push(everyone, 'expenses', t, `${f.actorName} updated ${e.title} — ${formatINR(e.amountPaise)}`, 'expenses', { expenseId: e.expenseId })];
    case 'expense.voided':
      return [push(everyone, 'expenses', t, `${f.actorName} removed ${e.title} (${formatINR(e.amountPaise)})`, 'expenses')];

    case 'member.joined':
      return [push(everyone, 'members', t, `${who(f, e.userId)} joined the event`, 'members')];
    case 'member.left':
      return [push(everyone, 'members', t, `${who(f, e.userId)} left the event`, 'members')];
    case 'member.requested': // an action item for admins, so it ignores the "member activity" switch
      return [push({ kind: 'staff_except_actor' }, null, t, `${who(f, e.userId)} wants to join. Review the request.`, 'members')];
    case 'member.approved':
      return [push({ kind: 'users', userIds: [e.userId] }, null, t, 'Your request to join was approved.', 'event')];
    case 'member.rejected':
      return [push({ kind: 'users', userIds: [e.userId] }, null, t, 'Your request to join was declined.', 'events')];
    case 'member.removed':
      return [push({ kind: 'users', userIds: [e.userId] }, null, t, 'You were removed from this event.', 'events')];

    case 'settlement.created':
      return [push({ kind: 'users', userIds: [e.toUser] }, 'settlements', t, `${who(f, e.fromUser)} marked ${formatINR(e.amountPaise)} as paid. Confirm once you receive it.`, 'settlements', { settlementId: e.settlementId })];
    case 'settlement.confirmed':
      return [push({ kind: 'users', userIds: [e.fromUser] }, 'settlements', t, `${who(f, e.toUser)} confirmed your ${formatINR(e.amountPaise)} payment.`, 'settlements', { settlementId: e.settlementId })];
    case 'settlement.rejected':
      return [push({ kind: 'users', userIds: [e.fromUser] }, 'settlements', t, `${f.actorName} could not confirm your ${formatINR(e.amountPaise)} payment.`, 'settlements', { settlementId: e.settlementId })];
    case 'settlement.cancelled': {
      const other = e.actorId === e.fromUser ? e.toUser : e.fromUser;
      return [push({ kind: 'users', userIds: [other] }, 'settlements', t, `${f.actorName} cancelled the ${formatINR(e.amountPaise)} payment record.`, 'settlements', { settlementId: e.settlementId })];
    }

    case 'chat.message':
      return [push(everyone, 'chat', t, `${f.actorName} sent a message`, 'chat', {}, `chat-${e.eventId}`)];

    case 'reminder.sent':
      return [push({ kind: 'users', userIds: [e.targetUser] }, null,
        e.kind === 'remind' ? 'Payment reminder' : 'Payment request',
        e.kind === 'remind' ? `${f.actorName} reminded you to settle ${formatINR(e.amountPaise)} for ${t}.` : `${f.actorName} is requesting ${formatINR(e.amountPaise)} for ${t}.`,
        'balances')];

    case 'event.completed':
      return [push(everyone, 'settlements', t, 'The event is complete and everything is settled.', 'event')];
    case 'event.reopened':
      return [push(everyone, 'settlements', t, 'The event was reopened.', 'event')];
    case 'event.deleted':
      return [push({ kind: 'users', userIds: e.memberIds.filter(id => id !== e.actorId) }, null, e.title, 'This event was deleted by its owner.', 'events')];

    default:
      return []; // event.created, event.archived: nothing to tell anyone
  }
}
