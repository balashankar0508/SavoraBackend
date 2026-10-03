import { HttpError } from '../../../lib/httpError';
import { authorize } from './policy';
import { Action, DenyReason, EventContext, ResourceFor } from './types';

const STATE_REASONS: DenyReason[] = ['event_not_active', 'event_not_completed', 'event_archived', 'wrong_state'];

/** Turns a denied decision into the HttpError every route returns.
 * State problems (event completed, wrong settlement status) are 409 with the
 * reason as the code; permission problems are 403 `forbidden_<action>`. */
export function denial(action: Action, reason: DenyReason): HttpError {
  return STATE_REASONS.includes(reason)
    ? new HttpError(409, reason)
    : new HttpError(403, `forbidden_${action.replace('.', '_')}`);
}

/** Throws unless `ctx` may perform `action`. Used inside services after the lock is taken. */
export function assertCan<A extends Action>(ctx: EventContext, action: A, resource?: ResourceFor<A>): void {
  const decision = authorize(ctx, action, resource);
  if (!decision.ok) throw denial(action, decision.reason);
}
