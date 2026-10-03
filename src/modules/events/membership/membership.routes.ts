import { Request, Router } from 'express';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { eventMutationLimiter } from '../../../middleware/rateLimit';
import { can } from '../access';
import { eventIdOf, idParam, route } from '../shared/http';
import * as svc from './membership.service';

const router = Router({ mergeParams: true });

/** Facts about the member being acted on, for the policy check. */
async function targetMember(req: Request) {
  const { rows } = await pool.query(
    "select user_id, role from event_members where event_id = $1 and user_id = $2 and status = 'active'",
    [eventIdOf(req), idParam(req, 'memberId')],
  );
  if (!rows[0]) throw new HttpError(404, 'member_not_found');
  return rows[0] as { user_id: string; role: 'owner' | 'admin' | 'member' };
}

router.get('/members', can('event.view'), route(async (req, res) => {
  res.json(await svc.listMembers(req.eventCtx!));
}));

router.get('/members/:memberId/payment-profile', can('event.view'), route(async (req, res) => {
  res.json(await svc.getMemberPaymentProfile(req.eventCtx!, idParam(req, 'memberId')));
}));

router.post('/members/:memberId/approve', eventMutationLimiter, can('member.approve_request'), route(async (req, res) => {
  res.json(await svc.approveRequest(eventIdOf(req), req.userId, idParam(req, 'memberId')));
}));

router.post('/members/:memberId/reject', eventMutationLimiter, can('member.approve_request'), route(async (req, res) => {
  res.json(await svc.rejectRequest(eventIdOf(req), req.userId, idParam(req, 'memberId')));
}));

router.post('/members/:memberId/promote', eventMutationLimiter, can('member.promote', targetMember), route(async (req, res) => {
  res.json(await svc.promote(eventIdOf(req), req.userId, idParam(req, 'memberId')));
}));

router.post('/members/:memberId/demote', eventMutationLimiter, can('member.demote', targetMember), route(async (req, res) => {
  res.json(await svc.demote(eventIdOf(req), req.userId, idParam(req, 'memberId')));
}));

router.post('/members/:memberId/remove', eventMutationLimiter, can('member.remove', targetMember), route(async (req, res) => {
  res.json(await svc.removeMember(eventIdOf(req), req.userId, idParam(req, 'memberId')));
}));

router.post('/leave', eventMutationLimiter, can('member.leave'), route(async (req, res) => {
  res.json(await svc.leaveEvent(eventIdOf(req), req.userId));
}));

export default router;
