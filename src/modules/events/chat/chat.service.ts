import { z } from 'zod';
import { pool } from '../../../db/pool';
import { env } from '../../../config/env';
import { HttpError } from '../../../lib/httpError';
import { logger } from '../../../lib/logger';
import { assertFileAttachable, storage } from '../../files/files.service';
import { assertCan } from '../access/denial';
import { EventContext } from '../access/types';
import { logAudit } from '../shared/audit';
import { emitDomainEvent } from '../shared/domainEvents';
import { CHAT_KEY_VERSION, decryptChat, encryptChat } from './chat.crypto';
import { listMessagesQuerySchema, sendMessageSchema } from './chat.schemas';

/**
 * Polling window overlap. A message is stamped when it is written, but a slow
 * transaction can become visible a moment later than a poll that already moved on.
 * Returning the last few seconds again (clients de-duplicate by id) means nothing is missed.
 */
const POLL_OVERLAP_SECONDS = 15;
const POLL_LIMIT = 200;

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SELECT = `
  select m.id, m.kind, m.sender_id, u.name as sender_name, m.ciphertext, m.iv, m.attachment_file_id,
         f.mime as file_mime, f.size_bytes as file_size, m.system_payload, m.created_at,
         ${TS('m.created_at')} as cursor_ts, m.deleted_at
    from event_messages m
    left join users u on u.id = m.sender_id
    left join files f on f.id = m.attachment_file_id`;

interface Row {
  id: string; kind: 'text' | 'attachment' | 'system'; sender_id: string | null; sender_name: string | null;
  ciphertext: Buffer | null; iv: Buffer | null; attachment_file_id: string | null;
  file_mime: string | null; file_size: number | null; system_payload: Record<string, unknown> | null;
  created_at: string; cursor_ts: string; deleted_at: string | null;
}

/** What the app receives. Deleted messages carry no content at all. */
function toView(eventId: string, r: Row) {
  const base = {
    id: r.id,
    kind: r.kind,
    sender: r.sender_id ? { id: r.sender_id, name: r.sender_name } : null,
    created_at: r.created_at,
  };
  if (r.deleted_at) return { ...base, deleted: true as const };
  if (r.kind === 'system') return { ...base, payload: r.system_payload };

  try {
    const content = decryptChat(env.CHAT_ENCRYPTION_KEY, eventId, r.id, r.ciphertext!, r.iv!);
    return r.kind === 'text'
      ? { ...base, text: 'text' in content ? content.text : '' }
      : {
          ...base,
          caption: 'caption' in content ? content.caption : '',
          attachment: { file_id: r.attachment_file_id, mime: r.file_mime, size_bytes: r.file_size },
        };
  } catch (err) {
    // wrong key, or the row was altered: never crash the whole conversation over one message
    logger.error({ err, messageId: r.id }, 'chat message could not be decrypted');
    return { ...base, unreadable: true as const };
  }
}

const cursorOf = (r: Row) => Buffer.from(JSON.stringify([r.cursor_ts, r.id])).toString('base64url');
function parseCursor(cursor: string): [string, string] {
  try {
    return z.tuple([z.string().min(10).max(40), z.string().uuid()]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'invalid_cursor');
  }
}

export async function sendMessage(ctx: EventContext, input: z.infer<typeof sendMessageSchema>) {
  assertCan(ctx, 'chat.write');
  const eventId = ctx.event.id;
  const content = input.kind === 'text' ? { text: input.text } : { caption: input.caption ?? '' };

  if (input.kind === 'attachment') await assertFileAttachable(pool, input.file_id, eventId, ctx.userId, 'chat');

  const sealed = encryptChat(env.CHAT_ENCRYPTION_KEY, eventId, input.id, content);
  const inserted = await pool.query(
    `insert into event_messages (id, event_id, sender_id, kind, ciphertext, iv, key_version, attachment_file_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (id) do nothing returning id`,
    [input.id, eventId, ctx.userId, input.kind, sealed.ciphertext, sealed.iv, CHAT_KEY_VERSION, input.kind === 'attachment' ? input.file_id : null],
  );

  if (!inserted.rows[0]) {
    // The id already exists: a retry of the same send is fine, anything else is a clash.
    if (!(await isSameMessage(eventId, ctx.userId, input))) throw new HttpError(409, 'duplicate_id');
    const existing = (await pool.query(`${SELECT} where m.id = $1`, [input.id])).rows[0] as Row;
    return { message: toView(eventId, existing), created: false };
  }

  const row = (await pool.query(`${SELECT} where m.id = $1`, [input.id])).rows[0] as Row;
  emitDomainEvent({ type: 'chat.message', eventId, actorId: ctx.userId, messageId: input.id });
  return { message: toView(eventId, row), created: true };
}

async function isSameMessage(eventId: string, userId: string, input: z.infer<typeof sendMessageSchema>): Promise<boolean> {
  const { rows } = await pool.query(
    'select event_id, sender_id, kind, ciphertext, iv, attachment_file_id, deleted_at from event_messages where id = $1',
    [input.id],
  );
  const r = rows[0];
  if (!r || r.event_id !== eventId || r.sender_id !== userId || r.kind !== input.kind) return false;
  if (r.deleted_at) return true; // already sent, and since removed: a retry must not resurrect it
  try {
    const content = decryptChat(env.CHAT_ENCRYPTION_KEY, eventId, input.id, r.ciphertext, r.iv);
    return input.kind === 'text'
      ? 'text' in content && content.text === input.text
      : 'caption' in content && content.caption === (input.caption ?? '') && r.attachment_file_id === input.file_id;
  } catch {
    return false;
  }
}

export async function listMessages(ctx: EventContext, query: z.infer<typeof listMessagesQuerySchema>) {
  const eventId = ctx.event.id;
  const serverTime = (await pool.query(`select ${TS('clock_timestamp()')} as t`)).rows[0].t as string;

  if (query.since) {
    const { rows } = await pool.query(
      `${SELECT}
        where m.event_id = $1
          and (m.created_at > $2::timestamptz - make_interval(secs => $3)
               or m.deleted_at > $2::timestamptz - make_interval(secs => $3))
        order by m.created_at asc, m.id asc
        limit $4`,
      [eventId, query.since, POLL_OVERLAP_SECONDS, POLL_LIMIT],
    );
    return { messages: (rows as Row[]).map(r => toView(eventId, r)), next_before: null, server_time: serverTime };
  }

  const before = query.before ? parseCursor(query.before) : null;
  const { rows } = await pool.query(
    `${SELECT}
      where m.event_id = $1
        and ($2::timestamptz is null or (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
      order by m.created_at desc, m.id desc
      limit $4`,
    [eventId, before?.[0] ?? null, before?.[1] ?? null, query.limit + 1],
  );
  const hasMore = rows.length > query.limit;
  const page = (rows as Row[]).slice(0, query.limit);
  const oldest = page[page.length - 1];
  return {
    messages: page.reverse().map(r => toView(eventId, r)),
    next_before: hasMore && oldest ? cursorOf(oldest) : null,
    server_time: serverTime,
  };
}

/** Removes a message for everyone. The content is erased, not just hidden. */
export async function deleteMessage(ctx: EventContext, messageId: string) {
  const eventId = ctx.event.id;
  const { rows } = await pool.query(
    `select m.id, m.sender_id, m.kind, f.storage_key
       from event_messages m left join files f on f.id = m.attachment_file_id
      where m.id = $1 and m.event_id = $2 and m.deleted_at is null`,
    [messageId, eventId],
  );
  const msg = rows[0];
  if (!msg) throw new HttpError(404, 'message_not_found');
  assertCan(ctx, 'chat.delete_message', { sender_id: msg.sender_id });

  const done = await pool.query(
    `update event_messages set deleted_at = now(), deleted_by = $3, ciphertext = case when ciphertext is null then null else '\\x'::bytea end,
            iv = case when iv is null then null else '\\x'::bytea end, system_payload = case when kind = 'system' then '{}'::jsonb else system_payload end
      where id = $1 and event_id = $2 and deleted_at is null`,
    [messageId, eventId, ctx.userId],
  );
  if (!done.rowCount) return { ok: true }; // someone else removed it a moment ago

  if (msg.storage_key) await storage.remove(msg.storage_key).catch(err => logger.error({ err }, 'could not remove chat attachment'));
  await logAudit(pool, {
    eventId, actorId: ctx.userId, action: 'CHAT_MESSAGE_REMOVED', targetType: 'message', targetId: messageId,
    metadata: { own_message: msg.sender_id === ctx.userId, kind: msg.kind },
  });
  return { ok: true };
}
