import { z } from 'zod';
import { EventContext, EventRole, EventRow } from './types';

/** Anything with pg's `query` (Pool or PoolClient). */
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

const uuid = z.string().uuid();

/**
 * Loads the event + the caller's ACTIVE membership in one query.
 * Returns null when the id is malformed, the event doesn't exist, OR the
 * caller isn't an active member — callers treat all three identically (404)
 * so event existence is never revealed to outsiders.
 *
 * `forUpdate` takes the event row lock that serialises all writes to one
 * event (used by withEventLock).
 */
export async function loadEventContext(
  db: Queryable,
  eventId: string,
  userId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<EventContext | null> {
  const parsed = uuid.safeParse(eventId);
  if (!parsed.success) return null;

  const { rows } = await db.query(
    `select e.*, e.start_date::text as start_date, e.end_date::text as end_date, m.role as member_role
       from events e
       join event_members m on m.event_id = e.id
      where e.id = $1 and m.user_id = $2 and m.status = 'active'
      ${opts.forUpdate ? 'for update of e' : ''}`,
    [parsed.data, userId],
  );
  if (!rows[0]) return null;

  const { member_role, ...event } = rows[0];
  return { userId, role: member_role as EventRole, event: event as EventRow };
}
