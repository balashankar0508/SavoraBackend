import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwt';
import { HttpError } from '../lib/httpError';

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new HttpError(401, 'unauthorized'));
  }

  try {
    const claims = verifyAccessToken(header.slice('Bearer '.length));
    req.userId = claims.userId;
    req.userEmail = claims.email;
    next();
  } catch {
    next(new HttpError(401, 'unauthorized'));
  }
}
