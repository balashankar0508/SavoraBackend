// Auth security integration tests: real HTTP requests through the Express app.
//
//   npm run build && node --test scripts/test-auth.cjs
//
// Same disposable database setup as scripts/test-events.cjs (PostgreSQL at 127.0.0.1:55439,
// user `events_test`, trust auth); it recreates its own database `spenxo_auth_test` on every run.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHmac } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB = 'spenxo_auth_test';
Object.assign(process.env, {
  DATABASE_URL: `postgres://events_test@127.0.0.1:55439/${DB}`,
  JWT_ACCESS_SECRET: 'auth-test-only-access-secret-32-characters',
  JWT_REFRESH_PEPPER: 'auth-test-only-refresh-pepper-32-characters',
  GEMINI_API_KEY: 'test',
  ANTHROPIC_API_KEY: '',
  BREVO_API_KEY: 'test',
  MAIL_FROM: 'test@example.invalid',
  NODE_ENV: 'test',
  UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'spenxo-auth-test-')),
  CHAT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  INVITE_CODE_KEY: randomBytes(32).toString('hex'),
});

const { Pool } = require('pg');
const { pool } = require('../dist/db/pool');
const { createApp } = require('../dist/app');
const { hashOtpCode } = require('../dist/lib/tokens');
const { hashPassword } = require('../dist/lib/password');
const repo = require('../dist/modules/auth/auth.repo');

// the mailer prints codes outside production: keep the test output readable
console.log = () => undefined;
console.warn = () => undefined;

let server;
let base;
let n = 0;

before(async () => {
  const admin = new Pool({ connectionString: 'postgres://events_test@127.0.0.1:55439/postgres' });
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB} encoding 'UTF8' template template0`);
  await admin.end();
  const dir = path.join(__dirname, '..', 'migrations');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
});

const email = () => `person${++n}-${randomBytes(3).toString('hex')}@test.io`;

async function post(url, body, token) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function verifiedUser(password = 'correct horse 1') {
  const address = email();
  const { rows } = await pool.query("insert into users (name, email, password_hash, email_verified) values ('Test', $1, $2, true) returning id", [address, await hashPassword(password)]);
  return { id: rows[0].id, email: address, password };
}

/** Replaces the user's live code with a known one (the real code only goes to the inbox). */
async function knownCode(kind, userId, code = '246810') {
  if (kind === 'verification') await repo.createEmailVerification(userId, hashOtpCode(code), new Date(Date.now() + 60_000));
  else await repo.createPasswordReset(userId, hashOtpCode(code), new Date(Date.now() + 60_000));
  return code;
}

test('a signup code stops working after 5 wrong guesses, even if the right one comes next', async () => {
  const address = email();
  assert.equal((await post('/auth/register', { name: 'A', email: address, password: 'password-123' })).status, 201);
  const user = await repo.findUserByEmail(address);
  const code = await knownCode('verification', user.id);
  for (let i = 0; i < 5; i++) {
    assert.equal((await post('/auth/verify-email', { email: address, code: '000000' })).body.error, 'invalid_code');
  }
  assert.equal((await post('/auth/verify-email', { email: address, code })).status, 401, 'the code is dead');
});

test('the right code within the limit verifies and signs in, once', async () => {
  const address = email();
  await post('/auth/register', { name: 'B', email: address, password: 'password-123' });
  const user = await repo.findUserByEmail(address);
  const code = await knownCode('verification', user.id);
  assert.equal((await post('/auth/verify-email', { email: address, code: '111111' })).status, 401);
  const ok = await post('/auth/verify-email', { email: address, code });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.tokens.accessToken);
  assert.equal((await post('/auth/verify-email', { email: address, code })).status, 401, 'single use');
});

test('sign-up answers the same for new, unverified and existing emails, and never replaces a password', async () => {
  const fresh = await post('/auth/register', { name: 'C', email: email(), password: 'password-123' });
  const existing = await verifiedUser();
  const again = await post('/auth/register', { name: 'Mallory', email: existing.email, password: 'attacker-pass-1' });
  assert.equal(again.status, fresh.status);
  assert.deepEqual(Object.keys(again.body), Object.keys(fresh.body));
  assert.equal((await post('/auth/login', { email: existing.email, password: 'attacker-pass-1' })).status, 401, 'password unchanged');
  assert.equal((await post('/auth/login', { email: existing.email, password: existing.password })).status, 200);
  assert.equal((await repo.findUserByEmail(existing.email)).name, 'Test', 'name unchanged');

  const pending = email();
  await post('/auth/register', { name: 'D', email: pending, password: 'first-password-1' });
  const before = (await repo.findUserByEmail(pending)).password_hash;
  assert.equal((await post('/auth/register', { name: 'E', email: pending, password: 'second-pass-2' })).status, 201);
  assert.equal((await repo.findUserByEmail(pending)).password_hash, before, 'an unverified account keeps its password');
});

test('login gives the same answer for an unknown email and a wrong password', async () => {
  const user = await verifiedUser();
  const unknown = await post('/auth/login', { email: email(), password: 'whatever-123' });
  const wrong = await post('/auth/login', { email: user.email, password: 'whatever-123' });
  assert.equal(unknown.status, 401);
  assert.deepEqual({ ...unknown.body, requestId: null }, { ...wrong.body, requestId: null });
});

test('password reset works with the emailed code, signs out other devices, and is single use', async () => {
  const user = await verifiedUser();
  const signedIn = await post('/auth/login', { email: user.email, password: user.password });
  assert.equal((await post('/auth/forgot-password', { email: user.email })).status, 200);
  const code = await knownCode('reset', user.id);

  const reset = await post('/auth/reset-password', { email: user.email, code, newPassword: 'brand-new-pass-1' });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.tokens.refreshToken);
  assert.equal((await post('/auth/refresh', { refreshToken: signedIn.body.tokens.refreshToken })).status, 401, 'old session revoked');
  assert.equal((await post('/auth/login', { email: user.email, password: 'brand-new-pass-1' })).status, 200);
  assert.equal((await post('/auth/reset-password', { email: user.email, code, newPassword: 'another-pass-2' })).status, 401, 'single use');
});

test('a reset code dies after 5 wrong guesses, and asking again cancels the older code', async () => {
  const user = await verifiedUser();
  const code = await knownCode('reset', user.id);
  for (let i = 0; i < 5; i++) {
    assert.equal((await post('/auth/reset-password', { email: user.email, code: '999999', newPassword: 'nope-nope-1' })).body.error, 'invalid_or_expired_code');
  }
  assert.equal((await post('/auth/reset-password', { email: user.email, code, newPassword: 'nope-nope-1' })).status, 401);

  const user2 = await verifiedUser();
  const old = await knownCode('reset', user2.id, '123123');
  await knownCode('reset', user2.id, '456456');
  assert.equal((await post('/auth/reset-password', { email: user2.email, code: old, newPassword: 'nope-nope-1' })).status, 401, 'older code cancelled');
});

test('forgot-password reveals nothing about unknown emails, and the old link form is refused', async () => {
  assert.equal((await post('/auth/forgot-password', { email: email() })).status, 200);
  const user = await verifiedUser();
  assert.equal((await post('/auth/reset-password', { token: 'a'.repeat(64), newPassword: 'whatever-123' })).status, 400);
  assert.equal((await post('/auth/reset-password', { email: user.email, code: '12345', newPassword: 'whatever-123' })).status, 400, 'six digits only');
});

test('code endpoints are limited per email, across IP addresses', async () => {
  const address = email();
  let last;
  for (let i = 0; i < 11; i++) last = await post('/auth/forgot-password', { email: address });
  assert.equal(last.status, 429);
  assert.equal((await post('/auth/forgot-password', { email: email() })).status, 200, 'other people are unaffected');
});

test('access tokens signed any way but HS256 with our secret are refused', async () => {
  const user = await verifiedUser();
  const login = await post('/auth/login', { email: user.email, password: user.password });
  const me = token => fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.status);
  assert.equal(await me(login.body.tokens.accessToken), 200);

  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const claims = b64({ userId: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(await me(`${b64({ alg: 'none', typ: 'JWT' })}.${claims}.`), 401, 'alg none');
  const hs512 = `${b64({ alg: 'HS512', typ: 'JWT' })}.${claims}`;
  const sig = createHmac('sha512', process.env.JWT_ACCESS_SECRET).update(hs512).digest('base64url');
  assert.equal(await me(`${hs512}.${sig}`), 401, 'other algorithm, even with the right secret');
});

test('request bodies over 1 MB are refused outside the receipt-parsing route', async () => {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email(), password: 'x'.repeat(1_100_000) }),
  });
  assert.equal(res.status, 413);
});

test('malformed JSON is a 400, not a server error', async () => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_json');
});
