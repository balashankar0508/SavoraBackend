import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.newPassword',
      'req.body.code',
      'req.body.token',
      'req.body.refreshToken',
      'req.body.image', // base64 receipt image — large and not useful in logs
    ],
    censor: '[redacted]',
  },
});
