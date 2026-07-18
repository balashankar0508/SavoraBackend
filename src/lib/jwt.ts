import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessTokenClaims {
  userId: string;
  email: string;
}

const ACCESS_TOKEN_TTL = '15m';

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenClaims;
}
