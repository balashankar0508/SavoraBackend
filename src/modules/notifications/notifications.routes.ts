import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { eventMutationLimiter } from '../../middleware/rateLimit';
import { can } from '../events/access';
import { route } from '../events/shared/http';
import { PREF_DEFAULTS, PrefCategory } from './describe';

const MAX_TOKENS_PER_USER = 10;

// ── /me/device-tokens ───────────────────────────────────────────

/** Registered by the app after login and on every token refresh; removed on logout. */
export const deviceRoutes = Router();

const tokenSchema = z.string().trim().min(20).max(4096).regex(/^\S+$/, 'invalid_token');

deviceRoutes.post('/device-tokens', eventMutationLimiter, route(async (req, res) => {
  const { token, platform } = z.object({ token: tokenSchema, platform: z.enum(['android', 'ios']).default('android') }).strict().parse(req.body);
  // A token belongs to one physical install. If another account signed in on this phone, it moves to them.
  await pool.query(
    `insert into device_tokens (user_id, token, platform) values ($1, $2, $3)
     on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, updated_at = now()`,
    [req.userId, token, platform],
  );
  await pool.query(
    `delete from device_tokens where user_id = $1 and id not in
       (select id from device_tokens where user_id = $1 order by updated_at desc limit ${MAX_TOKENS_PER_USER})`,
    [req.userId],
  );
  res.status(201).json({ ok: true });
}));

deviceRoutes.delete('/device-tokens', eventMutationLimiter, route(async (req, res) => {
  const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
  await pool.query('delete from device_tokens where token = $1 and user_id = $2', [token, req.userId]);
  res.json({ ok: true });
}));

// ── /events/:eventId/notification-prefs ─────────────────────────

/** Mounted under /events/:eventId. Each member controls only their own switches. */
export const prefsRoutes = Router({ mergeParams: true });

const CATEGORIES = Object.keys(PREF_DEFAULTS) as PrefCategory[];

async function readPrefs(eventId: string, userId: string): Promise<Record<PrefCategory, boolean>> {
  const { rows } = await pool.query('select expenses, members, settlements, chat from event_notification_prefs where event_id = $1 and user_id = $2', [eventId, userId]);
  return { ...PREF_DEFAULTS, ...(rows[0] ?? {}) };
}

prefsRoutes.get('/notification-prefs', can('notifications.edit'), route(async (req, res) => {
  res.json({ prefs: await readPrefs(req.eventCtx!.event.id, req.userId) });
}));

prefsRoutes.put('/notification-prefs', eventMutationLimiter, can('notifications.edit'), route(async (req, res) => {
  const input = z.object({ expenses: z.boolean(), members: z.boolean(), settlements: z.boolean(), chat: z.boolean() }).partial().strict()
    .refine(v => Object.keys(v).length > 0, { message: 'nothing_to_update' }).parse(req.body);
  const eventId = req.eventCtx!.event.id;
  const next = { ...(await readPrefs(eventId, req.userId)), ...input };
  await pool.query(
    `insert into event_notification_prefs (event_id, user_id, ${CATEGORIES.join(', ')}) values ($1, $2, $3, $4, $5, $6)
     on conflict (event_id, user_id) do update set ${CATEGORIES.map(c => `${c} = excluded.${c}`).join(', ')}`,
    [eventId, req.userId, ...CATEGORIES.map(c => next[c])],
  );
  res.json({ prefs: next });
}));
