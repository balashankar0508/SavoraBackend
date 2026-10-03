import { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../../../lib/httpError';
import { uuid } from './schemas';

/** Async handler wrapper: any throw or rejection goes to the shared error handler. */
export const route =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** A UUID path parameter. A malformed id is just "not found", never a 400 that hints at structure. */
export function idParam(req: Request, name: string): string {
  const parsed = uuid.safeParse(req.params[name]);
  if (!parsed.success) throw new HttpError(404, 'not_found');
  return parsed.data;
}

/** The event this request is scoped to (set by eventContext). */
export const eventIdOf = (req: Request): string => req.eventCtx!.event.id;
