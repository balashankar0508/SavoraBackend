import { randomUUID } from 'crypto';
import { Queryable } from '../access/context';

/** The three trails every mutation writes, all inside the same transaction. */

/** Human-readable feed shown on the event. */
export async function logActivity(
  db: Queryable,
  e: { eventId: string; actorId: string | null; kind: string; summary: string; amountPaise?: number },
): Promise<void> {
  await db.query(
    'insert into event_activity (event_id, actor_id, kind, summary, amount_paise) values ($1, $2, $3, $4, $5)',
    [e.eventId, e.actorId, e.kind, e.summary, e.amountPaise ?? null],
  );
}

/** Admin-visible security/accounting trail. Metadata holds before/after values. */
export async function logAudit(
  db: Queryable,
  e: { eventId: string; actorId: string | null; action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    'insert into event_audit_logs (event_id, actor_id, action, target_type, target_id, metadata) values ($1, $2, $3, $4, $5, $6)',
    [e.eventId, e.actorId, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.metadata ?? {})],
  );
}

/** A system card in the event chat ("Priya added Cake - INR 2,000"). Not encrypted:
 * it carries only what the activity feed already shows to every member. */
export async function postSystemMessage(
  db: Queryable,
  eventId: string,
  payload: { type: string } & Record<string, unknown>,
): Promise<void> {
  await db.query(
    "insert into event_messages (id, event_id, kind, system_payload) values ($1, $2, 'system', $3)",
    [randomUUID(), eventId, JSON.stringify(payload)],
  );
}
