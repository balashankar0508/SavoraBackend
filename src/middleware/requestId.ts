import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/** Gives every request an ID, echoed in the X-Request-Id header, in pino logs
 * and in every error body so the app can show it on error screens. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
