import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { eventContext } from './access';
import { collectionRoutes, eventRoutes } from './events/events.routes';
import expenseRoutes from './expenses/expenses.routes';
import invitationRoutes, { joinRoutes } from './invitations/invitations.routes';
import membershipRoutes from './membership/membership.routes';
import settlementRoutes from './settlements/settlements.routes';

/**
 * Everything under /events. Order matters:
 *   1. collection routes (/, /join) have no event yet, so they come first;
 *   2. eventContext() loads the caller's membership for /:eventId/** exactly once
 *      (non-members get 404 here, before any module code runs);
 *   3. each module then gates every route with can(<action>).
 */
const router = Router();
router.use(requireAuth);
router.use(collectionRoutes);
router.use(joinRoutes);

const scoped = Router({ mergeParams: true });
scoped.use(eventRoutes);
scoped.use(membershipRoutes);
scoped.use(invitationRoutes);
scoped.use(expenseRoutes);
scoped.use(settlementRoutes);
router.use('/:eventId', eventContext(), scoped);

export default router;
