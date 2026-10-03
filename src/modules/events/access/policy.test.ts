import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, listPermissions, ALL_ACTIONS } from './policy';
import { assertCan, denial } from './denial';
import { Action, DenyReason, EventContext, EventRole, EventRow } from './types';

// o = owner, a = admin, m = member (the acting user in each column); n, x = other people.
const USER: Record<EventRole, string> = { owner: 'o', admin: 'a', member: 'm' };

function ctxFor(role: EventRole, eventOverrides: Partial<EventRow> = {}): EventContext {
  return {
    userId: USER[role],
    role,
    event: {
      id: 'e1', owner_id: 'o', status: 'active', join_policy: 'code',
      allow_member_expenses: true, members_edit_others: false,
      ...eventOverrides,
    },
  };
}

interface Row {
  action: Action;
  name: string;
  resource?: unknown;
  event?: Partial<EventRow>;
  /** [owner, admin, member] */
  expect: [boolean, boolean, boolean];
  reason?: DenyReason; // reason expected for every denied column
}

const T = true;
const F = false;
const completed = { status: 'completed' } as const;
const archived = { status: 'archived' } as const;

const pending = 'pending_confirmation';

const rows: Row[] = [
  // ── read ──
  ...(['event.view', 'chat.read', 'analytics.view'] as Action[]).flatMap(action => [
    { action, name: 'active', expect: [T, T, T] as Row['expect'] },
    { action, name: 'completed', event: completed, expect: [T, T, T] as Row['expect'] },
    { action, name: 'archived', event: archived, expect: [T, T, T] as Row['expect'] },
  ]),

  // ── event ──
  ...(['event.edit', 'settings.edit'] as Action[]).flatMap(action => [
    { action, name: 'active', expect: [T, T, F] as Row['expect'], reason: 'role_required' as DenyReason },
    { action, name: 'completed', event: completed, expect: [F, F, F] as Row['expect'] },
  ]),
  { action: 'event.complete', name: 'active', expect: [T, F, F], reason: 'role_required' },
  { action: 'event.complete', name: 'completed', event: completed, expect: [F, F, F] },
  { action: 'event.reopen', name: 'completed', event: completed, expect: [T, F, F], reason: 'role_required' },
  { action: 'event.reopen', name: 'active', expect: [F, F, F] },
  { action: 'event.reopen', name: 'archived', event: archived, expect: [F, F, F] },
  { action: 'event.archive', name: 'active', expect: [T, F, F], reason: 'role_required' },
  { action: 'event.archive', name: 'completed', event: completed, expect: [T, F, F] },
  { action: 'event.archive', name: 'already archived', event: archived, expect: [F, F, F] },
  { action: 'event.delete', name: 'active', expect: [T, F, F], reason: 'role_required' },
  { action: 'event.delete', name: 'archived', event: archived, expect: [T, F, F] },
  { action: 'event.duplicate', name: 'completed', event: completed, expect: [T, F, F], reason: 'role_required' },
  { action: 'ownership.transfer', name: 'active', expect: [T, F, F], reason: 'role_required' },
  { action: 'ownership.transfer', name: 'archived', event: archived, expect: [F, F, F] },

  // ── invitations ──
  { action: 'invite.view_code', name: 'join policy = code', expect: [T, T, T] },
  { action: 'invite.view_code', name: 'join policy = code_approval', event: { join_policy: 'code_approval' }, expect: [T, T, F], reason: 'role_required' },
  { action: 'invite.view_code', name: 'join policy = admins_only', event: { join_policy: 'admins_only' }, expect: [T, T, F], reason: 'role_required' },
  { action: 'invite.view_code', name: 'completed', event: completed, expect: [F, F, F], reason: 'event_not_active' },
  ...(['invite.regenerate', 'invite.revoke', 'invite.email', 'invite.cancel'] as Action[]).flatMap(action => [
    { action, name: 'active', expect: [T, T, F] as Row['expect'], reason: 'role_required' as DenyReason },
    { action, name: 'completed', event: completed, expect: [F, F, F] as Row['expect'] },
  ]),

  // ── members ──
  { action: 'member.approve_request', name: 'active', expect: [T, T, F], reason: 'role_required' },
  { action: 'member.approve_request', name: 'completed', event: completed, expect: [F, F, F] },
  { action: 'member.remove', name: 'no target', expect: [T, T, F], reason: 'role_required' },
  { action: 'member.remove', name: 'target member', resource: { user_id: 'n', role: 'member' }, expect: [T, T, F] },
  { action: 'member.remove', name: 'target admin', resource: { user_id: 'x', role: 'admin' }, expect: [T, F, F] },
  { action: 'member.remove', name: 'target owner', resource: { user_id: 'o', role: 'owner' }, expect: [F, F, F] },
  { action: 'member.remove', name: 'completed', event: completed, resource: { user_id: 'n', role: 'member' }, expect: [F, F, F] },
  { action: 'member.promote', name: 'no target', expect: [T, F, F], reason: 'role_required' },
  { action: 'member.promote', name: 'target member', resource: { user_id: 'n', role: 'member' }, expect: [T, F, F] },
  { action: 'member.promote', name: 'target already admin', resource: { user_id: 'x', role: 'admin' }, expect: [F, F, F] },
  { action: 'member.demote', name: 'no target', expect: [T, F, F], reason: 'role_required' },
  { action: 'member.demote', name: 'target admin', resource: { user_id: 'x', role: 'admin' }, expect: [T, F, F] },
  { action: 'member.demote', name: 'target member', resource: { user_id: 'n', role: 'member' }, expect: [F, F, F] },
  { action: 'member.leave', name: 'active', expect: [F, T, T], reason: 'role_required' },
  { action: 'member.leave', name: 'completed', event: completed, expect: [F, T, T] },

  // ── expenses ──
  { action: 'expense.create', name: 'members allowed', expect: [T, T, T] },
  { action: 'expense.create', name: 'members not allowed', event: { allow_member_expenses: false }, expect: [T, T, F], reason: 'toggle_off' },
  { action: 'expense.create', name: 'completed', event: completed, expect: [F, F, F], reason: 'event_not_active' },
  ...(['expense.edit', 'expense.void'] as Action[]).flatMap(action => [
    { action, name: 'own expense', resource: { created_by: 'm' }, expect: [T, T, T] as Row['expect'] },
    { action, name: "someone else's expense", resource: { created_by: 'n' }, expect: [T, T, F] as Row['expect'], reason: 'toggle_off' as DenyReason },
    { action, name: "someone else's, editing rules on", resource: { created_by: 'n' }, event: { members_edit_others: true }, expect: [T, T, T] as Row['expect'] },
    { action, name: 'own, member entry off', resource: { created_by: 'm' }, event: { allow_member_expenses: false }, expect: [T, T, F] as Row['expect'], reason: 'toggle_off' as DenyReason },
    { action, name: 'no resource', expect: [T, T, T] as Row['expect'] },
    { action, name: 'completed', resource: { created_by: 'm' }, event: completed, expect: [F, F, F] as Row['expect'], reason: 'event_not_active' as DenyReason },
  ]),

  // ── settlements ──
  { action: 'settlement.create', name: 'to someone else', resource: { to_user: 'n' }, expect: [T, T, T] },
  { action: 'settlement.create', name: 'completed', resource: { to_user: 'n' }, event: completed, expect: [F, F, F], reason: 'event_not_active' },
  ...(['settlement.confirm', 'settlement.reject'] as Action[]).flatMap(action => [
    { action, name: 'member is recipient, owner is bystander', resource: { from_user: 'n', to_user: 'm', status: pending }, expect: [T, F, T] as Row['expect'], reason: 'not_a_party' as DenyReason },
    { action, name: 'owner is payer (cannot approve own payment)', resource: { from_user: 'o', to_user: 'm', status: pending }, expect: [F, F, T] as Row['expect'], reason: 'not_a_party' as DenyReason },
    { action, name: 'admin is recipient', resource: { from_user: 'n', to_user: 'a', status: pending }, expect: [T, T, F] as Row['expect'] },
    { action, name: 'payer cannot approve own', resource: { from_user: 'm', to_user: 'a', status: pending }, expect: [T, T, F] as Row['expect'], reason: 'not_a_party' as DenyReason },
    { action, name: 'already confirmed', resource: { from_user: 'n', to_user: 'm', status: 'confirmed' }, expect: [F, F, F] as Row['expect'], reason: 'wrong_state' as DenyReason },
    { action, name: 'cancelled', resource: { from_user: 'n', to_user: 'm', status: 'cancelled' }, expect: [F, F, F] as Row['expect'], reason: 'wrong_state' as DenyReason },
    { action, name: 'completed event', resource: { from_user: 'n', to_user: 'm', status: pending }, event: completed, expect: [F, F, F] as Row['expect'], reason: 'event_not_active' as DenyReason },
  ]),
  { action: 'settlement.cancel', name: 'member is payer', resource: { from_user: 'm', to_user: 'n', status: pending }, expect: [F, F, T], reason: 'not_a_party' },
  { action: 'settlement.cancel', name: 'member is recipient', resource: { from_user: 'n', to_user: 'm', status: pending }, expect: [F, F, T] },
  { action: 'settlement.cancel', name: 'admin is payer', resource: { from_user: 'a', to_user: 'n', status: pending }, expect: [F, T, F] },
  { action: 'settlement.cancel', name: 'owner is not a party', resource: { from_user: 'n', to_user: 'x', status: pending }, expect: [F, F, F], reason: 'not_a_party' },
  { action: 'settlement.cancel', name: 'already confirmed', resource: { from_user: 'm', to_user: 'n', status: 'confirmed' }, expect: [F, F, F], reason: 'wrong_state' },
  ...(['settlement.remind', 'settlement.request'] as Action[]).flatMap(action => [
    { action, name: 'target someone else', resource: { target_user: 'n' }, expect: [T, T, T] as Row['expect'] },
    { action, name: 'completed', resource: { target_user: 'n' }, event: completed, expect: [F, F, F] as Row['expect'], reason: 'event_not_active' as DenyReason },
  ]),

  // ── chat ──
  { action: 'chat.write', name: 'active', expect: [T, T, T] },
  { action: 'chat.write', name: 'completed', event: completed, expect: [F, F, F], reason: 'event_not_active' },
  { action: 'chat.write', name: 'archived', event: archived, expect: [F, F, F], reason: 'event_not_active' },
  { action: 'chat.delete_message', name: 'own message', resource: { sender_id: 'm' }, expect: [T, T, T] },
  { action: 'chat.delete_message', name: "someone else's message", resource: { sender_id: 'n' }, expect: [T, T, F], reason: 'role_required' },
  { action: 'chat.delete_message', name: 'system message', resource: { sender_id: null }, expect: [T, T, F], reason: 'role_required' },

  // ── files ──
  { action: 'file.upload', name: 'active', expect: [T, T, T] },
  { action: 'file.upload', name: 'completed', event: completed, expect: [F, F, F], reason: 'event_not_active' },
  { action: 'file.read', name: "file in this event", resource: { event_id: 'e1' }, expect: [T, T, T] },
  { action: 'file.read', name: "file in another event", resource: { event_id: 'e2' }, expect: [F, F, F], reason: 'invalid_target' },
  { action: 'file.read', name: 'completed event still readable', resource: { event_id: 'e1' }, event: completed, expect: [T, T, T] },

  // ── personal ──
  { action: 'notifications.edit', name: 'active', expect: [T, T, T] },
  { action: 'notifications.edit', name: 'archived', event: archived, expect: [T, T, T] },
];

const roles: EventRole[] = ['owner', 'admin', 'member'];

for (const row of rows) {
  test(`policy ${row.action}: ${row.name}`, () => {
    roles.forEach((role, i) => {
      const decision = authorize(ctxFor(role, row.event), row.action, row.resource as never);
      assert.equal(decision.ok, row.expect[i], `${role} -> expected ${row.expect[i] ? 'allow' : 'deny'}, got ${JSON.stringify(decision)}`);
      if (!decision.ok && row.reason) assert.equal(decision.reason, row.reason, `${role} deny reason`);
    });
  });
}

test('every action in the policy has at least one table row (no untested permission)', () => {
  const covered = new Set(rows.map(r => r.action));
  const missing = ALL_ACTIONS.filter(a => !covered.has(a));
  assert.deepEqual(missing, []);
});

test('member.remove / settlement.create deny acting on yourself', () => {
  assert.equal(authorize(ctxFor('owner'), 'member.remove', { user_id: 'o', role: 'member' }).ok, false);
  assert.equal(authorize(ctxFor('admin'), 'member.remove', { user_id: 'a', role: 'member' }).ok, false);
  assert.equal(authorize(ctxFor('owner'), 'member.promote', { user_id: 'o', role: 'member' }).ok, false);
  assert.equal(authorize(ctxFor('member'), 'settlement.create', { to_user: 'm' }).ok, false);
  assert.equal(authorize(ctxFor('member'), 'settlement.remind', { target_user: 'm' }).ok, false);
  assert.equal(authorize(ctxFor('member'), 'settlement.request', { target_user: 'm' }).ok, false);
});

test('listPermissions for each role on an active event', () => {
  const owner = listPermissions(ctxFor('owner'));
  const admin = listPermissions(ctxFor('admin'));
  const member = listPermissions(ctxFor('member'));

  for (const a of ['event.delete', 'event.complete', 'ownership.transfer', 'member.promote', 'member.demote', 'event.duplicate', 'event.archive'] as Action[]) {
    assert.ok(owner.includes(a), `owner ${a}`);
    assert.ok(!admin.includes(a), `admin !${a}`);
    assert.ok(!member.includes(a), `member !${a}`);
  }
  for (const a of ['event.edit', 'settings.edit', 'invite.regenerate', 'invite.revoke', 'member.remove', 'member.approve_request'] as Action[]) {
    assert.ok(owner.includes(a) && admin.includes(a) && !member.includes(a), a);
  }
  for (const a of ['expense.create', 'chat.write', 'settlement.create', 'event.view', 'file.upload'] as Action[]) {
    assert.ok(owner.includes(a) && admin.includes(a) && member.includes(a), a);
  }
  assert.ok(!owner.includes('member.leave') && admin.includes('member.leave') && member.includes('member.leave'));
  assert.ok(!member.includes('event.reopen'), 'reopen needs a completed event');
  assert.ok(listPermissions(ctxFor('owner', completed)).includes('event.reopen'));
  assert.ok(!listPermissions(ctxFor('owner', completed)).includes('expense.create'));
});

test('denial(): state problems are 409, permission problems are 403 forbidden_<action>', () => {
  const state = denial('expense.create', 'event_not_active');
  assert.equal(state.status, 409);
  assert.equal(state.code, 'event_not_active');
  assert.equal(denial('settlement.confirm', 'wrong_state').status, 409);
  const perm = denial('event.delete', 'role_required');
  assert.equal(perm.status, 403);
  assert.equal(perm.code, 'forbidden_event_delete');
  assert.equal(denial('member.remove', 'invalid_target').code, 'forbidden_member_remove');
});

test('assertCan throws the mapped HttpError and passes when allowed', () => {
  assert.doesNotThrow(() => assertCan(ctxFor('owner'), 'event.delete'));
  assert.throws(
    () => assertCan(ctxFor('member'), 'event.delete'),
    (e: any) => e.status === 403 && e.code === 'forbidden_event_delete',
  );
  assert.throws(
    () => assertCan(ctxFor('owner', completed), 'expense.create'),
    (e: any) => e.status === 409 && e.code === 'event_not_active',
  );
});
