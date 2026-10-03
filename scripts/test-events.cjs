// Events v2 integration tests: authenticated HTTP requests through the real Express app.
//
//   npm run build && node --test scripts/test-events.cjs      (or: npm run test:integration)
//
// Uses ONLY a disposable local database, never DATABASE_URL from .env. It expects an isolated
// PostgreSQL at 127.0.0.1:55439 with user `events_test` (trust auth) and recreates the database
// `spenxo_events_test` on every run, so do not keep anything useful in it. To get one:
//   initdb -D <dir> -U events_test --auth=trust && pg_ctl -D <dir> -o "-p 55439" start
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB = 'spenxo_events_test';
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spenxo-events-test-'));
Object.assign(process.env, {
  DATABASE_URL: `postgres://events_test@127.0.0.1:55439/${DB}`,
  JWT_ACCESS_SECRET: 'events-test-only-access-secret-32-characters',
  JWT_REFRESH_PEPPER: 'events-test-only-refresh-pepper-32-characters',
  GEMINI_API_KEY: 'test',
  ANTHROPIC_API_KEY: '',
  BREVO_API_KEY: 'test',
  MAIL_FROM: 'test@example.invalid',
  NODE_ENV: 'test',
  UPLOAD_DIR: uploadDir,
  CHAT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  INVITE_CODE_KEY: randomBytes(32).toString('hex'),
});

const { Pool } = require('pg');
const { pool } = require('../dist/db/pool');
const { signAccessToken } = require('../dist/lib/jwt');
const { createApp } = require('../dist/app');
const { splitExpense } = require('../dist/modules/events/ledger');

let server;
let base;
let n = 0;

before(async () => {
  const admin = new Pool({ connectionString: `postgres://events_test@127.0.0.1:55439/postgres` });
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
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
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────

async function newUser(name = 'user') {
  n++;
  const email = `${name}${n}-${randomBytes(3).toString('hex')}@test.io`;
  const { rows } = await pool.query("insert into users (name, email, password_hash, email_verified) values ($1, $2, 'x', true) returning id", [`${name}${n}`, email]);
  return { id: rows[0].id, email, name: `${name}${n}`, token: signAccessToken({ userId: rows[0].id, email }) };
}

async function api(user, method, url, body, raw) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    body: raw ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

const today = () => new Date().toISOString().slice(0, 10);

async function makeEvent(owner, extra = {}) {
  const id = randomUUID();
  const r = await api(owner, 'POST', '/events', { id, title: 'Birthday Party', event_type: 'birthday', start_date: today(), budget_paise: 800000, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return id;
}

async function inviteCode(owner, eventId) {
  const r = await api(owner, 'GET', `/events/${eventId}/invite-code`);
  assert.equal(r.status, 200);
  return r.body.code;
}

/** Owner creates an event and the given users join (and are promoted when listed as admins). */
async function setup({ members = 2, admins = 0, eventExtra = {} } = {}) {
  const owner = await newUser('owner');
  const { join_policy, ...createExtra } = eventExtra;
  const eventId = await makeEvent(owner, createExtra);
  const users = [];
  for (let i = 0; i < admins + members; i++) {
    const u = await newUser(i < admins ? 'admin' : 'member');
    const j = await api(u, 'POST', '/events/join', { code: await inviteCode(owner, eventId) });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    if (i < admins) assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${u.id}/promote`)).status, 200);
    users.push(u);
  }
  // people join under open codes; the requested policy applies from then on
  if (join_policy && join_policy !== 'code') {
    assert.equal((await api(owner, 'PATCH', `/events/${eventId}/settings`, { join_policy })).status, 200);
  }
  return { owner, eventId, admins: users.slice(0, admins), members: users.slice(admins) };
}

const expenseBody = (over = {}) => ({ id: randomUUID(), title: 'Dinner', category: 'Food', amount_paise: 30000, expense_date: today(), paid_by: null, split_mode: 'equal', splits: [], ...over });

async function addExpense(user, eventId, paidBy, amount, participants, over = {}) {
  const r = await api(user, 'POST', `/events/${eventId}/expenses`, expenseBody({
    paid_by: paidBy.id, amount_paise: amount, splits: participants.map(p => ({ user_id: p.id, value: 0 })), ...over,
  }));
  assert.ok(r.status === 201 || r.status === 200, `addExpense ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.expense;
}

const balancesOf = async (user, eventId) => {
  const r = await api(user, 'GET', `/events/${eventId}/balances`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return Object.fromEntries(r.body.members.map(m => [m.user_id, m.balance_paise]));
};

const markPaid = (user, eventId, to, amount, over = {}) =>
  api(user, 'POST', `/events/${eventId}/settlements`, { id: randomUUID(), to_user: to.id, amount_paise: amount, method: 'upi', ...over });

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
async function upload(user, eventId, purpose) {
  const f = new FormData();
  f.append('purpose', purpose);
  f.append('file', new Blob([png()], { type: 'image/png' }), 'x.png');
  const r = await api(user, 'POST', `/events/${eventId}/files`, undefined, f);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.file;
}

// ── access ──────────────────────────────────────────────────────

test('every events route requires a token', async () => {
  for (const [m, u] of [['GET', '/events'], ['POST', '/events'], ['POST', '/events/join'], ['GET', `/events/${randomUUID()}`], ['GET', '/me/payment-profile']]) {
    assert.equal((await api(null, m, u, m === 'POST' ? {} : undefined)).status, 401, `${m} ${u}`);
  }
});

test('a non-member gets 404 event_not_found on every event route (existence is never revealed)', async () => {
  const { eventId, members } = await setup({ members: 1 });
  const outsider = await newUser('outsider');
  const expenseId = (await addExpense(members[0], eventId, members[0], 1000, [members[0]])).id;
  const routes = [
    ['GET', ''], ['PATCH', ''], ['DELETE', ''], ['PATCH', '/settings'], ['POST', '/complete'], ['POST', '/reopen'], ['POST', '/archive'],
    ['POST', '/duplicate'], ['POST', '/leave'], ['GET', '/members'], ['GET', `/members/${members[0].id}/payment-profile`],
    ['GET', '/invite-code'], ['POST', '/invite-code/regenerate'], ['GET', '/invitations'], ['GET', '/expenses'],
    ['GET', `/expenses/${expenseId}`], ['POST', '/expenses'], ['DELETE', `/expenses/${expenseId}`], ['GET', '/balances'],
    ['GET', '/settlements'], ['POST', '/settlements'], ['POST', '/remind'],
  ];
  for (const [m, p] of routes) {
    const r = await api(outsider, m, `/events/${eventId}${p}`, m === 'GET' ? undefined : {});
    assert.equal(r.status, 404, `${m} ${p} -> ${r.status}`);
    assert.equal(r.body.error, 'event_not_found', `${m} ${p}`);
  }
  assert.equal((await api(outsider, 'GET', `/events/${randomUUID()}`)).status, 404, 'unknown id looks identical');
  assert.equal((await api(outsider, 'GET', '/events/not-a-uuid')).body.error, 'event_not_found');
  assert.ok((await api(outsider, 'GET', `/events/${eventId}`)).body.requestId, 'errors carry a request id');
});

// ── events ──────────────────────────────────────────────────────

test('create: validation, optional budget, idempotent retry, duplicate id with different content', async () => {
  const owner = await newUser('owner');
  const id = randomUUID();
  const body = { id, title: 'Goa Trip', event_type: 'trip', start_date: '2026-12-20', end_date: '2026-12-25', location: 'Goa' };
  const first = await api(owner, 'POST', '/events', body);
  assert.equal(first.status, 201);
  assert.equal(first.body.event.budget_paise, null, 'budget is optional');
  assert.equal(first.body.event.currency, 'INR');
  assert.equal(first.body.event.status, 'active');
  assert.equal(first.body.event.start_date, '2026-12-20');

  const retry = await api(owner, 'POST', '/events', body);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.event.id, id);
  assert.equal((await pool.query('select count(*)::int c from events where id = $1', [id])).rows[0].c, 1);

  const clash = await api(owner, 'POST', '/events', { ...body, title: 'Different' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'duplicate_id');
  assert.equal((await api(await newUser('other'), 'POST', '/events', body)).status, 409, 'someone else cannot reuse the id');

  for (const bad of [
    { end_date: '2026-12-19' }, { start_date: '2026-02-30' }, { budget_paise: 0 }, { budget_paise: 1000000001 }, { budget_paise: 10.5 },
    { title: '   ' }, { event_type: 'party' }, { join_policy: 'open' }, { currency: 'USD' }, { id: 'nope' },
  ]) {
    const r = await api(owner, 'POST', '/events', { ...body, id: randomUUID(), ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const dflt = await api(owner, 'POST', '/events', { id: randomUUID(), title: 'Dinner', start_date: '2026-10-01' });
  assert.equal(dflt.body.event.end_date, '2026-10-01', 'end date defaults to the start date');
  assert.equal(dflt.body.event.join_policy, 'code');
});

test('creating an event makes the creator the owner and generates an invite code', async () => {
  const owner = await newUser('owner');
  const id = await makeEvent(owner);
  const m = await api(owner, 'GET', `/events/${id}/members`);
  assert.deepEqual(m.body.members.map(x => [x.id, x.role]), [[owner.id, 'owner']]);
  const code = (await api(owner, 'GET', `/events/${id}/invite-code`)).body;
  assert.equal(code.status, 'active');
  assert.match(code.code, /^SPX-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(code.deep_link, `spenxo://join?code=${code.code}`);
  const row = (await pool.query('select code_hmac, code_enc from event_invite_codes where event_id = $1', [id])).rows[0];
  assert.ok(!JSON.stringify(row).includes(code.code.replace(/-/g, '').slice(3)), 'code is never stored in plain text');
  assert.ok((await pool.query('select 1 from event_audit_logs where event_id = $1 and action = $2', [id, 'EVENT_CREATED'])).rows[0]);
});

test('detail payload: stats, balances card, permissions per role', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  await addExpense(owner, eventId, owner, 30000, [owner, a, b]);
  const o = (await api(owner, 'GET', `/events/${eventId}`)).body;
  assert.equal(o.stats.spent_paise, 30000);
  assert.equal(o.stats.remaining_paise, 770000);
  assert.equal(o.stats.budget_used_pct, 4);
  assert.equal(o.stats.member_count, 3);
  assert.equal(o.stats.expense_count, 1);
  assert.equal(o.balances.me.net_paise, 20000);
  assert.equal(o.balances.me.owed_paise, 20000);
  assert.equal(o.balances.me.you_owe_paise, 0);
  assert.equal(o.balances.suggestions.length, 2);
  assert.equal(o.recent_expenses.length, 1);
  assert.equal(o.pending_requests_count, 0);
  assert.ok(o.permissions.includes('event.delete') && o.permissions.includes('member.promote'));

  const m = (await api(a, 'GET', `/events/${eventId}`)).body;
  assert.equal(m.balances.me.net_paise, -10000);
  assert.equal(m.balances.me.you_owe_paise, 10000);
  assert.equal(m.pending_requests_count, null, 'members do not see the request count');
  assert.ok(!m.permissions.includes('event.delete') && !m.permissions.includes('member.remove'));
  assert.ok(m.permissions.includes('expense.create'));
});

test('list: only my events, status filter, search, summary; archived events are hidden by default', async () => {
  const owner = await newUser('owner');
  const other = await newUser('other');
  const a = await makeEvent(owner, { title: 'Alpha Trip', budget_paise: 100000 });
  const b = await makeEvent(owner, { title: 'Beta 100%_off' });
  await makeEvent(other, { title: 'Not mine' });
  await addExpense(owner, a, owner, 25000, [owner]);

  const all = (await api(owner, 'GET', '/events')).body;
  assert.deepEqual(all.events.map(e => e.title).sort(), ['Alpha Trip', 'Beta 100%_off']);
  const alpha = all.events.find(e => e.title === 'Alpha Trip');
  assert.equal(alpha.spent_paise, 25000);
  assert.equal(alpha.progress_pct, 25);
  assert.equal(alpha.remaining_paise, 75000);
  assert.equal(alpha.member_count, 1);
  assert.equal(all.summary.total_spent_paise, 25000);

  assert.equal((await api(owner, 'GET', '/events?q=alpha')).body.events.length, 1);
  assert.equal((await api(owner, 'GET', '/events?q=%25')).body.events.length, 1, '% is literal, not a wildcard');
  assert.equal((await api(owner, 'GET', '/events?q=%25zzz')).body.events.length, 0);

  assert.equal((await api(owner, 'POST', `/events/${b}/archive`)).status, 200);
  assert.equal((await api(owner, 'GET', '/events')).body.events.length, 1);
  assert.equal((await api(owner, 'GET', '/events?status=archived')).body.events.length, 1);
  assert.equal((await api(owner, 'GET', '/events?status=bogus')).status, 400);
});

test('edit event / settings: owner and admin only, validation, clearing the budget', async () => {
  const { owner, eventId, admins: [admin], members: [member] } = await setup({ admins: 1, members: 1 });
  assert.equal((await api(member, 'PATCH', `/events/${eventId}`, { title: 'Hacked' })).body.error, 'forbidden_event_edit');
  assert.equal((await api(member, 'PATCH', `/events/${eventId}/settings`, { allow_member_expenses: false })).status, 403);

  const ok = await api(admin, 'PATCH', `/events/${eventId}`, { title: 'Renamed', location: 'Goa', budget_paise: 500000 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.event.title, 'Renamed');
  assert.equal((await api(owner, 'PATCH', `/events/${eventId}`, { budget_paise: null })).body.event.budget_paise, null);
  assert.equal((await api(owner, 'PATCH', `/events/${eventId}`, { end_date: '1999-01-01' })).status, 400);
  assert.equal((await api(owner, 'PATCH', `/events/${eventId}`, {})).status, 400);
  assert.equal((await api(owner, 'PATCH', `/events/${eventId}`, { owner_id: member.id })).status, 400, 'unknown fields are rejected');
  const audit = (await pool.query("select metadata from event_audit_logs where event_id = $1 and action = 'EVENT_UPDATED' order by created_at", [eventId])).rows;
  assert.equal(audit[0].metadata.changed.title.from, 'Birthday Party');
  assert.equal(audit[0].metadata.changed.title.to, 'Renamed');

  assert.equal((await api(admin, 'PATCH', `/events/${eventId}/settings`, { join_policy: 'code_approval', members_edit_others: true })).body.event.join_policy, 'code_approval');
});

// ── invitations and joining ─────────────────────────────────────

test('join: code is case/dash tolerant; wrong, malformed and unknown codes all look identical', async () => {
  const owner = await newUser('owner');
  const eventId = await makeEvent(owner);
  const code = await inviteCode(owner, eventId);
  const joiner = await newUser('joiner');

  for (const bad of ['SPX-AAAA-BBBB', 'nonsense', '', 'SPX-7K4M', '<script>']) {
    const r = await api(joiner, 'POST', '/events/join', { code: bad || ' ' });
    assert.equal(r.status, 404, bad);
    assert.equal(r.body.error, 'invite_expired_or_invalid');
  }
  const typed = code.toLowerCase().replace(/-/g, ' ');
  const ok = await api(joiner, 'POST', '/events/join', { code: typed });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'active');
  assert.equal(ok.body.event.id, eventId);
  assert.equal((await api(joiner, 'GET', `/events/${eventId}`)).status, 200);

  const again = await api(joiner, 'POST', '/events/join', { code });
  assert.equal(again.status, 200, 'joining twice is harmless');
  assert.equal((await pool.query("select count(*)::int c from event_members where event_id = $1 and status = 'active'", [eventId])).rows[0].c, 2);
  const msgs = (await pool.query("select system_payload from event_messages where event_id = $1 and kind = 'system'", [eventId])).rows;
  assert.ok(msgs.some(m => m.system_payload.type === 'member_joined'), 'a system card announces the new member');
});

test('regenerate replaces the old code instantly; revoke disables joining; only staff may do either', async () => {
  const { owner, eventId, members: [member] } = await setup({ members: 1 });
  const oldCode = await inviteCode(owner, eventId);
  assert.equal((await api(member, 'POST', `/events/${eventId}/invite-code/regenerate`)).status, 403);

  const regen = await api(owner, 'POST', `/events/${eventId}/invite-code/regenerate`);
  assert.equal(regen.status, 200);
  assert.notEqual(regen.body.code, oldCode);
  const late = await newUser('late');
  assert.equal((await api(late, 'POST', '/events/join', { code: oldCode })).status, 404, 'old code is dead');
  assert.equal((await api(late, 'POST', '/events/join', { code: regen.body.code })).status, 200);

  assert.equal((await api(owner, 'POST', `/events/${eventId}/invite-code/revoke`)).status, 200);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/invite-code`)).body.status, 'revoked');
  assert.equal((await api(owner, 'GET', `/events/${eventId}/invite-code`)).body.code, null);
  assert.equal((await api(await newUser('x'), 'POST', '/events/join', { code: regen.body.code })).status, 404, 'revoked code is dead');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/invite-code/regenerate`)).status, 200, 'regenerating after a revoke makes a fresh code');

  await pool.query("update event_invite_codes set expires_at = now() - interval '1 minute' where event_id = $1", [eventId]);
  const expired = await api(owner, 'GET', `/events/${eventId}/invite-code`);
  assert.equal(expired.body.status, 'expired');
  assert.equal(expired.body.code, null);
});

test('members see the code only when the join policy is "code"', async () => {
  const { eventId, owner, members: [member] } = await setup({ members: 1 });
  assert.equal((await api(member, 'GET', `/events/${eventId}/invite-code`)).status, 200);
  await api(owner, 'PATCH', `/events/${eventId}/settings`, { join_policy: 'code_approval' });
  assert.equal((await api(member, 'GET', `/events/${eventId}/invite-code`)).status, 403);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/invite-code`)).status, 200);
});

test('code_approval: request waits (202), cannot see the event, approve admits, reject refuses', async () => {
  const { owner, eventId, admins: [admin], members: [member] } = await setup({ admins: 1, members: 1, eventExtra: { join_policy: 'code_approval' } });
  const code = await inviteCode(owner, eventId);
  const [p1, p2] = [await newUser('pending'), await newUser('pending')];

  const r1 = await api(p1, 'POST', '/events/join', { code });
  assert.equal(r1.status, 202);
  assert.equal(r1.body.status, 'pending');
  assert.equal((await api(p1, 'GET', `/events/${eventId}`)).status, 404, 'a pending user is still an outsider');
  assert.equal((await api(p1, 'POST', '/events/join', { code })).status, 202, 'asking again is harmless');
  await api(p2, 'POST', '/events/join', { code });

  assert.equal((await api(member, 'GET', `/events/${eventId}/invitations`)).status, 403);
  const list = (await api(admin, 'GET', `/events/${eventId}/invitations`)).body;
  assert.equal(list.join_requests.length, 2);
  assert.equal((await api(owner, 'GET', `/events/${eventId}`)).body.pending_requests_count, 2);

  assert.equal((await api(member, 'POST', `/events/${eventId}/members/${p1.id}/approve`)).status, 403);
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${p1.id}/approve`)).status, 200);
  assert.equal((await api(p1, 'GET', `/events/${eventId}`)).status, 200);
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${p1.id}/approve`)).status, 404, 'cannot approve twice');
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${p2.id}/reject`)).status, 200);
  assert.equal((await api(p2, 'GET', `/events/${eventId}`)).status, 404);
});

test('admins_only needs an email invitation; the invitation also skips approval; removed members need approval to return', async () => {
  const { owner, eventId, members: [member] } = await setup({ members: 1, eventExtra: { join_policy: 'admins_only' } });
  const code = await inviteCode(owner, eventId);
  const guest = await newUser('guest');

  const denied = await api(guest, 'POST', '/events/join', { code });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'admin_invitation_required');

  assert.equal((await api(member, 'POST', `/events/${eventId}/email-invitations`, { email: guest.email })).status, 403);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations`, { email: 'not an email' })).status, 400);
  const invite = await api(owner, 'POST', `/events/${eventId}/email-invitations`, { email: guest.email.toUpperCase() });
  assert.equal(invite.status, 201);
  assert.equal(invite.body.invitation.email, guest.email, 'stored lower-case');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations`, { email: guest.email })).body.invitation.send_count, 2, 'same address updates the one invitation');

  const ok = await api(guest, 'POST', '/events/join', { code });
  assert.equal(ok.body.status, 'active');
  const after = (await api(owner, 'GET', `/events/${eventId}/invitations`)).body.email_invitations;
  assert.equal(after[0].status, 'accepted');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations`, { email: guest.email })).body.error, 'already_member');

  // remove a member, switch to open codes: coming back still needs approval
  await api(owner, 'PATCH', `/events/${eventId}/settings`, { join_policy: 'code' });
  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${member.id}/remove`)).status, 200);
  const back = await api(member, 'POST', '/events/join', { code: await inviteCode(owner, eventId) });
  assert.equal(back.status, 202);
});

test('email invitations: resend cooldown, cancel, per-event daily limit', async () => {
  const { owner, eventId } = await setup({ members: 0 });
  const inv = (await api(owner, 'POST', `/events/${eventId}/email-invitations`, { email: 'friend@test.io' })).body.invitation;
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations/${inv.id}/resend`)).body.error, 'resend_too_soon');
  await pool.query("update event_email_invitations set last_sent_at = now() - interval '5 minutes' where id = $1", [inv.id]);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations/${inv.id}/resend`)).status, 200);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations/${inv.id}/cancel`)).status, 200);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations/${inv.id}/cancel`)).status, 404);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/email-invitations/${randomUUID()}/resend`)).status, 404);

  await pool.query("update event_email_invitations set send_count = 20, status = 'pending' where id = $1", [inv.id]);
  const limited = await api(owner, 'POST', `/events/${eventId}/email-invitations`, { email: 'someone@test.io' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'too_many_invitations');
});

test('join attempts are rate limited per user (10 per 15 minutes)', async () => {
  const guesser = await newUser('guesser');
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await api(guesser, 'POST', '/events/join', { code: 'SPX-ZZZZ-ZZZZ' })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
  assert.deepEqual(statuses.slice(10), [429, 429]);
  assert.equal((await api(await newUser('fresh'), 'POST', '/events/join', { code: 'SPX-ZZZZ-ZZZZ' })).status, 404, 'other users are unaffected');
});

test('member cap: the 101st person cannot join', async () => {
  const owner = await newUser('owner');
  const eventId = await makeEvent(owner);
  const code = await inviteCode(owner, eventId);
  const users = [];
  for (let i = 0; i < 99; i++) users.push(await newUser('bulk'));
  await pool.query(
    `insert into event_members (event_id, user_id, role, status, joined_at) select $1, unnest($2::uuid[]), 'member', 'active', now()`,
    [eventId, users.map(u => u.id)],
  );
  const full = await api(await newUser('late'), 'POST', '/events/join', { code });
  assert.equal(full.status, 409);
  assert.equal(full.body.error, 'event_member_limit');
});

// ── expenses ────────────────────────────────────────────────────

test('equal split of INR 100.01 over 3 sums to exactly 10001 paise and balances net to zero', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  const e = await addExpense(owner, eventId, owner, 10001, [owner, a, b]);
  const shares = e.shares.map(s => s.share_paise).sort();
  assert.deepEqual(shares, [3333, 3334, 3334]);
  assert.equal(shares.reduce((x, y) => x + y, 0), 10001);
  const bal = await balancesOf(owner, eventId);
  assert.equal(Object.values(bal).reduce((x, y) => x + y, 0), 0);
  assert.equal(bal[owner.id], 10001 - e.shares.find(s => s.user_id === owner.id).share_paise);
  // the same answer as the shared ledger code the mobile preview mirrors
  const local = splitExpense(10001, 'equal', [owner, a, b].map(u => ({ user_id: u.id, value: 0 })));
  for (const s of local) assert.equal(e.shares.find(x => x.user_id === s.user_id).share_paise, s.share_paise);
});

test('exact, percentage and shares splits; bad totals are rejected with clear codes', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const post = (mode, splits, amount = 1000) => api(owner, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: owner.id, amount_paise: amount, split_mode: mode, splits }));
  const two = (x, y) => [{ user_id: owner.id, value: x }, { user_id: a.id, value: y }];

  assert.equal((await post('exact', two(600, 400))).status, 201);
  assert.equal((await post('exact', two(600, 300))).body.error, 'splits_must_match_amount');
  const pct = await post('percentage', two(7000, 3000), 999);
  assert.deepEqual(pct.body.expense.shares.map(s => s.share_paise).sort(), [300, 699]);
  assert.equal((await post('percentage', two(5000, 4999))).body.error, 'percentages_must_total_100');
  const sh = await post('shares', two(1, 3), 100);
  assert.deepEqual(sh.body.expense.shares.map(s => s.share_paise).sort((x, y) => x - y), [25, 75]);
  assert.equal((await post('shares', two(0, 3))).body.error, 'shares_must_be_positive_integers');
  assert.equal((await post('equal', [{ user_id: a.id, value: 0 }, { user_id: a.id, value: 0 }])).body.error, 'invalid_split_members');
  assert.equal((await post('exact', [])).status, 400);
  for (const amount of [0, -5, 1.5, 1000000001]) assert.equal((await post('equal', two(0, 0), amount)).status, 400, `amount ${amount}`);
});

test('payer and split members must be ACTIVE members: removed and pending users are rejected', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${b.id}/remove`)).status, 200);
  const outsider = await newUser('outsider');

  const asPayer = await api(owner, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: b.id, splits: [{ user_id: owner.id, value: 0 }] }));
  assert.equal(asPayer.status, 400);
  assert.equal(asPayer.body.error, 'invalid_member');
  const inSplit = await api(owner, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: owner.id, splits: [{ user_id: owner.id, value: 0 }, { user_id: b.id, value: 0 }] }));
  assert.equal(inSplit.body.error, 'invalid_member');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: outsider.id, splits: [{ user_id: a.id, value: 0 }] }))).body.error, 'invalid_member');
  assert.equal((await pool.query('select count(*)::int c from event_expenses where event_id = $1', [eventId])).rows[0].c, 0, 'nothing was written');
});

test('retried expense create is idempotent; the same id with different content or by someone else is 409', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const body = expenseBody({ paid_by: owner.id, amount_paise: 12345, splits: [{ user_id: owner.id, value: 0 }, { user_id: a.id, value: 0 }] });
  assert.equal((await api(owner, 'POST', `/events/${eventId}/expenses`, body)).status, 201);
  const retry = await api(owner, 'POST', `/events/${eventId}/expenses`, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.expense.amount_paise, 12345);
  assert.equal((await pool.query('select count(*)::int c from event_expenses where id = $1', [body.id])).rows[0].c, 1);
  assert.equal((await pool.query('select count(*)::int c from event_expense_shares where expense_id = $1', [body.id])).rows[0].c, 2);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/expenses`, { ...body, amount_paise: 99999 })).body.error, 'duplicate_id');
  assert.equal((await api(a, 'POST', `/events/${eventId}/expenses`, body)).body.error, 'duplicate_id');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/expenses`, { ...body, id: randomUUID(), extra: 1 })).status, 400, 'unknown fields rejected');
});

test('expense permissions follow the event toggles', async () => {
  const { owner, eventId, admins: [admin], members: [a, b] } = await setup({ admins: 1, members: 2 });
  const all = [owner, admin, a, b];
  const mine = await addExpense(a, eventId, a, 9000, all);
  const theirs = await addExpense(b, eventId, b, 9000, all);
  const edit = (user, e, extra = {}) => api(user, 'PATCH', `/events/${eventId}/expenses/${e.id}`, {
    title: 'Edited', category: 'Food', amount_paise: e.amount_paise, expense_date: today(), paid_by: e.paid_by, split_mode: 'equal',
    splits: all.map(u => ({ user_id: u.id, value: 0 })), ...extra,
  });

  assert.equal((await edit(a, mine)).status, 200, 'a member can edit their own expense');
  assert.equal((await edit(a, theirs)).body.error, 'forbidden_expense_edit', "but not someone else's");
  assert.equal((await api(a, 'DELETE', `/events/${eventId}/expenses/${theirs.id}`)).status, 403);
  assert.equal((await edit(admin, theirs)).status, 200, 'an admin can edit anyone');

  await api(owner, 'PATCH', `/events/${eventId}/settings`, { members_edit_others: true });
  assert.equal((await edit(a, theirs)).status, 200, '"Member editing rules" on lets members edit others');

  await api(owner, 'PATCH', `/events/${eventId}/settings`, { allow_member_expenses: false });
  const blocked = await api(a, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: a.id, splits: [{ user_id: a.id, value: 0 }] }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'forbidden_expense_create');
  assert.equal((await edit(a, mine)).status, 403, 'with member entry off, members cannot change the ledger at all');
  assert.equal((await addExpense(admin, eventId, admin, 1000, [admin])).amount_paise, 1000, 'staff still can');
});

test('edit: replaces shares, bumps version, keeps the old values in the audit log, detects stale edits', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const e = await addExpense(owner, eventId, owner, 10000, [owner, a]);
  assert.equal(e.version, 1);
  const url = `/events/${eventId}/expenses/${e.id}`;
  const body = (over) => ({ title: 'Dinner v2', category: 'Food', amount_paise: 20000, expense_date: today(), paid_by: owner.id, split_mode: 'exact', splits: [{ user_id: owner.id, value: 5000 }, { user_id: a.id, value: 15000 }], ...over });

  const upd = await api(owner, 'PATCH', url, body({ version: 1 }));
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.expense.version, 2);
  assert.equal((await balancesOf(owner, eventId))[a.id], -15000);
  assert.equal((await api(owner, 'PATCH', url, body({ version: 1 }))).body.error, 'version_conflict');
  assert.equal((await api(owner, 'PATCH', url, body({ splits: [{ user_id: owner.id, value: 1 }, { user_id: a.id, value: 1 }] }))).body.error, 'splits_must_match_amount');
  assert.equal((await pool.query('select count(*)::int c from event_expense_shares where expense_id = $1', [e.id])).rows[0].c, 2, 'no duplicate share rows');

  const audit = (await pool.query("select metadata from event_audit_logs where target_id = $1 and action = 'EXPENSE_UPDATED'", [e.id])).rows[0];
  assert.equal(audit.metadata.previous.amount_paise, 10000);
  assert.equal(audit.metadata.previous.shares.length, 2);
  assert.equal((await api(owner, 'PATCH', `/events/${eventId}/expenses/${randomUUID()}`, body())).status, 404);
});

test('void removes an expense from the books, keeps the record, and is idempotent', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const e = await addExpense(owner, eventId, owner, 10000, [owner, a]);
  assert.equal((await balancesOf(owner, eventId))[a.id], -5000);
  assert.equal((await api(owner, 'DELETE', `/events/${eventId}/expenses/${e.id}`)).status, 200);
  assert.equal((await api(owner, 'DELETE', `/events/${eventId}/expenses/${e.id}`)).status, 200, 'retry is a success');
  assert.equal((await balancesOf(owner, eventId))[a.id], 0);
  assert.equal((await pool.query('select status from event_expenses where id = $1', [e.id])).rows[0].status, 'voided', 'the row is kept');
  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses`)).body.expenses.length, 0);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses/${e.id}`)).status, 404);
  assert.equal((await api(owner, 'PATCH', `/events/${eventId}/expenses/${e.id}`, { title: 'x', category: 'Food', amount_paise: 1000, expense_date: today(), paid_by: owner.id, split_mode: 'equal', splits: [{ user_id: owner.id, value: 0 }] })).body.error, 'expense_voided');
  assert.equal((await api(owner, 'GET', `/events/${eventId}`)).body.stats.spent_paise, 0);
  const sys = (await pool.query("select system_payload->>'type' t from event_messages where event_id = $1 and kind = 'system' order by created_at", [eventId])).rows.map(r => r.t);
  assert.ok(sys.includes('expense_added') && sys.includes('expense_voided'));
});

test('expense list: newest first, keyset pagination, search (no LIKE wildcards), category filter, my share', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const titles = ['Cake', 'Taxi 100%', 'Hotel', 'Snacks', 'Tickets'];
  for (const [i, title] of titles.entries()) {
    await addExpense(owner, eventId, i % 2 ? a : owner, 1000 + i, [owner, a], { title, category: i === 1 ? 'Travel' : 'Food', expense_date: `2026-09-${10 + i}` });
  }
  const page1 = (await api(owner, 'GET', `/events/${eventId}/expenses?limit=2`)).body;
  assert.deepEqual(page1.expenses.map(e => e.title), ['Tickets', 'Snacks']);
  assert.ok(page1.next_cursor);
  assert.equal(page1.summary.expense_count, 5);
  assert.equal(page1.summary.active_members, 2);
  const page2 = (await api(owner, 'GET', `/events/${eventId}/expenses?limit=2&cursor=${page1.next_cursor}`)).body;
  const page3 = (await api(owner, 'GET', `/events/${eventId}/expenses?limit=2&cursor=${page2.next_cursor}`)).body;
  assert.deepEqual([...page1.expenses, ...page2.expenses, ...page3.expenses].map(e => e.title), ['Tickets', 'Snacks', 'Hotel', 'Taxi 100%', 'Cake']);
  assert.equal(page3.next_cursor, null);

  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses?q=cake`)).body.expenses.length, 1);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses?q=%25`)).body.expenses.length, 1, '% matches only the literal');
  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses?q=_`)).body.expenses.length, 0, '_ is not a wildcard');
  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses?category=Travel`)).body.expenses.length, 1);
  const mine = (await api(owner, 'GET', `/events/${eventId}/expenses?limit=1`)).body.expenses[0];
  assert.equal(mine.my_share_paise, 502);
  assert.equal(mine.paid_by_me, true);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses?cursor=garbage`)).body.error, 'invalid_cursor');
  assert.equal((await api(owner, 'GET', `/events/${eventId}/expenses?limit=0`)).status, 400);
});

test('receipts attach only if uploaded by the same user for the same event, as a receipt', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const other = await setup({ members: 0 });
  const receipt = await upload(a, eventId, 'receipt');
  const proof = await upload(a, eventId, 'proof');
  const foreign = await upload(other.owner, other.eventId, 'receipt');
  const post = (user, file) => api(user, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: user.id, splits: [{ user_id: user.id, value: 0 }], receipt_file_id: file }));

  assert.equal((await post(a, receipt.id)).status, 201);
  assert.equal((await post(owner, receipt.id)).body.error, 'invalid_file', "someone else's upload");
  assert.equal((await post(a, proof.id)).body.error, 'invalid_file', 'wrong purpose');
  assert.equal((await post(a, foreign.id)).body.error, 'invalid_file', 'another event');
  assert.equal((await post(a, randomUUID())).body.error, 'invalid_file');
  assert.equal((await api(a, 'GET', `/files/${receipt.id}`)).status, 200);
  assert.equal((await api(owner, 'GET', `/files/${receipt.id}`)).status, 200, 'every member can see receipts');
});

// ── members ─────────────────────────────────────────────────────

test('roles: only the owner promotes/demotes; admins remove members but not admins; nobody removes the owner', async () => {
  const { owner, eventId, admins: [admin], members: [a, b] } = await setup({ admins: 1, members: 2 });
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${a.id}/promote`)).status, 403);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${admin.id}/promote`)).status, 403, 'already admin');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${a.id}/demote`)).status, 403, 'not an admin');
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${owner.id}/remove`)).status, 403);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${owner.id}/remove`)).status, 403, 'owner cannot remove themselves');
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${admin.id}/remove`)).status, 403, 'use leave');
  assert.equal((await api(a, 'POST', `/events/${eventId}/members/${b.id}/remove`)).status, 403);

  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${a.id}/promote`)).status, 200);
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${a.id}/remove`)).status, 403, 'an admin cannot remove another admin');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${a.id}/demote`)).status, 200);
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${b.id}/remove`)).status, 200);
  assert.equal((await api(admin, 'POST', `/events/${eventId}/members/${b.id}/remove`)).status, 404);
  assert.equal((await api(b, 'GET', `/events/${eventId}`)).status, 404, 'a removed member is an outsider');
  const roles = (await pool.query("select role, status from event_members where event_id = $1 and user_id = $2", [eventId, b.id])).rows[0];
  assert.deepEqual(roles, { role: 'member', status: 'removed' });
  const log = (await pool.query('select action from event_audit_logs where event_id = $1', [eventId])).rows.map(r => r.action);
  for (const action of ['MEMBER_PROMOTED', 'MEMBER_DEMOTED', 'MEMBER_REMOVED']) assert.ok(log.includes(action), action);
});

test('a member with a balance cannot be removed or leave until settled', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  await addExpense(owner, eventId, owner, 30000, [owner, a, b]);

  const rm = await api(owner, 'POST', `/events/${eventId}/members/${a.id}/remove`);
  assert.equal(rm.status, 409);
  assert.equal(rm.body.error, 'settle_member_balance_first');
  assert.equal((await api(a, 'POST', `/events/${eventId}/leave`)).body.error, 'settle_balance_before_leaving');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/leave`)).status, 403, 'the owner must transfer ownership first');

  const paid = await markPaid(a, eventId, owner, 10000);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/members/${a.id}/remove`)).body.error, 'settle_member_balance_first');
  await api(owner, 'POST', `/events/${eventId}/settlements/${paid.body.settlement.id}/confirm`);
  assert.equal((await api(a, 'POST', `/events/${eventId}/leave`)).status, 200);
  assert.equal((await api(a, 'GET', `/events/${eventId}`)).status, 404);
  assert.equal((await balancesOf(owner, eventId))[a.id], 0, 'their history stays in the ledger');
});

test('transfer ownership: exactly one owner at all times; the old owner becomes a member', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  const url = `/events/${eventId}/transfer-ownership`;
  assert.equal((await api(a, 'POST', url, { new_owner_id: b.id })).status, 403);
  assert.equal((await api(owner, 'POST', url, { new_owner_id: owner.id })).body.error, 'already_owner');
  assert.equal((await api(owner, 'POST', url, { new_owner_id: (await newUser('x')).id })).status, 404);
  assert.equal((await api(owner, 'POST', url, { new_owner_id: a.id })).status, 200);

  const rows = (await pool.query("select user_id, role from event_members where event_id = $1 and status = 'active'", [eventId])).rows;
  assert.equal(rows.filter(r => r.role === 'owner').length, 1);
  assert.equal(rows.find(r => r.user_id === a.id).role, 'owner');
  assert.equal(rows.find(r => r.user_id === owner.id).role, 'member');
  assert.equal((await pool.query('select owner_id from events where id = $1', [eventId])).rows[0].owner_id, a.id);
  assert.equal((await api(owner, 'DELETE', `/events/${eventId}`, { confirm: true })).status, 403, 'the old owner lost owner powers');
});

test('payment profile: set once, validated, visible to members of a shared event only', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const outsider = await newUser('outsider');
  assert.deepEqual((await api(a, 'GET', '/me/payment-profile')).body.upi_id, null);
  for (const bad of ['', 'nope', 'a@b', 'x y@okhdfc', '@oksbi']) assert.equal((await api(a, 'PUT', '/me/payment-profile', { upi_id: bad })).status, 400, bad);
  assert.equal((await api(a, 'PUT', '/me/payment-profile', { upi_id: '  Balu.M@OKSBI ' })).body.upi_id, 'balu.m@oksbi');
  assert.equal((await api(a, 'GET', '/me/payment-profile')).body.upi_id, 'balu.m@oksbi');

  const seen = await api(owner, 'GET', `/events/${eventId}/members/${a.id}/payment-profile`);
  assert.equal(seen.body.upi_id, 'balu.m@oksbi');
  assert.equal((await api(outsider, 'GET', `/events/${eventId}/members/${a.id}/payment-profile`)).status, 404);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/members/${outsider.id}/payment-profile`)).status, 404, 'only for active members of this event');
  assert.equal((await api(a, 'DELETE', '/me/payment-profile')).status, 200);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/members/${a.id}/payment-profile`)).body.upi_id, null);
});

// ── settlements ─────────────────────────────────────────────────

test('settlement: a balance moves only after the recipient confirms', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  await addExpense(owner, eventId, owner, 30000, [owner, a, b]);
  const before = await balancesOf(owner, eventId);
  assert.deepEqual([before[owner.id], before[a.id], before[b.id]], [20000, -10000, -10000]);

  const marked = await markPaid(a, eventId, owner, 10000, { upi_app: 'phonepe', utr: 'T2609271234ABCD' });
  assert.equal(marked.status, 201, JSON.stringify(marked.body));
  const s = marked.body.settlement;
  assert.equal(s.status, 'pending_confirmation');
  assert.match(s.reference_code, /^TXN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(s.upi_app, 'phonepe');
  assert.deepEqual(await balancesOf(owner, eventId), before, 'pending payments never move a balance');
  const bal = (await api(owner, 'GET', `/events/${eventId}/balances`)).body;
  assert.equal(bal.pending.length, 1);
  assert.equal(bal.settled, false);

  const confirm = await api(owner, 'POST', `/events/${eventId}/settlements/${s.id}/confirm`);
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  assert.equal(confirm.body.settlement.status, 'confirmed');
  assert.equal(confirm.body.balances_after[a.id], 0);
  assert.equal(confirm.body.balances_after[owner.id], 10000);
  const after = await balancesOf(owner, eventId);
  assert.deepEqual([after[owner.id], after[a.id], after[b.id]], [10000, 0, -10000]);
  assert.equal(Object.values(after).reduce((x, y) => x + y, 0), 0);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/settlements/${s.id}/confirm`)).body.error, 'wrong_state', 'cannot confirm twice');
});

test('settlement rules: amount capped by the debt, only a debtor can pay, no self-approval, one pending per pair', async () => {
  const { owner, eventId, admins: [admin], members: [a, b] } = await setup({ admins: 1, members: 2 });
  await addExpense(owner, eventId, owner, 30000, [owner, a, b]);

  assert.equal((await markPaid(a, eventId, owner, 10001)).body.error, 'invalid_settlement', 'more than they owe');
  assert.equal((await markPaid(owner, eventId, a, 100)).body.error, 'invalid_settlement', 'a creditor cannot pay');
  assert.equal((await markPaid(a, eventId, b, 100)).body.error, 'invalid_settlement', 'debtor to debtor');
  assert.equal((await markPaid(a, eventId, a, 100)).status, 403, 'not yourself');
  assert.equal((await markPaid(a, eventId, await newUser('x'), 100)).body.error, 'invalid_member');
  for (const bad of [0, -1, 1.5, 1000000001]) assert.equal((await markPaid(a, eventId, owner, bad)).status, 400);
  assert.equal((await markPaid(a, eventId, owner, 100, { method: 'bitcoin' })).status, 400);
  assert.equal((await markPaid(a, eventId, owner, 100, { method: 'cash', upi_app: 'gpay' })).status, 400, 'upi_app only for upi');
  assert.equal((await markPaid(a, eventId, owner, 100, { utr: 'x' })).status, 400);

  const ok = await markPaid(a, eventId, owner, 4000, { id: randomUUID() });
  assert.equal(ok.status, 201);
  const sid = ok.body.settlement.id;
  assert.equal((await markPaid(a, eventId, owner, 1000)).body.error, 'pending_settlement_exists');
  assert.equal((await api(a, 'POST', `/events/${eventId}/settlements/${sid}/confirm`)).status, 403, 'the payer cannot approve their own payment');
  assert.equal((await api(b, 'POST', `/events/${eventId}/settlements/${sid}/confirm`)).status, 403, 'a bystander cannot');
  assert.equal((await api(admin, 'POST', `/events/${eventId}/settlements/${sid}/confirm`)).status, 403, 'an admin who is not the recipient cannot');
  assert.equal((await api(b, 'POST', `/events/${eventId}/settlements/${sid}/cancel`)).status, 403);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/settlements/${randomUUID()}/confirm`)).status, 404);
});

test('settlement retry with the same id is idempotent; a different payload with that id is 409', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  await addExpense(owner, eventId, owner, 20000, [owner, a]);
  const id = randomUUID();
  const first = await markPaid(a, eventId, owner, 5000, { id });
  const retry = await markPaid(a, eventId, owner, 5000, { id });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.settlement.reference_code, first.body.settlement.reference_code);
  assert.equal((await pool.query('select count(*)::int c from event_settlements where id = $1', [id])).rows[0].c, 1);
  assert.equal((await markPaid(a, eventId, owner, 6000, { id })).body.error, 'duplicate_id');
});

test('confirming re-checks the CURRENT balances: balance_changed when the debt shrank meanwhile', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const e = await addExpense(owner, eventId, owner, 20000, [owner, a]);
  const paid = await markPaid(a, eventId, owner, 10000);
  await api(owner, 'DELETE', `/events/${eventId}/expenses/${e.id}`); // the debt disappears

  const confirm = await api(owner, 'POST', `/events/${eventId}/settlements/${paid.body.settlement.id}/confirm`);
  assert.equal(confirm.status, 409);
  assert.equal(confirm.body.error, 'balance_changed');
  assert.deepEqual(Object.values(await balancesOf(owner, eventId)), [0, 0], 'nothing moved');
  assert.equal((await api(a, 'POST', `/events/${eventId}/settlements/${paid.body.settlement.id}/cancel`)).status, 200);
  assert.equal((await api(a, 'POST', `/events/${eventId}/settlements/${paid.body.settlement.id}/cancel`)).body.error, 'wrong_state');
});

test('reject and cancel free the pair for a new attempt; history, filters and proof visibility', async () => {
  const { owner, eventId, admins: [admin], members: [a, b] } = await setup({ admins: 1, members: 2 });
  await addExpense(owner, eventId, owner, 40000, [owner, a, b, admin]);

  const proofFile = await upload(a, eventId, 'proof');
  const first = await markPaid(a, eventId, owner, 10000, { proof_file_id: proofFile.id });
  assert.equal(first.status, 201);
  const sid = first.body.settlement.id;
  assert.equal((await markPaid(b, eventId, owner, 10000, { proof_file_id: proofFile.id })).body.error, 'invalid_file', "someone else's upload cannot be reused");

  assert.equal((await api(owner, 'GET', `/files/${proofFile.id}`)).status, 200, 'recipient sees the proof');
  assert.equal((await api(a, 'GET', `/files/${proofFile.id}`)).status, 200, 'the payer too');
  assert.equal((await api(admin, 'GET', `/files/${proofFile.id}`)).status, 200, 'admins too');
  const hidden = await api(b, 'GET', `/files/${proofFile.id}`);
  assert.equal(hidden.status, 404, 'a bystander cannot see a payment screenshot');
  assert.equal(hidden.body.error, 'file_not_found');

  const asB = (await api(b, 'GET', `/events/${eventId}/settlements`)).body.settlements[0];
  assert.equal(asB.has_proof, true);
  assert.equal(asB.proof_file_id, null, 'the file id is not even handed to bystanders');
  assert.equal(asB.direction, 'other');
  assert.equal((await api(a, 'GET', `/events/${eventId}/settlements`)).body.settlements[0].direction, 'sent');
  assert.equal((await api(owner, 'GET', `/events/${eventId}/settlements`)).body.settlements[0].direction, 'received');

  const rej = await api(owner, 'POST', `/events/${eventId}/settlements/${sid}/reject`, { reason: 'Amount does not match' });
  assert.equal(rej.status, 200);
  assert.equal((await pool.query('select status, rejection_reason from event_settlements where id = $1', [sid])).rows[0].rejection_reason, 'Amount does not match');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/settlements/${sid}/reject`)).body.error, 'wrong_state');
  const second = await markPaid(a, eventId, owner, 10000);
  assert.equal(second.status, 201, 'after a rejection the payer can try again');
  await api(a, 'POST', `/events/${eventId}/settlements/${second.body.settlement.id}/cancel`);
  const third = await markPaid(a, eventId, owner, 10000);
  await api(owner, 'POST', `/events/${eventId}/settlements/${third.body.settlement.id}/confirm`);

  const byStatus = async s => (await api(owner, 'GET', `/events/${eventId}/settlements?status=${s}`)).body.settlements.length;
  assert.deepEqual([await byStatus('confirmed'), await byStatus('rejected'), await byStatus('cancelled'), await byStatus('pending_confirmation')], [1, 1, 1, 0]);
  const ref = third.body.settlement.reference_code;
  assert.equal((await api(owner, 'GET', `/events/${eventId}/settlements?q=${ref}`)).body.settlements.length, 1, 'search by reference');
  const paged = (await api(owner, 'GET', `/events/${eventId}/settlements?limit=2`)).body;
  assert.equal(paged.settlements.length, 2);
  assert.equal((await api(owner, 'GET', `/events/${eventId}/settlements?limit=2&cursor=${paged.next_cursor}`)).body.settlements.length, 1);
});

test('balances screen: gross owe/owed, simplified suggestions, member rows', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  await addExpense(owner, eventId, owner, 90000, [owner, a, b]);          // a, b each owe owner 30000
  await addExpense(a, eventId, a, 30000, [owner, a, b]);                  // owner, b each owe a 10000
  const bal = (await api(owner, 'GET', `/events/${eventId}/balances`)).body;

  assert.equal(bal.me.net_paise, 50000);
  assert.equal(bal.me.paid_paise, 90000);
  assert.equal(bal.me.owed_paise, 50000, 'a owes 30000 less the 10000 owed back = 20000, plus b owes 30000');
  assert.equal(bal.me.you_owe_paise, 0);
  assert.deepEqual(
    bal.members.map(m => [m.user_id, m.balance_paise, m.status]),
    [[owner.id, 50000, 'owed'], [a.id, -10000, 'owes'], [b.id, -40000, 'owes']],
  );
  assert.equal(bal.members[0].is_me, true);
  assert.equal(bal.suggestions.length, 2, 'two payers settle one creditor');
  assert.ok(bal.suggestions.every(x => x.to === owner.id && x.amount_paise > 0 && x.from_name && x.to_name));
  assert.equal(bal.suggestions.reduce((sum, x) => sum + x.amount_paise, 0), 50000);

  const asA = (await api(a, 'GET', `/events/${eventId}/balances`)).body;
  assert.equal(asA.me.you_owe_paise, 20000, 'a owes the owner 30000 but is owed 10000 back by them');
  assert.equal(asA.me.owed_paise, 10000, 'b owes a 10000');
  assert.equal(asA.me.owed_paise - asA.me.you_owe_paise, asA.me.net_paise, 'gross figures always reconcile with the net balance');
  assert.deepEqual(asA.suggestions.filter(x => x.i_pay).map(x => x.amount_paise), [10000]);
});

test('complete: needs zero balances and no pending payments; locks the ledger; only the owner; reopen undoes it', async () => {
  const { owner, eventId, admins: [admin], members: [a] } = await setup({ admins: 1, members: 1 });
  await addExpense(owner, eventId, owner, 20000, [owner, a]);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/complete`)).body.error, 'settle_balances_first');
  assert.equal((await api(admin, 'POST', `/events/${eventId}/complete`)).status, 403);

  const paid = await markPaid(a, eventId, owner, 10000);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/complete`)).body.error, 'pending_settlements_exist');
  await api(owner, 'POST', `/events/${eventId}/settlements/${paid.body.settlement.id}/confirm`);
  const done = await api(owner, 'POST', `/events/${eventId}/complete`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.event.status, 'completed');
  assert.ok(done.body.event.completed_at);

  const locked = [
    api(owner, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: owner.id, splits: [{ user_id: owner.id, value: 0 }] })),
    api(owner, 'PATCH', `/events/${eventId}`, { title: 'x' }),
    api(owner, 'POST', `/events/${eventId}/invite-code/regenerate`),
    markPaid(a, eventId, owner, 1),
    api(owner, 'POST', `/events/${eventId}/complete`),
  ];
  for (const r of await Promise.all(locked)) {
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'event_not_active');
  }
  assert.equal((await api(a, 'GET', `/events/${eventId}/expenses`)).status, 200, 'still readable');
  assert.equal((await api(a, 'POST', '/events/join', { code: 'SPX-ZZZZ-ZZZZ' })).status, 404);
  assert.equal((await api(owner, 'GET', `/events/${eventId}`)).body.settlements.all_settled, true);

  assert.equal((await api(a, 'POST', `/events/${eventId}/reopen`)).status, 403);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/reopen`)).body.event.status, 'active');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/reopen`)).body.error, 'event_not_completed');
  assert.equal((await addExpense(owner, eventId, owner, 500, [owner])).amount_paise, 500);
});

test('archive hides the event but keeps it readable; duplicate copies settings, not money or people', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1, eventExtra: { title: 'Goa', location: 'Goa', join_policy: 'code_approval' } });
  await addExpense(owner, eventId, owner, 5000, [owner, a]);
  assert.equal((await api(a, 'POST', `/events/${eventId}/duplicate`, {})).status, 403);
  const copy = await api(owner, 'POST', `/events/${eventId}/duplicate`, { start_date: '2027-01-10' });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.event.title, 'Goa (copy)');
  assert.equal(copy.body.event.location, 'Goa');
  assert.equal(copy.body.event.join_policy, 'code_approval');
  assert.equal(copy.body.event.start_date, '2027-01-10');
  assert.equal(copy.body.event.owner_id, owner.id);
  const d = (await api(owner, 'GET', `/events/${copy.body.event.id}`)).body;
  assert.equal(d.members.length, 1);
  assert.equal(d.stats.expense_count, 0);
  assert.notEqual((await api(owner, 'GET', `/events/${copy.body.event.id}/invite-code`)).body.code, await inviteCode(owner, eventId), 'a new code');

  assert.equal((await api(a, 'POST', `/events/${eventId}/archive`)).status, 403);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/archive`)).body.event.status, 'archived');
  assert.equal((await api(owner, 'POST', `/events/${eventId}/archive`)).body.error, 'event_archived');
  assert.equal((await api(a, 'GET', `/events/${eventId}`)).status, 200, 'members can still open it');
  assert.equal((await api(a, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: a.id, splits: [{ user_id: a.id, value: 0 }] }))).status, 409);
});

test('delete: explicit confirmation, owner only, erases rows and files from disk', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const receipt = await upload(a, eventId, 'receipt');
  await api(a, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: a.id, splits: [{ user_id: a.id, value: 0 }], receipt_file_id: receipt.id }));
  const key = (await pool.query('select storage_key from files where id = $1', [receipt.id])).rows[0].storage_key;
  assert.ok(fs.existsSync(path.join(uploadDir, key)));

  assert.equal((await api(a, 'DELETE', `/events/${eventId}`, { confirm: true })).status, 403);
  assert.equal((await api(owner, 'DELETE', `/events/${eventId}`)).status, 400, 'no confirmation');
  assert.equal((await api(owner, 'DELETE', `/events/${eventId}`, { confirm: false })).status, 400);
  assert.equal((await api(owner, 'GET', `/events/${eventId}`)).status, 200, 'still there');

  assert.equal((await api(owner, 'DELETE', `/events/${eventId}`, { confirm: true })).status, 200);
  for (const t of ['events', 'event_members', 'event_expenses', 'event_settlements', 'event_messages', 'event_audit_logs', 'files']) {
    const col = t === 'events' ? 'id' : 'event_id';
    assert.equal((await pool.query(`select count(*)::int c from ${t} where ${col} = $1`, [eventId])).rows[0].c, 0, t);
  }
  assert.ok(!fs.existsSync(path.join(uploadDir, 'events', eventId)), 'the stored files are gone');
  assert.equal((await api(owner, 'GET', `/events/${eventId}`)).status, 404);
  assert.equal((await api(a, 'GET', `/files/${receipt.id}`)).status, 404);
  assert.equal((await api(owner, 'DELETE', `/events/${eventId}`, { confirm: true })).status, 404);
});

test('remind / request payment: only a creditor, only for a real debt, once per 24 hours', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  await addExpense(owner, eventId, owner, 30000, [owner, a, b]);
  const remind = (user, target, kind = 'remind') => api(user, 'POST', `/events/${eventId}/remind`, { target_user: target.id, kind });

  const first = await remind(owner, a);
  assert.equal(first.status, 200);
  assert.equal(first.body.amount_paise, 10000);
  assert.match(first.body.message, /₹100\.00/);
  assert.match(first.body.message, /Birthday Party/);
  assert.equal((await remind(owner, a)).body.error, 'reminder_too_soon');
  assert.equal((await remind(owner, a, 'request')).status, 200, 'a payment request is a separate allowance');
  assert.equal((await remind(a, owner)).body.error, 'nothing_owed', 'a debtor cannot chase their creditor');
  assert.equal((await remind(a, b)).body.error, 'nothing_owed', 'nor another debtor');
  assert.equal((await remind(owner, owner)).status, 403);
  assert.equal((await remind(owner, await newUser('x'))).status, 404);
  assert.equal((await api(owner, 'POST', `/events/${eventId}/remind`, { target_user: a.id, kind: 'shout' })).status, 400);

  await pool.query("update event_reminders set sent_at = now() - interval '25 hours' where event_id = $1", [eventId]);
  assert.equal((await remind(owner, a)).status, 200, 'allowed again after a day');
});

test('concurrent writes cannot unbalance the ledger or double-confirm a payment', async () => {
  const { owner, eventId, members: [a, b] } = await setup({ members: 2 });
  await addExpense(owner, eventId, owner, 30000, [owner, a, b]);

  // 15 expenses at once
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    api(i % 2 ? a : b, 'POST', `/events/${eventId}/expenses`, expenseBody({ paid_by: owner.id, amount_paise: 100 + i, splits: [owner, a, b].map(u => ({ user_id: u.id, value: 0 })) }))));
  assert.ok(results.every(r => r.status === 201));
  const bal = await balancesOf(owner, eventId);
  assert.equal(Object.values(bal).reduce((x, y) => x + y, 0), 0);

  // two confirms of the same payment at once: exactly one wins
  const paid = await markPaid(a, eventId, owner, 5000);
  const [c1, c2] = await Promise.all([1, 2].map(() => api(owner, 'POST', `/events/${eventId}/settlements/${paid.body.settlement.id}/confirm`)));
  assert.deepEqual([c1.status, c2.status].sort(), [200, 409]);
  const after = await balancesOf(owner, eventId);
  assert.equal(after[a.id], bal[a.id] + 5000, 'applied exactly once');
});

test('the audit log and activity feed record who did what', async () => {
  const { owner, eventId, members: [a] } = await setup({ members: 1 });
  const e = await addExpense(a, eventId, a, 7000, [owner, a]);
  await api(a, 'DELETE', `/events/${eventId}/expenses/${e.id}`);
  const actions = (await pool.query('select action, actor_id from event_audit_logs where event_id = $1 order by created_at', [eventId])).rows;
  for (const want of ['EVENT_CREATED', 'MEMBER_JOINED', 'EXPENSE_CREATED', 'EXPENSE_VOIDED']) assert.ok(actions.some(r => r.action === want), want);
  assert.ok(actions.filter(r => r.action.startsWith('EXPENSE')).every(r => r.actor_id === a.id));
  const feed = (await pool.query('select kind from event_activity where event_id = $1', [eventId])).rows.map(r => r.kind);
  assert.ok(feed.includes('expense_added') && feed.includes('expense_voided') && feed.includes('member_joined'));
});
