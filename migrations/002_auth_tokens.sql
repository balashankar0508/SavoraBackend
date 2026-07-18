-- ══════════════════════════════════════════════════════════════
-- Auth token bookkeeping tables — needed now that there's no
-- Supabase Auth behind the scenes.
-- ══════════════════════════════════════════════════════════════

-- Refresh tokens are opaque random strings on the wire; only their
-- SHA-256 hash (with a server-side pepper) is stored, so a DB leak
-- alone can't be replayed. Enables true revocation and reuse
-- detection, unlike a stateless-only JWT refresh token.
create table if not exists refresh_tokens (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references users(id) on delete cascade,
  token_hash        text not null unique,
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  replaced_by_hash  text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_refresh_tokens_user on refresh_tokens(user_id);

-- 6-digit email verification codes (signup OTP flow).
create table if not exists email_verifications (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references users(id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_email_verifications_user on email_verifications(user_id);

-- Password reset tokens, delivered via a savora://auth/callback deep link.
create table if not exists password_resets (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_password_resets_user on password_resets(user_id);
