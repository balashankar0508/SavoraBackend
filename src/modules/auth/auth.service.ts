import { HttpError } from '../../lib/httpError';
import { hashPassword, comparePassword } from '../../lib/password';
import { signAccessToken } from '../../lib/jwt';
import {
  generateRefreshToken,
  hashOpaqueToken,
  generateOtpCode,
  hashOtpCode,
} from '../../lib/tokens';
import { sendAccountExistsEmail, sendOtpEmail, sendResetCodeEmail } from '../../lib/mailer';
import * as repo from './auth.repo';
import { toPublicUser } from './auth.repo';
import { User, SubscriptionTier } from '../../types/shared';

const OTP_TTL_MS = 15 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * A real bcrypt hash of a random password, compared against when the email is unknown, so a
 * wrong email takes as long as a wrong password and login cannot reveal who has an account.
 */
let dummyHash: Promise<string> | null = null;
const timingDummyHash = () => (dummyHash ??= hashPassword(generateRefreshToken()));

async function sendVerificationCode(userId: string, email: string): Promise<void> {
  const code = generateOtpCode();
  await repo.createEmailVerification(userId, hashOtpCode(code), new Date(Date.now() + OTP_TTL_MS));
  await sendOtpEmail(email, code);
}

async function issueTokenPair(userId: string, email: string): Promise<TokenPair> {
  const accessToken = signAccessToken({ userId, email });
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await repo.createRefreshToken(userId, hashOpaqueToken(refreshToken), expiresAt);
  return { accessToken, refreshToken };
}

/**
 * Always answers the same way ("check your email"), so sign-up cannot be used to find out
 * whether an email has an account:
 *   new email           -> account created, code sent
 *   not yet verified    -> a fresh code to the inbox (the stored password is NOT replaced:
 *                          otherwise a stranger could set the password of an unverified account)
 *   verified account    -> the owner gets an "you already have an account" email
 */
export async function register(name: string, email: string, password: string): Promise<{ pendingVerificationEmail: string }> {
  const passwordHash = await hashPassword(password); // hashed on every path: equal response time
  const existing = await repo.findUserByEmail(email);
  if (existing) {
    if (existing.email_verified) await sendAccountExistsEmail(email);
    else await sendVerificationCode(existing.id, email);
    return { pendingVerificationEmail: email };
  }

  let user: repo.UserRow;
  try {
    user = await repo.createUser(name, email, passwordHash);
  } catch (err) {
    // two sign-ups for the same email at the same moment: the other one won, answer the same way
    if ((err as { code?: string }).code === '23505') return { pendingVerificationEmail: email };
    throw err;
  }
  await sendVerificationCode(user.id, email);
  return { pendingVerificationEmail: email };
}

export async function verifyEmail(
  email: string,
  code: string,
): Promise<{ user: User; tier: SubscriptionTier; tokens: TokenPair }> {
  const user = await repo.findUserByEmail(email);
  if (!user) throw new HttpError(401, 'invalid_code');

  // counts the attempt: five wrong guesses and the code is dead
  const ok = await repo.checkOneTimeCode('verification', user.id, hashOtpCode(code));
  if (!ok) throw new HttpError(401, 'invalid_code');

  await repo.setEmailVerified(user.id);
  const tokens = await issueTokenPair(user.id, user.email);
  const tier = await repo.fetchTier(user.id);
  return { user: toPublicUser({ ...user, email_verified: true }), tier, tokens };
}

export async function resendVerification(email: string): Promise<void> {
  const user = await repo.findUserByEmail(email);
  if (!user || user.email_verified) return; // no enumeration

  await sendVerificationCode(user.id, email);
}

export async function login(
  email: string,
  password: string,
): Promise<{ user: User; tier: SubscriptionTier; tokens: TokenPair }> {
  const user = await repo.findUserByEmail(email);
  // compare even when the email is unknown, so both failures take the same time
  const valid = await comparePassword(password, user?.password_hash ?? (await timingDummyHash()));
  if (!user || !valid) throw new HttpError(401, 'invalid_credentials');

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

/** Emails a 6-digit reset code (never a link). Always answers 200, so it reveals nothing. */
export async function forgotPassword(email: string): Promise<void> {
  const user = await repo.findUserByEmail(email);
  if (!user) return;

  const code = generateOtpCode();
  await repo.createPasswordReset(user.id, hashOtpCode(code), new Date(Date.now() + RESET_TTL_MS));
  await sendResetCodeEmail(email, code);
}

/**
 * Sets a new password with the emailed code. Five wrong codes kill it. Success proves the
 * person owns the inbox, so the email counts as verified; every other session is signed out.
 */
export async function resetPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<{ user: User; tier: SubscriptionTier; tokens: TokenPair }> {
  const found = await repo.findUserByEmail(email);
  const ok = found ? await repo.checkOneTimeCode('reset', found.id, hashOtpCode(code)) : false;
  if (!found || !ok) throw new HttpError(401, 'invalid_or_expired_code');

  await repo.updateUserPassword(found.id, await hashPassword(newPassword));
  if (!found.email_verified) await repo.setEmailVerified(found.id);
  await repo.revokeAllUserRefreshTokens(found.id);

  const user = await repo.findUserById(found.id);
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

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ tokens: TokenPair }> {
  const user = await repo.findUserById(userId);
  if (!user) throw new HttpError(404, 'user_not_found');

  const valid = await comparePassword(currentPassword, user.password_hash);
  if (!valid) throw new HttpError(401, 'invalid_current_password');

  await repo.updateUserPassword(userId, await hashPassword(newPassword));
  // Sign out every other device; this one gets a fresh pair.
  await repo.revokeAllUserRefreshTokens(userId);
  const tokens = await issueTokenPair(user.id, user.email);
  return { tokens };
}
