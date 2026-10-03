import { Request, Router } from 'express';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { chatLimiter } from '../../../middleware/rateLimit';
import { can } from '../access';
import { eventIdOf, idParam, route } from '../shared/http';
import { listMessagesQuerySchema, sendMessageSchema } from './chat.schemas';
import * as svc from './chat.service';

/** Mounted under /events/:eventId. */
const router = Router({ mergeParams: true });

async function messageFacts(req: Request) {
  const { rows } = await pool.query('select sender_id from event_messages where id = $1 and event_id = $2 and deleted_at is null', [idParam(req, 'messageId'), eventIdOf(req)]);
  if (!rows[0]) throw new HttpError(404, 'message_not_found');
  return { sender_id: rows[0].sender_id as string | null };
}

router.get('/messages', can('chat.read'), route(async (req, res) => {
  res.json(await svc.listMessages(req.eventCtx!, listMessagesQuerySchema.parse(req.query)));
}));

router.post('/messages', chatLimiter, can('chat.write'), route(async (req, res) => {
  const { message, created } = await svc.sendMessage(req.eventCtx!, sendMessageSchema.parse(req.body));
  res.status(created ? 201 : 200).json({ message });
}));

router.delete('/messages/:messageId', chatLimiter, can('chat.delete_message', messageFacts), route(async (req, res) => {
  res.json(await svc.deleteMessage(req.eventCtx!, idParam(req, 'messageId')));
}));

export default router;
