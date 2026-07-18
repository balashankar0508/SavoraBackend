import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { authLimiter } from '../../middleware/rateLimit';
import * as ctrl from './auth.controller';

const router = Router();

function wrap(fn: (req: any, res: any) => Promise<void>) {
  return (req: any, res: any, next: any) => fn(req, res).catch(next);
}

router.post('/register', authLimiter, wrap(ctrl.registerHandler));
router.post('/verify-email', authLimiter, wrap(ctrl.verifyEmailHandler));
router.post('/resend-verification', authLimiter, wrap(ctrl.resendVerificationHandler));
router.post('/login', authLimiter, wrap(ctrl.loginHandler));
router.post('/refresh', authLimiter, wrap(ctrl.refreshHandler));
router.post('/logout', authLimiter, wrap(ctrl.logoutHandler));
router.post('/forgot-password', authLimiter, wrap(ctrl.forgotPasswordHandler));
router.post('/reset-password', authLimiter, wrap(ctrl.resetPasswordHandler));
router.patch('/profile', requireAuth, wrap(ctrl.updateProfileHandler));
router.get('/me', requireAuth, wrap(ctrl.meHandler));

export default router;
