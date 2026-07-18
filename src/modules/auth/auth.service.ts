import { HttpError } from '../../lib/httpError';
import { hashPassword, comparePassword } from '../../lib/password';
import { signAccessToken } from '../../lib/jwt';
import {
  generateRefreshToken,
  hashOpaqueToken,
  generateOtpCode,
  hashOtpCode,
} from '../../lib/tokens';
import { sendOtpEmail, sendResetEmail } from '../../lib/mailer';
import * as repo from './auth.repo';
import { toPublicUser } from './auth.repo';
import { User, SubscriptionTier } from '../../types/shared';

const OTP_TTL_MS = 15 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const RESET_DEEP_LINK_BASE = 'savora://auth/callback';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

async function issueTokenPair(userId: string, email: string): Promise<TokenPair> {
  const accessToken = signAccessToken({ userId, email });
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await repo.createRefreshToken(userId, hashOpaqueToken(refreshToken), expiresAt);
  return { accessToken, refreshToken };
}

export async function register(name: string, email: string, password: string): Promise<{ pendingVerificationEmail: string }> {
  const existing = await repo.findUserByEmail(email);
  if (existing) throw new HttpError(409, 'email_already_registered');

  const passwordHash = await hashPassword(password);
  const user = await repo.createUser(name, email, passwordHash);

  const code = generateOtpCode();
  await repo.createEmailVerification(user.id, hashOtpCode(code), new Date(Date.now() + OTP_TTL_MS));
  await sendOtpEmail(email, code);

  return { pendingVerificationEmail: email };
}

export async function verifyEmail(
  email: string,
  code: string,
): Promise<{ user: User; tier: SubscriptionTier; tokens: TokenPair }> {
  const user = await repo.findUserByEmail(email);
  if (!user) throw new HttpError(401, 'invalid_code');

  const ok = await repo.consumeEmailVerification(user.id, hashOtpCode(code));
  if (!ok) throw new HttpError(401, 'invalid_code');

  await repo.setEmailVerified(user.id);
  const tokens = await issueTokenPair(user.id, user.email);
  const tier = await repo.fetchTier(user.id);
  return { user: toPublicUser({ ...user, email_verified: true }), tier, tokens };
}

export async function resendVerification(email: string): Promise<void> {
  const user = await repo.findUserByEmail(email);
  if (!user || user.email_verified) return; // no enumeration

  const code = generateOtpCode();
  await repo.createEmailVerification(user.id, hashOtpCode(code), new Date(Date.now() + OTP_TTL_MS));
  await sendOtpEmail(email, code);
}

export async function login(
  email: string,
  password: string,
): Promise<{ user: User; tier: SubscriptionTier; tokens: TokenPair }> {
  const user = await repo.findUserByEmail(email);
  if (!user) throw new HttpError(401, 'invalid_credentials');

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) throw new HttpError(401, 'invalid_credentials');

  if (!user.email_verified) throw new HttpError(403, 'email_not_verified');

  const tokens = await issueTokenPair(user.id, user.email);
  const tier = await repo.fetchTier(user.id);
  return { user: toPublicUser(user), tier, tokens };
}

export async function refresh(refreshToken: string): Promise<TokenPair> {
  const tokenHash = hashOpaqueToken(refreshToken);
  const row = await repo.findRefreshToken(tokenHash);
  if (!row) throw new HttpError(401, 'invalid_refresh_token');

  if (row.revoked_at) {
    // Reuse of an already-rotated/revoked token — treat as theft.
    await repo.revokeAllUserRefreshTokens(row.user_id);
    throw new HttpError(401, 'refresh_token_reused');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new HttpError(401, 'refresh_token_expired');
  }

  const user = await repo.findUserById(row.user_id);
  if (!user) throw new HttpError(401, 'invalid_refresh_token');

  const newRefreshToken = generateRefreshToken();
  const newHash = hashOpaqueToken(newRefreshToken);
  await repo.revokeRefreshToken(row.id, newHash);
  await repo.createRefreshToken(user.id, newHash, new Date(Date.now() + REFRESH_TTL_MS));

  const accessToken = signAccessToken({ userId: user.id, email: user.email });
  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(refreshToken: string): Promise<void> {
  const row = await repo.findRefreshToken(hashOpaqueToken(refreshToken));
  if (row && !row.revoked_at) {
    await repo.revokeRefreshToken(row.id);
  }
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await repo.findUserByEmail(email);
  if (!user) return; // always 200, no email enumeration

  const token = generateRefreshToken();
  await repo.createPasswordReset(user.id, hashOpaqueToken(token), new Date(Date.now() + RESET_TTL_MS));

  const deepLink = `${RESET_DEEP_LINK_BASE}?type=recovery&token=${token}`;
  await sendResetEmail(email, deepLink);
}

export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<{ user: User; tier: SubscriptionTier; tokens: TokenPair }> {
  const row = await repo.findValidPasswordReset(hashOpaqueToken(token));
  if (!row) throw new HttpError(401, 'invalid_or_expired_token');

  const passwordHash = await hashPassword(newPassword);
  await repo.updateUserPassword(row.user_id, passwordHash);
  await repo.consumePasswordReset(row.id);
  // Invalidate every other session (e.g. other devices) before issuing a
  // fresh pair for *this* device — the app expects to land the user
  // straight back in the Main stack after a successful reset, matching
  // ResetPasswordScreen.tsx's existing zero-extra-step UX.
  await repo.revokeAllUserRefreshTokens(row.user_id);

  const user = await repo.findUserById(row.user_id);
  if (!user) throw new HttpError(404, 'user_not_found');

  const tokens = await issueTokenPair(user.id, user.email);
  const tier = await repo.fetchTier(user.id);
  return { user: toPublicUser(user), tier, tokens };
}

export async function updateProfile(userId: string, name: string): Promise<User> {
  const row = await repo.updateUserName(userId, name);
  return toPublicUser(row);
}

export async function me(userId: string): Promise<{ user: User; tier: SubscriptionTier }> {
  const row = await repo.findUserById(userId);
  if (!row) throw new HttpError(404, 'user_not_found');
  const tier = await repo.fetchTier(userId);
  return { user: toPublicUser(row), tier };
}
