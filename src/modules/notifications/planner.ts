import { pool } from '../../db/pool';
import { logger } from '../../lib/logger';
import { DomainEvent } from '../events/shared/domainEvents';
import { loadNames } from '../events/shared/ledgerState';
import { Audience, PREF_DEFAULTS, PrefCategory, describeEvent } from './describe';
import { PushSender } from './sender';

const BATCH = 500; // FCM multicast limit

// Fixed column names (never user input), so they are safe to put in the SQL text.
const PREF_COLUMN: Record<PrefCategory, string> = { expenses: 'expenses', members: 'members', settlements: 'settlements', chat: 'chat' };

/**
 * Who should receive this notification. A member's saved switch wins; with no saved
 * row the default applies. Category null means "always deliver" (direct outcomes and action items).
 */
export async function resolveRecipients(eventId: string, audience: Audience, actorId: string, category: PrefCategory | null): Promise<string[]> {
  const pref = category ? `and coalesce(p.${PREF_COLUMN[category]}, ${PREF_DEFAULTS[category]})` : '';

  if (audience.kind === 'users') {
    if (!audience.userIds.length) return [];
    const { rows } = await pool.query(
      `select u.id as user_id from unnest($1::uuid[]) as u(id)
         left join event_notification_prefs p on p.event_id = $2 and p.user_id = u.id
        where true ${pref}`,
      [audience.userIds, eventId],
    );
    return rows.map(r => r.user_id as string);
  }

  const { rows } = await pool.query(
    `select m.user_id from event_members m
       left join event_notification_prefs p on p.event_id = m.event_id and p.user_id = m.user_id
      where m.event_id = $1 and m.status = 'active' and m.user_id <> $2
        ${audience.kind === 'staff_except_actor' ? "and m.role in ('owner', 'admin')" : ''} ${pref}`,
    [eventId, actorId],
  );
  return rows.map(r => r.user_id as string);
}

/** Turns one domain event into pushes and hands them to the sender. Never throws into the caller's request. */
export async function dispatch(e: DomainEvent, sender: PushSender): Promise<void> {
  if (e.type === 'event.created' || e.type === 'event.archived') return;

  const title = e.type === 'event.deleted'
    ? e.title
    : (await pool.query('select title from events where id = $1', [e.eventId])).rows[0]?.title as string | undefined;
  if (!title) return; // the event vanished between the commit and now

  const ids = [e.actorId, ...('userId' in e ? [e.userId] : []), ...('fromUser' in e ? [e.fromUser, e.toUser] : []), ...('targetUser' in e ? [e.targetUser] : [])];
  const names = await loadNames(pool, ids);
  const plans = describeEvent(e, { eventTitle: title, actorName: names.get(e.actorId) ?? 'Someone', names: Object.fromEntries(names) });

  for (const plan of plans) {
    const recipients = await resolveRecipients(e.eventId, plan.audience, e.actorId, plan.category);
    if (!recipients.length) continue;
    const { rows } = await pool.query('select token from device_tokens where user_id = any($1::uuid[])', [recipients]);
    const tokens = rows.map(r => r.token as string);

    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      try {
        const { invalidTokens } = await sender.send(batch, plan.payload);
        if (invalidTokens.length) {
          await pool.query('delete from device_tokens where token = any($1::text[])', [invalidTokens]);
          logger.info({ removed: invalidTokens.length }, 'removed dead device tokens');
        }
      } catch (err) {
        logger.error({ err, type: e.type }, 'push delivery failed');
      }
    }
  }
}
