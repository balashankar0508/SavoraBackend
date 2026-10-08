import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth';
import { authLimiter, emailCodeLimiter, refreshLimiter } from '../../middleware/rateLimit';
import * as ctrl from './auth.controller';

const router = Router();

function wrap(fn: (req: any, res: any) => Promise<void>) {
  return (req: any, res: any, next: any) => fn(req, res).catch(next);
}

router.post('/register', authLimiter, emailCodeLimiter, wrap(ctrl.registerHandler));
router.post('/verify-email', authLimiter, emailCodeLimiter, wrap(ctrl.verifyEmailHandler));
router.post('/resend-verification', authLimiter, emailCodeLimiter, wrap(ctrl.resendVerificationHandler));
router.post('/login', authLimiter, wrap(ctrl.loginHandler));
router.post('/refresh', refreshLimiter, wrap(ctrl.refreshHandler));
router.post('/logout', refreshLimiter, wrap(ctrl.logoutHandler));
router.post('/forgot-password', authLimiter, emailCodeLimiter, wrap(ctrl.forgotPasswordHandler));
router.post('/reset-password', authLimiter, emailCodeLimiter, wrap(ctrl.resetPasswordHandler));
router.post('/change-password', requireAuth, authLimiter, wrap(ctrl.changePasswordHandler));
router.patch('/profile', requireAuth, wrap(ctrl.updateProfileHandler));
router.get('/me', requireAuth, wrap(ctrl.meHandler));

export default router;
