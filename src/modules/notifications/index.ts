import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { DomainEvent, domainEvents } from '../events/shared/domainEvents';
import { dispatch } from './planner';
import { FcmSender, NoopSender, PushSender } from './sender';

let sender: PushSender | null = null;
let listener: ((e: DomainEvent) => void) | null = null;
const inflight = new Set<Promise<void>>();

/**
 * Subscribes to domain events (emitted after each transaction commits). Call once at
 * server start. Without FIREBASE_SERVICE_ACCOUNT_PATH pushes are skipped, nothing else changes.
 */
export function startNotifications(opts: { sender?: PushSender } = {}): void {
  if (listener) return;
  sender = opts.sender ?? (env.FIREBASE_SERVICE_ACCOUNT_PATH ? new FcmSender(env.FIREBASE_SERVICE_ACCOUNT_PATH) : new NoopSender());
  listener = (e: DomainEvent) => {
    const task: Promise<void> = dispatch(e, sender!)
      .catch(err => logger.error({ err, type: e.type }, 'notification dispatch failed'))
      .finally(() => inflight.delete(task));
    inflight.add(task);
  };
  domainEvents.on('event', listener);
}

export function stopNotifications(): void {
  if (listener) domainEvents.off('event', listener);
  listener = null;
  sender = null;
}

/** Resolves when every notification triggered so far has been handled (used by tests and shutdown). */
export async function flushNotifications(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

export type { PushSender } from './sender';
