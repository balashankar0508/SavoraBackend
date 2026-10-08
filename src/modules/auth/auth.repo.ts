import { pool } from '../../db/pool';
import { SubscriptionTier, User } from '../../types/shared';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified: boolean;
  created_at: string;
}

export function toPublicUser(row: UserRow): User {
  return { id: row.id, name: row.name, email: row.email, created_at: row.created_at };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>('select * from users where email = $1', [email]);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>('select * from users where id = $1', [id]);
  return rows[0] ?? null;
}

export async function createUser(name: string, email: string, passwordHash: string): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `insert into users (name, email, password_hash) values ($1, $2, $3) returning *`,
    [name, email, passwordHash],
  );
  return rows[0];
}

export async function setEmailVerified(userId: string): Promise<void> {
  await pool.query('update users set email_verified = true where id = $1', [userId]);
}

export async function updateUserName(userId: string, name: string): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    'update users set name = $1 where id = $2 returning *',
    [name, userId],
  );
  return rows[0];
}

export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  await pool.query('update users set password_hash = $1 where id = $2', [passwordHash, userId]);
}

/** Defaults to 'free' on any lookup failure — must never fail open to a paid tier. */
export async function fetchTier(userId: string): Promise<SubscriptionTier> {
  try {
    const { rows } = await pool.query<{ tier: SubscriptionTier }>(
      'select tier from subscriptions where user_id = $1',
      [userId],
    );
    return rows[0]?.tier ?? 'free';
  } catch {
    return 'free';
  }
}

// ── Email verification (signup OTP) ────────────────────────────

export async function createEmailVerification(
  userId: string,
  codeHash: string,
  expiresAt: Date,
): Promise<void> {
  // Invalidate any prior unconsumed codes for this user first.
  await pool.query(
    'update email_verifications set consumed_at = now() where user_id = $1 and consumed_at is null',
    [userId],
  );
  await pool.query(
    'insert into email_verifications (user_id, code_hash, expires_at) values ($1, $2, $3)',
    [userId, codeHash, expiresAt],
  );
}

// ── Password reset ──────────────────────────────────────────────

export async function createPasswordReset(userId: string, codeHash: string, expiresAt: Date): Promise<void> {
  // Only the newest reset code works: asking again cancels the earlier ones.
  await pool.query(
    'update password_resets set consumed_at = now() where user_id = $1 and consumed_at is null',
    [userId],
  );
  await pool.query(
    'insert into password_resets (user_id, token_hash, expires_at) values ($1, $2, $3)',
    [userId, codeHash, expiresAt],
  );
}

// ── One-time codes (signup verification and password reset) ─────

/** A code stops working after this many wrong guesses; the person then asks for a new one. */
export const MAX_CODE_ATTEMPTS = 5;

const CODE_TABLES = {
  verification: { table: 'email_verifications', hash: 'code_hash' },
  reset: { table: 'password_resets', hash: 'token_hash' },
} as const;

/**
 * Checks the person's newest live code in one statement (row-locked, so parallel guesses
 * are counted one by one). A match consumes the code; a miss counts an attempt and, at the
 * limit, kills the code. Returns true only for a match.
 */
export async function checkOneTimeCode(kind: keyof typeof CODE_TABLES, userId: string, codeHash: string): Promise<boolean> {
  const { table, hash } = CODE_TABLES[kind];
  const { rows } = await pool.query<{ ok: boolean }>(
    `with current_code as (
       select id, ${hash} = $2 as ok
         from ${table}
        where user_id = $1 and consumed_at is null and expires_at > now()
        order by created_at desc
        limit 1
        for update
     )
     update ${table} t
        set attempts = t.attempts + case when c.ok then 0 else 1 end,
            consumed_at = case when c.ok or t.attempts + 1 >= $3 then now() else null end
       from current_code c
      where t.id = c.id
     returning c.ok`,
    [userId, codeHash, MAX_CODE_ATTEMPTS],
  );
  return rows[0]?.ok === true;
}

// ── Refresh tokens ───────────────────────────────────────────────

export async function createRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
  await pool.query(
    'insert into refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)',
    [userId, tokenHash, expiresAt],
  );
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_hash: string | null;
}

export async function findRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
  const { rows } = await pool.query<RefreshTokenRow>(
    'select * from refresh_tokens where token_hash = $1',
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function revokeRefreshToken(id: string, replacedByHash?: string): Promise<void> {
  await pool.query(
    'update refresh_tokens set revoked_at = now(), replaced_by_hash = $2 where id = $1',
    [id, replacedByHash ?? null],
  );
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  await pool.query(
    'update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null',
    [userId],
  );
}
