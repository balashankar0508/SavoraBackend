import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import * as ctrl from './goals.controller';

const router = Router();

function wrap(fn: (req: any, res: any) => Promise<void>) {
  return (req: any, res: any, next: any) => fn(req, res).catch(next);
}

router.use(requireAuth);

router.get('/', wrap(ctrl.listHandler));
router.post('/', wrap(ctrl.createHandler));
router.patch('/:id', wrap(ctrl.updateHandler));
router.delete('/:id', wrap(ctrl.deleteHandler));
router.post('/:id/contribute', wrap(ctrl.contributeHandler));

router.get('/:id/contributions', wrap(ctrl.listContributionsHandler));
router.post('/:id/contributions', wrap(ctrl.addContributionHandler));
router.delete('/:id/contributions/:contributionId', wrap(ctrl.deleteContributionHandler));

export default router;
