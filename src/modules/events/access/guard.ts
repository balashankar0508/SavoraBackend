import { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../../../lib/httpError';
import { pool } from '../../../db/pool';
import { assertCan } from './denial';
import { loadEventContext } from './context';
import { Action, EventContext, ResourceFor } from './types';

type IdResolver = (req: Request, res: Response) => string | Promise<string>;

/**
 * Loads `{ event, role }` into `req.eventCtx`. Must run after requireAuth.
 * Non-members (and unknown/malformed ids) get 404 `event_not_found`.
 * By default the id comes from the `:eventId` route parameter.
 */
export function eventContext(resolveId: IdResolver = req => String(req.params.eventId)): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      if (!req.userId) throw new HttpError(401, 'unauthorized');
      const id = await resolveId(req, res);
      const ctx = await loadEventContext(pool, id, req.userId);
      if (!ctx) throw new HttpError(404, 'event_not_found');
      req.eventCtx = ctx;
    })().then(() => next(), next);
  };
}

/**
 * Route-level permission gate. Must run after eventContext.
 *   router.post('/:eventId/expenses', eventContext(), can('expense.create'), handler)
 * For resource-dependent actions pass a loader that returns the resource
 * facts (it may throw a 404 HttpError if the resource doesn't exist).
 */
export function can<A extends Action>(
  action: A,
  loadResource?: (req: Request, ctx: EventContext) => ResourceFor<A> | Promise<ResourceFor<A>>,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    (async () => {
      const ctx = req.eventCtx;
      if (!ctx) throw new HttpError(500, 'event_context_missing');
      const resource = loadResource ? await loadResource(req, ctx) : undefined;
      assertCan(ctx, action, resource);
    })().then(() => next(), next);
  };
}
