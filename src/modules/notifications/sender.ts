import fs from 'fs';
import { logger } from '../../lib/logger';
import { PushPayload } from './describe';

/** Delivers one payload to many device tokens. Returns the tokens the push service says are dead. */
export interface PushSender {
  send(tokens: string[], payload: PushPayload): Promise<{ invalidTokens: string[] }>;
}

/** Used when no Firebase credentials are configured: everything else keeps working. */
export class NoopSender implements PushSender {
  private warned = false;
  async send(tokens: string[], payload: PushPayload) {
    if (!this.warned) {
      this.warned = true;
      logger.warn('Push notifications are disabled: set FIREBASE_SERVICE_ACCOUNT_PATH to enable them');
    }
    logger.debug({ tokens: tokens.length, title: payload.title }, 'push skipped (disabled)');
    return { invalidTokens: [] };
  }
}

// FCM error codes meaning "this token will never work again" (uninstalled app, rotated token).
const DEAD_TOKEN_CODES = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

/** Android notification channel the app must create (notifee) for these pushes. */
export const ANDROID_CHANNEL_ID = 'spenxo-events';

export class FcmSender implements PushSender {
  private messaging: import('firebase-admin/messaging').Messaging | null = null;

  constructor(private readonly serviceAccountPath: string) {}

  private async client() {
    if (!this.messaging) {
      const { initializeApp, cert, getApps } = await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');
      const account = JSON.parse(fs.readFileSync(this.serviceAccountPath, 'utf8'));
      const app = getApps().find(a => a.name === 'spenxo') ?? initializeApp({ credential: cert(account) }, 'spenxo');
      this.messaging = getMessaging(app);
    }
    return this.messaging;
  }

  async send(tokens: string[], payload: PushPayload) {
    const messaging = await this.client();
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      android: {
        priority: 'high',
        notification: { channelId: ANDROID_CHANNEL_ID, ...(payload.tag ? { tag: payload.tag } : {}) },
      },
    });
    if (res.failureCount) {
      logger.warn({ failed: res.failureCount, of: tokens.length }, 'some push notifications failed');
    }
    return { invalidTokens: tokens.filter((_, i) => !res.responses[i].success && DEAD_TOKEN_CODES.has(res.responses[i].error?.code ?? '')) };
  }
}
