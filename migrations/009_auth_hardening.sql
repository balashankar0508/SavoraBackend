-- Brute-force protection for one-time codes: every wrong guess is counted, and a code stops
-- working after 5 of them (the person asks for a new one). Applies to the signup email code
-- and to the password-reset code, which replaces the old savora:// reset link.
alter table email_verifications add column if not exists attempts integer not null default 0;
alter table password_resets add column if not exists attempts integer not null default 0;
