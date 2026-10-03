import { PoolClient } from 'pg';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { loadEventContext } from './context';
import { EventContext } from './types';

/**
 * The write path for every event mutation (plan §3):
 *   BEGIN → lock the event row → re-load context under the lock → fn → COMMIT.
 *
 * Because the row lock serialises all writes to one event, `fn` sees a stable
 * ledger. The context is re-loaded INSIDE the lock, so membership and event
 * status/toggles are never stale — call `assertCan(ctx, …)` inside `fn`.
 * Anything thrown rolls the whole transaction back.
 */
export async function withEventLock<T>(
  eventId: string,
  userId: string,
  fn: (client: PoolClient, ctx: EventContext) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await loadEventContext(client, eventId, userId, { forUpdate: true });
    if (!ctx) throw new HttpError(404, 'event_not_found');
    const result = await fn(client, ctx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
