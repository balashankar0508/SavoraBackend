import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { generalLimiter } from './middleware/rateLimit';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { requestId } from './middleware/requestId';
import filesRoutes from './modules/files/files.routes';
import authRoutes from './modules/auth/auth.routes';
import transactionsRoutes from './modules/transactions/transactions.routes';
import goalsRoutes from './modules/goals/goals.routes';
import aiRoutes from './modules/ai/ai.routes';

export function createApp() {
  const app = express();

  // Behind Nginx on the same box — trust the first hop so req.ip (and
  // express-rate-limit's IP-based keying) reads X-Forwarded-For correctly.
  app.set('trust proxy', 1);

  // One structured JSON line per request (method, path, status, duration,
  // IP) to stdout — PM2 captures that into out-*.log, so success traffic
  // is finally visible there instead of only errors landing in the logs.
  // Auth/refresh headers and password/token/OTP fields are redacted (see
  // logger.ts); /health is skipped to avoid drowning real traffic in
  // keepalive-check noise.
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as { requestId: string }).requestId,
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: '10mb' })); // receipt images are base64-inlined in the JSON body
  app.use(generalLimiter);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', authRoutes);
  app.use('/transactions', transactionsRoutes);
  app.use('/goals', goalsRoutes);
  app.use('/ai', aiRoutes);
  // Events v2 routers are mounted here as they are built (T2/T3). The pre-v2
  // routers (events.routes.ts, events.experience.routes.ts) are intentionally
  // unmounted: they target tables dropped by migration 008 and are deleted in T2.
  app.use(filesRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
