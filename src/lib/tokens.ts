import crypto from 'crypto';
import { env } from '../config/env';

/** Opaque, high-entropy refresh token — 256 bits of randomness, hex-encoded. */
export function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Hashes an opaque token (refresh token or password-reset token) with a
 * server-side pepper before storage, so a DB leak alone can't be replayed. */
export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token + env.JWT_REFRESH_PEPPER).digest('hex');
}

/** 6-digit numeric email verification code. */
export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtpCode(code: string): string {
  return crypto.createHash('sha256').update(code + env.JWT_REFRESH_PEPPER).digest('hex');
}
