import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError';
import { env } from '../config/env';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.requestId;

  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, requestId });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'invalid_body', details: err.flatten(), requestId });
  }

  // body-parser: a body over the size limit, or JSON that does not parse (client errors, not 500s)
  const bodyError = (err as { type?: string })?.type;
  if (bodyError === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', requestId });
  if (bodyError === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', requestId });

  // multer: oversized upload / unexpected field
  if ((err as { name?: string })?.name === 'MulterError') {
    const code = (err as { code?: string }).code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'invalid_upload';
    return res.status(code === 'file_too_large' ? 413 : 400).json({ error: code, requestId });
  }

  req.log.error(err);
  const message = env.NODE_ENV === 'production' ? 'internal_error' : (err as Error)?.message;
  res.status(500).json({ error: 'internal_error', message, requestId });
}
