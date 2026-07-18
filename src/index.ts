import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';

const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`Spenxo backend listening on port ${env.PORT} (${env.NODE_ENV})`);
});
