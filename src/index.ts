import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { startNotifications } from './modules/notifications';

startNotifications(); // push notifications follow domain events
const app = createApp();

app.listen(env.PORT, () => {
  logger.info(`Spenxo backend listening on port ${env.PORT} (${env.NODE_ENV})`);
});
