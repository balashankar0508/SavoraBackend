import { Router } from 'express';
import { z } from 'zod';
import { eventMutationLimiter, joinLimiter } from '../../../middleware/rateLimit';
import { can } from '../access';
import { eventIdOf, idParam, route } from '../shared/http';
import * as svc from './invitations.service';

/** POST /events/join: the caller is not a member yet, so there is no event context. */
export const joinRoutes = Router();

joinRoutes.post('/join', joinLimiter, route(async (req, res) => {
  const { code } = z.object({ code: z.string().min(1).max(40) }).strict().parse(req.body);
  const result = await svc.joinWithCode(req.userId, code);
  // 202: the request exists but an admin still has to approve it
  res.status(result.status === 'pending' ? 202 : 200).json(result);
}));

/** Mounted under /events/:eventId. */
const router = Router({ mergeParams: true });

router.get('/invite-code', can('invite.view_code'), route(async (req, res) => {
  res.json(await svc.getInviteCode(req.eventCtx!));
}));

router.post('/invite-code/regenerate', eventMutationLimiter, can('invite.regenerate'), route(async (req, res) => {
  res.json(await svc.regenerateInviteCode(eventIdOf(req), req.userId));
}));

router.post('/invite-code/revoke', eventMutationLimiter, can('invite.revoke'), route(async (req, res) => {
  res.json(await svc.revokeInviteCode(eventIdOf(req), req.userId));
}));

router.get('/invitations', can('invite.cancel'), route(async (req, res) => {
  res.json(await svc.listInvitations(req.eventCtx!));
}));

router.post('/email-invitations', eventMutationLimiter, can('invite.email'), route(async (req, res) => {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict().parse(req.body);
  res.status(201).json(await svc.sendEmailInvitation(eventIdOf(req), req.userId, email));
}));

router.post('/email-invitations/:invitationId/resend', eventMutationLimiter, can('invite.email'), route(async (req, res) => {
  res.json(await svc.resendEmailInvitation(eventIdOf(req), req.userId, idParam(req, 'invitationId')));
}));

router.post('/email-invitations/:invitationId/cancel', eventMutationLimiter, can('invite.cancel'), route(async (req, res) => {
  res.json(await svc.cancelEmailInvitation(eventIdOf(req), req.userId, idParam(req, 'invitationId')));
}));

export default router;
