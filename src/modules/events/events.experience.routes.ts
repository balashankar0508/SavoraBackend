import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/requireAuth';
import { HttpError } from '../../lib/httpError';
import { splitExpense } from './events.math';

const router = Router();
router.use(requireAuth);
const uuid = z.string().uuid();
const money = z.number().int().positive().max(1000000000);
const route = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

async function eventFor(userId: string, eventId: string, owner = false) {
  const { rows } = await pool.query(
    `select e.* from events e join event_members m on m.event_id=e.id
     where e.id=$1 and m.user_id=$2`,
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

router.delete('/:id/members/:memberId', route(async (req, res) => {
  const event = await eventFor(req.userId, req.params.id, true);
  const memberId = uuid.parse(req.params.memberId);
  if (memberId === event.owner_id) throw new HttpError(400, 'cannot_remove_owner');
  const referenced = await pool.query(
    `select 1 from event_expenses where event_id=$1 and (paid_by=$2 or splits @> $3::jsonb)
     union all select 1 from event_settlements where event_id=$1 and (from_user=$2 or to_user=$2) limit 1`,
    [event.id, memberId, JSON.stringify([{ user_id: memberId }])],
  );
  if (referenced.rowCount) throw new HttpError(409, 'member_has_financial_history');
  const result = await pool.query('delete from event_members where event_id=$1 and user_id=$2', [event.id, memberId]);
  if (!result.rowCount) throw new HttpError(404, 'member_not_found');
  res.json({ ok: true });
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
    mode: z.enum(['equal','percentage','custom']),
    splits: z.array(z.object({ user_id: uuid, value: z.number().int().min(0).max(1000000000) })).min(1).max(100),
  }).parse(req.body);
  const members = (await pool.query('select user_id from event_members where event_id=$1', [event.id])).rows.map(row => row.user_id);
  if (!members.includes(data.paid_by) || data.splits.some(item => !members.includes(item.user_id))) throw new HttpError(400, 'invalid_member');
  const splits = splitExpense(data.amount_paise, data.mode, data.splits);
  const { rows } = await pool.query(
    `update event_expenses set title=$3,category=$4,amount_paise=$5,expense_date=$6,expense_time=$7,
     notes=$8,payment_method=$9,paid_by=$10,splits=$11,updated_at=now() where id=$1 and event_id=$2 returning *`,
    [existing.id,event.id,data.title,data.category,data.amount_paise,data.expense_date,data.expense_time ?? null,
      data.notes ?? null,data.payment_method,data.paid_by,JSON.stringify(splits)],
  );
  res.json({ expense: rows[0] });
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

router.post('/:id/messages', route(async (req, res) => {
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

export default router;
