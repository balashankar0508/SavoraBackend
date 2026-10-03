import { EventEmitter } from 'events';
import { logger } from '../../../lib/logger';

/**
 * Things that happened to an event, emitted AFTER the transaction commits.
 * Services only emit; push notifications and any other side effects subscribe
 * (see modules/notifications). A failing subscriber can never fail a request
 * or roll anything back.
 */
export type DomainEvent =
  | { type: 'event.created' | 'event.completed' | 'event.reopened' | 'event.archived'; eventId: string; actorId: string }
  | { type: 'event.deleted'; eventId: string; actorId: string; title: string; memberIds: string[] }
  | { type: 'expense.added' | 'expense.updated' | 'expense.voided'; eventId: string; actorId: string; expenseId: string; title: string; amountPaise: number }
  | { type: 'member.joined' | 'member.requested' | 'member.approved' | 'member.rejected' | 'member.removed' | 'member.left'; eventId: string; actorId: string; userId: string }
  | { type: 'settlement.created' | 'settlement.confirmed' | 'settlement.rejected' | 'settlement.cancelled'; eventId: string; actorId: string; settlementId: string; fromUser: string; toUser: string; amountPaise: number }
  | { type: 'reminder.sent'; eventId: string; actorId: string; targetUser: string; kind: 'remind' | 'request'; amountPaise: number };

export const domainEvents = new EventEmitter();

export function emitDomainEvent(event: DomainEvent): void {
  try {
    domainEvents.emit('event', event);
  } catch (err) {
    logger.error({ err, type: event.type }, 'domain event subscriber failed');
  }
}
