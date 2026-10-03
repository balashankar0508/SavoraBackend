import { pool } from '../../../db/pool';
import { env } from '../../../config/env';
import { HttpError } from '../../../lib/httpError';
import { hmacHex, openString, sealString } from '../../../lib/secretBox';
import { sendEventInviteEmail } from '../../../lib/mailer';
import { Queryable } from '../access/context';
import { assertCan } from '../access/denial';
import { withEventLock } from '../access/lock';
import { EventContext } from '../access/types';
import { logActivity, logAudit, postSystemMessage } from '../shared/audit';
import { generateInviteCode, normalizeInviteCode } from '../shared/codes';
import { emitDomainEvent } from '../shared/domainEvents';
import { loadNames } from '../shared/ledgerState';

const LABEL_LOOKUP = 'invite-lookup';
const LABEL_SEAL = 'invite-seal';
const MAX_ACTIVE_MEMBERS = 100;
const EMAILS_PER_DAY = 20;
const MAX_SENDS_PER_INVITATION = 5;

const lookupHash = (body: string) => hmacHex(env.INVITE_CODE_KEY, LABEL_LOOKUP, body);
export const deepLinkFor = (code: string) => `spenxo://join?code=${encodeURIComponent(code)}`;

/**
 * Creates (or replaces) the event's single invite code, valid for 7 days. The old
 * code stops working immediately because the row is overwritten. Runs inside the
 * caller's transaction.
 */
export async function createInviteCode(db: Queryable, eventId: string, createdBy: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const hash = lookupHash(normalizeInviteCode(code)!);
    const taken = await db.query('select 1 from event_invite_codes where code_hmac = $1 and event_id <> $2', [hash, eventId]);
    if (taken.rows[0]) continue; // astronomically unlikely; the unique index is the final guard
    await db.query(
      `insert into event_invite_codes (event_id, code_hmac, code_enc, expires_at, created_by)
       values ($1, $2, $3, now() + interval '7 days', $4)
       on conflict (event_id) do update
         set code_hmac = excluded.code_hmac, code_enc = excluded.code_enc, expires_at = excluded.expires_at,
             created_by = excluded.created_by, revoked_at = null, created_at = now()`,
      [eventId, hash, sealString(env.INVITE_CODE_KEY, LABEL_SEAL, code, eventId), createdBy],
    );
    return code;
  }
  throw new HttpError(500, 'invite_code_generation_failed');
}

type CodeStatus = 'active' | 'expired' | 'revoked' | 'none';

async function readInviteCode(db: Queryable, eventId: string) {
  const { rows } = await db.query(
    `select code_enc, expires_at, revoked_at, created_at, (expires_at <= now()) as expired
       from event_invite_codes where event_id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (!row) return { status: 'none' as CodeStatus, code: null as string | null, expires_at: null as string | null };
  const status: CodeStatus = row.revoked_at ? 'revoked' : row.expired ? 'expired' : 'active';
  return {
    status,
    // the code itself is only ever returned while it can actually be used
    code: status === 'active' ? openString(env.INVITE_CODE_KEY, LABEL_SEAL, row.code_enc, eventId) : null,
    expires_at: row.expires_at as string,
  };
}

export async function getInviteCode(ctx: EventContext) {
  assertCan(ctx, 'invite.view_code');
  const info = await readInviteCode(pool, ctx.event.id);
  return {
    ...info,
    deep_link: info.code ? deepLinkFor(info.code) : null,
    join_policy: ctx.event.join_policy,
  };
}

export async function regenerateInviteCode(eventId: string, userId: string) {
  return withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'invite.regenerate');
    const code = await createInviteCode(client, eventId, userId);
    await logAudit(client, { eventId, actorId: userId, action: 'INVITATION_REGENERATED' });
    return { status: 'active' as const, code, deep_link: deepLinkFor(code), join_policy: ctx.event.join_policy };
  });
}

export async function revokeInviteCode(eventId: string, userId: string) {
  return withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'invite.revoke');
    await client.query('update event_invite_codes set revoked_at = now() where event_id = $1 and revoked_at is null', [eventId]);
    await logAudit(client, { eventId, actorId: userId, action: 'INVITATION_REVOKED' });
    return { status: 'revoked' as const };
  });
}

// ── Joining ─────────────────────────────────────────────────────

export type JoinResult =
  | { status: 'active' | 'pending'; event: { id: string; title: string } };

/**
 * Join with a code. Every way the code can be unusable (typo, expired, revoked,
 * replaced) returns the same 404 so a guesser learns nothing.
 *  - admins_only: only people an admin invited by email can join,
 *  - code_approval (and anyone previously removed): the request waits for approval,
 *  - an admin's email invitation to your address always admits you directly.
 */
export async function joinWithCode(userId: string, rawCode: string): Promise<JoinResult> {
  const invalid = () => new HttpError(404, 'invite_expired_or_invalid');
  const body = normalizeInviteCode(rawCode);
  if (!body) throw invalid();
  const hash = lookupHash(body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      'select event_id from event_invite_codes where code_hmac = $1 and revoked_at is null and expires_at > now()',
      [hash],
    );
    if (!found.rows[0]) throw invalid();
    const eventId: string = found.rows[0].event_id;

    const event = (await client.query('select id, title, status, join_policy from events where id = $1 for update', [eventId])).rows[0];
    // re-check under the lock: an admin may have regenerated or revoked it meanwhile
    const still = await client.query(
      'select 1 from event_invite_codes where event_id = $1 and code_hmac = $2 and revoked_at is null and expires_at > now()',
      [eventId, hash],
    );
    if (!event || !still.rows[0]) throw invalid();
    if (event.status !== 'active') throw new HttpError(409, 'event_not_active');

    const existing = (await client.query('select status from event_members where event_id = $1 and user_id = $2', [eventId, userId])).rows[0];
    const brief = { id: event.id as string, title: event.title as string };
    if (existing?.status === 'active') return { status: 'active', event: brief };
    if (existing?.status === 'pending') return { status: 'pending', event: brief };

    const me = (await client.query('select name, email from users where id = $1', [userId])).rows[0];
    const invitation = (
      await client.query(
        "select id from event_email_invitations where event_id = $1 and email = $2 and status = 'pending' for update",
        [eventId, String(me.email).toLowerCase()],
      )
    ).rows[0];

    if (event.join_policy === 'admins_only' && !invitation) throw new HttpError(403, 'admin_invitation_required');

    const needsApproval = !invitation && (event.join_policy === 'code_approval' || existing?.status === 'removed');
    const status = needsApproval ? 'pending' : 'active';

    if (status === 'active') {
      const count = (await client.query("select count(*)::int as n from event_members where event_id = $1 and status = 'active'", [eventId])).rows[0].n;
      if (count >= MAX_ACTIVE_MEMBERS) throw new HttpError(409, 'event_member_limit');
    }

    await client.query(
      `insert into event_members (event_id, user_id, role, status, joined_at)
       values ($1, $2, 'member', $3, case when $3 = 'active' then now() end)
       on conflict (event_id, user_id) do update
         set status = excluded.status, role = 'member', joined_at = excluded.joined_at, removed_at = null`,
      [eventId, userId, status],
    );
    if (invitation) await client.query("update event_email_invitations set status = 'accepted' where id = $1", [invitation.id]);

    if (status === 'active') {
      await logActivity(client, { eventId, actorId: userId, kind: 'member_joined', summary: `${me.name} joined the event` });
      await logAudit(client, { eventId, actorId: userId, action: 'MEMBER_JOINED', targetType: 'member', targetId: userId });
      await postSystemMessage(client, eventId, { type: 'member_joined', user_id: userId, user_name: me.name });
    } else {
      await logAudit(client, { eventId, actorId: userId, action: 'JOIN_REQUESTED', targetType: 'member', targetId: userId });
    }
    await client.query('COMMIT');
    emitDomainEvent({ type: status === 'active' ? 'member.joined' : 'member.requested', eventId, actorId: userId, userId });
    return { status, event: brief };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Pending requests and email invitations (staff screens) ─────

export async function listInvitations(ctx: EventContext) {
  assertCan(ctx, 'invite.cancel'); // staff only
  const [requests, invitations] = await Promise.all([
    pool.query(
      `select m.user_id, u.name, m.created_at as requested_at
         from event_members m join users u on u.id = m.user_id
        where m.event_id = $1 and m.status = 'pending' order by m.created_at`,
      [ctx.event.id],
    ),
    pool.query(
      `select id, email, status, last_sent_at, send_count, created_at
         from event_email_invitations where event_id = $1 and status in ('pending', 'accepted')
        order by created_at desc limit 100`,
      [ctx.event.id],
    ),
  ]);
  return { join_requests: requests.rows, email_invitations: invitations.rows };
}

async function assertEmailQuota(client: Queryable, eventId: string) {
  const { rows } = await client.query(
    "select coalesce(sum(send_count), 0)::int as sent from event_email_invitations where event_id = $1 and last_sent_at > now() - interval '1 day'",
    [eventId],
  );
  if (rows[0].sent >= EMAILS_PER_DAY) throw new HttpError(429, 'too_many_invitations');
}

async function deliverInvite(email: string, eventId: string, inviterId: string, title: string) {
  const info = await readInviteCode(pool, eventId);
  if (!info.code) throw new HttpError(409, 'no_active_invite_code');
  const inviter = (await loadNames(pool, [inviterId])).get(inviterId) ?? 'A Spenxo user';
  try {
    await sendEventInviteEmail(email, { inviterName: inviter, eventTitle: title, code: info.code, deepLink: deepLinkFor(info.code) });
  } catch {
    throw new HttpError(502, 'email_send_failed');
  }
}

export async function sendEmailInvitation(eventId: string, userId: string, rawEmail: string) {
  const email = rawEmail.trim().toLowerCase();
  const { invitation, title } = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'invite.email');
    const member = await client.query(
      `select 1 from event_members m join users u on u.id = m.user_id
        where m.event_id = $1 and m.status = 'active' and lower(u.email) = $2`,
      [eventId, email],
    );
    if (member.rows[0]) throw new HttpError(409, 'already_member');
    const info = await readInviteCode(client, eventId);
    if (!info.code) throw new HttpError(409, 'no_active_invite_code');
    await assertEmailQuota(client, eventId);

    const { rows } = await client.query(
      `insert into event_email_invitations (event_id, email, invited_by) values ($1, $2, $3)
       on conflict (event_id, email) where status = 'pending'
       do update set last_sent_at = now(), send_count = event_email_invitations.send_count + 1
       returning id, email, status, last_sent_at, send_count, created_at`,
      [eventId, email, userId],
    );
    await logAudit(client, { eventId, actorId: userId, action: 'EMAIL_INVITATION_SENT', targetType: 'invitation', targetId: rows[0].id });
    return { invitation: rows[0], title: ctx.event.title as string };
  });
  await deliverInvite(email, eventId, userId, title);
  return { invitation };
}

export async function resendEmailInvitation(eventId: string, userId: string, invitationId: string) {
  const { invitation, title } = await withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'invite.email');
    const row = (
      await client.query(
        `select id, email, send_count, (last_sent_at > now() - interval '1 minute') as too_soon
           from event_email_invitations where id = $1 and event_id = $2 and status = 'pending' for update`,
        [invitationId, eventId],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'invitation_not_found');
    if (row.too_soon) throw new HttpError(429, 'resend_too_soon');
    if (row.send_count >= MAX_SENDS_PER_INVITATION) throw new HttpError(429, 'too_many_invitations');
    await assertEmailQuota(client, eventId);

    const { rows } = await client.query(
      `update event_email_invitations set last_sent_at = now(), send_count = send_count + 1 where id = $1
       returning id, email, status, last_sent_at, send_count, created_at`,
      [invitationId],
    );
    await logAudit(client, { eventId, actorId: userId, action: 'EMAIL_INVITATION_RESENT', targetType: 'invitation', targetId: invitationId });
    return { invitation: rows[0], title: ctx.event.title as string };
  });
  await deliverInvite(invitation.email, eventId, userId, title);
  return { invitation };
}

export async function cancelEmailInvitation(eventId: string, userId: string, invitationId: string) {
  return withEventLock(eventId, userId, async (client, ctx) => {
    assertCan(ctx, 'invite.cancel');
    const { rowCount } = await client.query(
      "update event_email_invitations set status = 'cancelled' where id = $1 and event_id = $2 and status = 'pending'",
      [invitationId, eventId],
    );
    if (!rowCount) throw new HttpError(404, 'invitation_not_found');
    await logAudit(client, { eventId, actorId: userId, action: 'EMAIL_INVITATION_CANCELLED', targetType: 'invitation', targetId: invitationId });
    return { ok: true };
  });
}

