import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import * as ctrl from './transactions.controller';

const router = Router();

function wrap(fn: (req: any, res: any) => Promise<void>) {
  return (req: any, res: any, next: any) => fn(req, res).catch(next);
}

router.use(requireAuth);

router.get('/summary', wrap(ctrl.summaryHandler));
router.get('/', wrap(ctrl.listHandler));
router.post('/', wrap(ctrl.createHandler));
router.patch('/:id', wrap(ctrl.updateHandler));
router.delete('/:id', wrap(ctrl.deleteHandler));

export default router;
