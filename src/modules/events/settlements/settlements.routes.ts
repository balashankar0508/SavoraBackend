import { Request, Router } from 'express';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { eventMutationLimiter } from '../../../middleware/rateLimit';
import { assertCan, can } from '../access';
import { eventIdOf, idParam, route } from '../shared/http';
import {
  createSettlementSchema, listSettlementsQuerySchema, paymentProfileSchema, rejectSettlementSchema, remindSchema,
} from './settlements.schemas';
import * as svc from './settlements.service';

/** Mounted under /events/:eventId. */
const router = Router({ mergeParams: true });

async function settlementFacts(req: Request) {
  const { rows } = await pool.query(
    'select from_user, to_user, status from event_settlements where id = $1 and event_id = $2',
    [idParam(req, 'settlementId'), eventIdOf(req)],
  );
  if (!rows[0]) throw new HttpError(404, 'settlement_not_found');
  return rows[0] as { from_user: string; to_user: string; status: string };
}

router.get('/balances', can('event.view'), route(async (req, res) => {
  res.json(await svc.getBalances(req.eventCtx!));
}));

router.get('/settlements', can('event.view'), route(async (req, res) => {
  res.json(await svc.listSettlements(req.eventCtx!, listSettlementsQuerySchema.parse(req.query)));
}));

// "Mark as paid": records the payment as awaiting the recipient's confirmation. No balance moves yet.
router.post('/settlements', eventMutationLimiter,
  can('settlement.create', req => ({ to_user: createSettlementSchema.parse(req.body).to_user })),
  route(async (req, res) => {
    res.status(201).json(await svc.createSettlement(eventIdOf(req), req.userId, createSettlementSchema.parse(req.body)));
  }));

router.post('/settlements/:settlementId/confirm', eventMutationLimiter, can('settlement.confirm', settlementFacts), route(async (req, res) => {
  res.json(await svc.confirmSettlement(eventIdOf(req), req.userId, idParam(req, 'settlementId')));
}));

router.post('/settlements/:settlementId/reject', eventMutationLimiter, can('settlement.reject', settlementFacts), route(async (req, res) => {
  res.json(await svc.rejectSettlement(eventIdOf(req), req.userId, idParam(req, 'settlementId'), rejectSettlementSchema.parse(req.body ?? {})));
}));

router.post('/settlements/:settlementId/cancel', eventMutationLimiter, can('settlement.cancel', settlementFacts), route(async (req, res) => {
  res.json(await svc.cancelSettlement(eventIdOf(req), req.userId, idParam(req, 'settlementId')));
}));

// Remind / Request payment. The two kinds are different permissions in the policy.
router.post('/remind', eventMutationLimiter, route(async (req, res) => {
  const input = remindSchema.parse(req.body);
  assertCan(req.eventCtx!, input.kind === 'remind' ? 'settlement.remind' : 'settlement.request', { target_user: input.target_user });
  res.json(await svc.sendReminder(eventIdOf(req), req.userId, input));
}));

export default router;

/** /me/payment-profile: the caller's own UPI ID, reused in every event. */
export const meRoutes = Router();

meRoutes.get('/payment-profile', route(async (req, res) => {
  res.json(await svc.getMyPaymentProfile(req.userId));
}));

meRoutes.put('/payment-profile', eventMutationLimiter, route(async (req, res) => {
  res.json(await svc.setMyPaymentProfile(req.userId, paymentProfileSchema.parse(req.body)));
}));

meRoutes.delete('/payment-profile', eventMutationLimiter, route(async (req, res) => {
  res.json(await svc.clearMyPaymentProfile(req.userId));
}));
