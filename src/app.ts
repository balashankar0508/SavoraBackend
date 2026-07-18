import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import { generalLimiter } from './middleware/rateLimit';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import authRoutes from './modules/auth/auth.routes';
import transactionsRoutes from './modules/transactions/transactions.routes';
import goalsRoutes from './modules/goals/goals.routes';
import aiRoutes from './modules/ai/ai.routes';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: '10mb' })); // receipt images are base64-inlined in the JSON body
  app.use(generalLimiter);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', authRoutes);
  app.use('/transactions', transactionsRoutes);
  app.use('/goals', goalsRoutes);
  app.use('/ai', aiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
