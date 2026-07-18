import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { aiLimiter } from '../../middleware/rateLimit';
import * as ctrl from './ai.controller';

const router = Router();

function wrap(fn: (req: any, res: any) => Promise<void>) {
  return (req: any, res: any, next: any) => fn(req, res).catch(next);
}

router.post('/parse-receipt', requireAuth, aiLimiter, wrap(ctrl.parseReceiptHandler));

export default router;
