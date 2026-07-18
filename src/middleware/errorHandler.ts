import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError';
import { env } from '../config/env';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'invalid_body', details: err.flatten() });
  }

  req.log.error(err);
  const message = env.NODE_ENV === 'production' ? 'internal_error' : (err as Error)?.message;
  res.status(500).json({ error: 'internal_error', message });
}
