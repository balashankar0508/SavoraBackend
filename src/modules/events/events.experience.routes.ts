import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/requireAuth';
import { HttpError } from '../../lib/httpError';
import { balances, splitExpense } from './events.math';
import { eventMutationLimiter } from '../../middleware/rateLimit';

const router = Router();
router.use(requireAuth);
const uuid = z.string().uuid();
const money = z.number().int().positive().max(1000000000);
const route = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

async function eventFor(userId: string, eventId: string, owner = false) {
  const { rows } = await pool.query(
    `select e.*,m.role as member_role from events e join event_members m on m.event_id=e.id
     where e.id=$1 and m.user_id=$2 and m.status='active'`,
    [uuid.parse(eventId), userId],
  );
  if (!rows[0]) throw new HttpError(404, 'event_not_found');
  if (owner && rows[0].owner_id !== userId) throw new HttpError(403, 'owner_required');
  return rows[0];
}

router.patch('/:id', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id, true);
  const data = z.object({
    title: z.string().trim().min(1).max(100).optional(),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    budget_paise: money.optional(),
    location: z.string().trim().max(120).nullable().optional(),
    cover_emoji: z.string().min(1).max(16).optional(),
  }).refine(value => Object.keys(value).length > 0).parse(req.body);
  const fields = Object.keys(data);
  const values = fields.map(key => (data as Record<string, unknown>)[key]);
  const { rows } = await pool.query(
    `update events set ${fields.map((key, index) => `${key}=$${index + 3}`).join(',')},updated_at=now()
     where id=$1 and owner_id=$2 returning *`,
    [event.id, req.userId, ...values],
  );
  res.json({ event: rows[0] });
}));

router.put('/:id/categories', route(async (req, res) => {
  await eventFor(req.userId, req.params.id, true);
  const categories = z.array(z.object({
    name: z.string().trim().min(1).max(40), budget_paise: z.number().int().min(0).max(1000000000),
    icon: z.string().min(1).max(16), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })).max(20).parse(req.body.categories);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from event_budget_categories where event_id=$1', [req.params.id]);
    for (const item of categories) await client.query(
      'insert into event_budget_categories(event_id,name,budget_paise,icon,color) values($1,$2,$3,$4,$5)',
      [req.params.id, item.name, item.budget_paise, item.icon, item.color],
    );
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  res.json({ categories });
}));

router.patch('/:id/settlement-settings', route(async (req, res) => {
  await eventFor(req.userId, req.params.id, true);
  const { requires_approval } = z.object({ requires_approval: z.boolean() }).parse(req.body);
  await pool.query('update events set settlement_requires_approval=$2,updated_at=now() where id=$1', [req.params.id, requires_approval]);
  res.json({ requires_approval });
}));

router.put('/:id/payment-profile', route(async (req, res) => {
  await eventFor(req.userId, req.params.id);
  const { upi_id } = z.object({
    upi_id: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,256}@[a-z0-9.-]{2,64}$/),
  }).parse(req.body);
  await pool.query('update event_members set payment_upi_id=$3 where event_id=$1 and user_id=$2', [req.params.id, req.userId, upi_id]);
  res.json({ upi_id });
}));

router.post('/:id/settlements/:settlementId/proof', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  const data = z.object({
    proof_name: z.string().trim().min(1).max(160),
    proof_mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
    proof_data: z.string().min(32).max(7500000),
  }).parse(req.body);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const settlement = (await client.query(
      'select * from event_settlements where id=$1 and event_id=$2 for update',
      [uuid.parse(req.params.settlementId), event.id],
    )).rows[0];
    if (!settlement) throw new HttpError(404, 'settlement_not_found');
    if (settlement.from_user !== req.userId) throw new HttpError(403, 'payer_required');
    if (!['pending_payment', 'rejected'].includes(settlement.status)) throw new HttpError(409, 'proof_already_submitted');
    const nextStatus = event.settlement_requires_approval ? 'pending_approval' : 'completed';
    const { rows } = await client.query(
      `update event_settlements set proof_name=$3,proof_mime=$4,proof_data=$5,
       proof_submitted_at=now(),status=$6,confirmed=$7,confirmed_at=case when $7 then now() else null end,
       rejection_reason=null where id=$1 and event_id=$2 returning *`,
      [settlement.id,event.id,data.proof_name,data.proof_mime,data.proof_data,nextStatus,!event.settlement_requires_approval],
    );
    await client.query(
      "insert into event_activity(event_id,actor_id,kind,summary,amount_paise) values($1,$2,'settlement_proof_submitted',$3,$4)",
      [event.id,req.userId,event.settlement_requires_approval ? 'Submitted payment proof for approval' : 'Submitted payment proof; settlement completed',settlement.amount_paise],
    );
    await client.query('commit');
    res.json({ settlement: rows[0] });
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}));

router.post('/:id/settlements/:settlementId/reject', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  const settlement = (await pool.query('select * from event_settlements where id=$1 and event_id=$2', [uuid.parse(req.params.settlementId), event.id])).rows[0];
  if (!settlement) throw new HttpError(404, 'settlement_not_found');
  if (settlement.to_user !== req.userId && event.owner_id !== req.userId) throw new HttpError(403, 'reviewer_required');
  if (settlement.status !== 'pending_approval') throw new HttpError(409, 'settlement_not_pending_approval');
  await pool.query("update event_settlements set status='rejected',confirmed=false,reviewed_by=$2,reviewed_at=now(),rejection_reason=$3 where id=$1", [settlement.id,req.userId,reason]);
  res.json({ ok: true });
}));

router.get('/:id/settlements/:settlementId/proof', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  const settlement = (await pool.query(
    'select * from event_settlements where id=$1 and event_id=$2',
    [uuid.parse(req.params.settlementId), event.id],
  )).rows[0];
  if (!settlement) throw new HttpError(404, 'settlement_not_found');
  if (settlement.from_user !== req.userId && settlement.to_user !== req.userId && event.owner_id !== req.userId)
    throw new HttpError(403, 'proof_access_denied');
  if (!settlement.proof_data) throw new HttpError(404, 'proof_not_found');
  res.json({ name: settlement.proof_name, mime: settlement.proof_mime, data: settlement.proof_data });
}));

router.delete('/:id/members/:memberId', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (!['owner','admin'].includes(event.member_role)) throw new HttpError(403, 'admin_required');
  const memberId = uuid.parse(req.params.memberId);
  if (memberId === event.owner_id) throw new HttpError(400, 'cannot_remove_owner');
  const memberIds = (await pool.query("select user_id from event_members where event_id=$1 and status='active'", [event.id])).rows.map(row => row.user_id);
  const expenses = (await pool.query("select * from event_expenses where event_id=$1 and status='active'", [event.id])).rows;
  const settlements = (await pool.query("select * from event_settlements where event_id=$1 and confirmed=true", [event.id])).rows;
  if ((balances(memberIds,expenses,settlements)[memberId] ?? 0) !== 0) throw new HttpError(409, 'settle_member_balance_first');
  const target = (await pool.query('select role,status from event_members where event_id=$1 and user_id=$2', [event.id,memberId])).rows[0];
  if (!target || target.status !== 'active') throw new HttpError(404, 'member_not_found');
  if (event.member_role === 'admin' && target.role !== 'member') throw new HttpError(403, 'owner_required');
  const result = await pool.query("update event_members set status='removed',removed_at=now(),updated_at=now() where event_id=$1 and user_id=$2 and status='active'", [event.id, memberId]);
  if (!result.rowCount) throw new HttpError(404, 'member_not_found');
  res.json({ ok: true });
}));

router.post('/:id/members/:memberId/promote', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id, true);
  const memberId = uuid.parse(req.params.memberId);
  if (memberId === req.userId) throw new HttpError(400, 'cannot_change_own_role');
  const result = await pool.query("update event_members set role='admin',updated_at=now() where event_id=$1 and user_id=$2 and status='active' and role='member' returning user_id", [event.id,memberId]);
  if (!result.rowCount) throw new HttpError(404, 'active_member_not_found');
  await pool.query("insert into event_audit_logs(event_id,actor_id,action,target_type,target_id) values($1,$2,'MEMBER_PROMOTED','member',$3)", [event.id,req.userId,memberId]);
  res.json({ ok: true });
}));

router.post('/:id/members/:memberId/demote', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id, true);
  const memberId = uuid.parse(req.params.memberId);
  const result = await pool.query("update event_members set role='member',updated_at=now() where event_id=$1 and user_id=$2 and status='active' and role='admin' returning user_id", [event.id,memberId]);
  if (!result.rowCount) throw new HttpError(404, 'active_admin_not_found');
  await pool.query("insert into event_audit_logs(event_id,actor_id,action,target_type,target_id) values($1,$2,'MEMBER_DEMOTED','member',$3)", [event.id,req.userId,memberId]);
  res.json({ ok: true });
}));

router.post('/:id/members/requests/:memberId/approve', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (!['owner','admin'].includes(event.member_role)) throw new HttpError(403, 'admin_required');
  const memberId = uuid.parse(req.params.memberId);
  const result = await pool.query("update event_members set status='active',updated_at=now() where event_id=$1 and user_id=$2 and status='invited' returning user_id", [event.id,memberId]);
  if (!result.rowCount) throw new HttpError(404, 'join_request_not_found');
  await pool.query("insert into event_audit_logs(event_id,actor_id,action,target_type,target_id) values($1,$2,'JOIN_REQUEST_APPROVED','member',$3)", [event.id,req.userId,memberId]);
  res.json({ ok: true });
}));

router.post('/:id/members/requests/:memberId/reject', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (!['owner','admin'].includes(event.member_role)) throw new HttpError(403, 'admin_required');
  const memberId = uuid.parse(req.params.memberId);
  const result = await pool.query("update event_members set status='removed',removed_at=now(),updated_at=now() where event_id=$1 and user_id=$2 and status='invited' returning user_id", [event.id,memberId]);
  if (!result.rowCount) throw new HttpError(404, 'join_request_not_found');
  await pool.query("insert into event_audit_logs(event_id,actor_id,action,target_type,target_id) values($1,$2,'JOIN_REQUEST_REJECTED','member',$3)", [event.id,req.userId,memberId]);
  res.json({ ok: true });
}));

router.post('/:id/transfer-ownership', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id, true);
  const { new_owner_id } = z.object({ new_owner_id: uuid }).parse(req.body);
  if (new_owner_id === req.userId) throw new HttpError(400, 'already_owner');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const target = (await client.query("select 1 from event_members where event_id=$1 and user_id=$2 and status='active' for update", [event.id,new_owner_id])).rows[0];
    if (!target) throw new HttpError(404, 'active_member_not_found');
    await client.query("update event_members set role='member',updated_at=now() where event_id=$1 and user_id=$2", [event.id,req.userId]);
    await client.query("update event_members set role='owner',updated_at=now() where event_id=$1 and user_id=$2", [event.id,new_owner_id]);
    await client.query('update events set owner_id=$2,updated_at=now() where id=$1', [event.id,new_owner_id]);
    await client.query("insert into event_audit_logs(event_id,actor_id,action,target_type,target_id,metadata) values($1,$2,'OWNER_TRANSFERRED','member',$3,$4)", [event.id,req.userId,new_owner_id,JSON.stringify({ previous_owner_id: req.userId })]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  res.json({ ok: true });
}));

router.post('/:id/archive', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id, true);
  await pool.query("update events set status='archived',archived_at=now(),updated_at=now() where id=$1", [event.id]);
  await pool.query("insert into event_audit_logs(event_id,actor_id,action) values($1,$2,'EVENT_ARCHIVED')", [event.id,req.userId]);
  res.json({ ok: true });
}));

router.post('/:id/invitation-code/revoke', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (!['owner','admin'].includes(event.member_role)) throw new HttpError(403, 'admin_required');
  await pool.query('delete from event_invites where event_id=$1', [event.id]);
  await pool.query("insert into event_audit_logs(event_id,actor_id,action) values($1,$2,'INVITATION_REVOKED')", [event.id,req.userId]);
  res.json({ ok: true });
}));

router.get('/:id/audit-log', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (event.member_role !== 'owner') throw new HttpError(403, 'owner_required');
  const limit = z.coerce.number().int().min(1).max(100).default(30).parse(req.query.limit);
  const { rows } = await pool.query('select id,action,target_type,target_id,metadata,created_at from event_audit_logs where event_id=$1 order by created_at desc,id desc limit $2', [event.id,limit]);
  res.json({ audit: rows });
}));

router.patch('/:id/expenses/:expenseId', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (event.status !== 'active') throw new HttpError(409, 'event_completed');
  const existing = (await pool.query('select * from event_expenses where id=$1 and event_id=$2', [uuid.parse(req.params.expenseId), event.id])).rows[0];
  if (!existing) throw new HttpError(404, 'expense_not_found');
  if (existing.created_by !== req.userId && event.owner_id !== req.userId) throw new HttpError(403, 'forbidden');
  const data = z.object({
    title: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(40),
    amount_paise: money, expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expense_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), notes: z.string().trim().max(1000).optional(),
    payment_method: z.enum(['upi','cash','card','bank','other']), paid_by: uuid,
    mode: z.enum(['equal','percentage','custom','exact','shares']),
    splits: z.array(z.object({ user_id: uuid, value: z.number().int().min(0).max(1000000000) })).min(1).max(100),
  }).parse(req.body);
  const members = (await pool.query('select user_id from event_members where event_id=$1', [event.id])).rows.map(row => row.user_id);
  if (!members.includes(data.paid_by) || data.splits.some(item => !members.includes(item.user_id))) throw new HttpError(400, 'invalid_member');
  const splits = splitExpense(data.amount_paise, data.mode, data.splits);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `update event_expenses set title=$3,category=$4,amount_paise=$5,expense_date=$6,expense_time=$7,
       notes=$8,payment_method=$9,paid_by=$10,splits=$11,updated_at=now() where id=$1 and event_id=$2 and status='active' returning *`,
      [existing.id,event.id,data.title,data.category,data.amount_paise,data.expense_date,data.expense_time ?? null,
        data.notes ?? null,data.payment_method,data.paid_by,JSON.stringify(splits)],
    );
    if (!rows[0]) throw new HttpError(409, 'expense_not_active');
    await client.query("insert into event_activity(event_id,actor_id,kind,summary,amount_paise) values($1,$2,'expense_updated',$3,$4)", [event.id,req.userId,`Updated ${data.title}`,data.amount_paise]);
    await client.query("insert into event_audit_logs(event_id,actor_id,action,target_type,target_id,metadata) values($1,$2,'EXPENSE_UPDATED','expense',$3,$4)", [event.id,req.userId,existing.id,JSON.stringify({ previous_amount_paise: existing.amount_paise, amount_paise: data.amount_paise })]);
    await client.query('commit');
    res.json({ expense: rows[0] });
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}));

router.get('/:id/expenses', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.string().datetime().optional(),
    search: z.string().trim().max(100).optional(),
    category: z.string().trim().max(40).optional(),
  }).parse(req.query);
  const { rows } = await pool.query(
    `select *,expense_date::text from event_expenses where event_id=$1 and status='active'
     and ($2::timestamptz is null or created_at<$2)
     and ($3::text is null or title ilike '%' || $3 || '%')
     and ($4::text is null or category=$4)
     order by created_at desc,id desc limit $5`,
    [event.id,query.before ?? null,query.search ?? null,query.category ?? null,query.limit],
  );
  res.json({ expenses: rows, next_cursor: rows.length === query.limit ? rows[rows.length - 1].created_at : null });
}));

router.get('/:id/messages', route(async (req, res) => {
  await eventFor(req.userId, req.params.id);
  const before = z.string().datetime().optional().parse(req.query.before);
  const { rows } = await pool.query(
    `select m.*,u.name as sender_name,
      coalesce((select json_agg(json_build_object('user_id',r.user_id,'emoji',r.emoji)) from event_reactions r where r.message_id=m.id),'[]') as reactions
     from event_messages m join users u on u.id=m.sender_id
     where m.event_id=$1 and ($2::timestamptz is null or m.created_at<$2)
     order by m.created_at desc limit 100`,
    [req.params.id, before ?? null],
  );
  res.json({ messages: rows.reverse() });
}));

router.post('/:id/messages', eventMutationLimiter, route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (event.status !== 'active') throw new HttpError(409, 'event_completed');
  const data = z.object({
    id: uuid, ciphertext: z.string().min(24).max(9000000), nonce: z.string().min(16).max(64),
    key_version: z.number().int().positive().max(100).default(1),
  }).parse(req.body);
  const { rows } = await pool.query(
    `insert into event_messages(id,event_id,sender_id,ciphertext,nonce,key_version)
     values($1,$2,$3,$4,$5,$6) on conflict(id) do update set id=excluded.id
     where event_messages.event_id=excluded.event_id and event_messages.sender_id=excluded.sender_id returning *`,
    [data.id,event.id,req.userId,data.ciphertext,data.nonce,data.key_version],
  );
  if (!rows[0]) throw new HttpError(409, 'duplicate_id');
  res.status(201).json({ message: rows[0] });
}));

router.put('/:id/messages/:messageId/reactions/:emoji', route(async (req, res) => {
  await eventFor(req.userId, req.params.id);
  const messageId = uuid.parse(req.params.messageId);
  const emoji = z.string().min(1).max(16).parse(decodeURIComponent(req.params.emoji));
  const exists = await pool.query('select 1 from event_messages where id=$1 and event_id=$2', [messageId, req.params.id]);
  if (!exists.rowCount) throw new HttpError(404, 'message_not_found');
  await pool.query('insert into event_reactions(message_id,user_id,emoji) values($1,$2,$3) on conflict do nothing', [messageId, req.userId, emoji]);
  res.json({ ok: true });
}));

router.delete('/:id/messages/:messageId/reactions/:emoji', route(async (req, res) => {
  await eventFor(req.userId, req.params.id);
  await pool.query('delete from event_reactions where message_id=$1 and user_id=$2 and emoji=$3', [uuid.parse(req.params.messageId), req.userId, decodeURIComponent(req.params.emoji)]);
  res.json({ ok: true });
}));

router.delete('/:id/messages/:messageId', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id);
  if (!['owner','admin'].includes(event.member_role)) throw new HttpError(403, 'admin_required');
  const messageId = uuid.parse(req.params.messageId);
  const result = await pool.query('update event_messages set deleted_at=now(),deleted_by=$3 where id=$1 and event_id=$2 and deleted_at is null returning id', [messageId,event.id,req.userId]);
  if (!result.rowCount) throw new HttpError(404, 'message_not_found');
  await pool.query("insert into event_audit_logs(event_id,actor_id,action,target_type,target_id) values($1,$2,'CHAT_MESSAGE_REMOVED','message',$3)", [event.id,req.userId,messageId]);
  res.json({ ok: true });
}));

export default router;
