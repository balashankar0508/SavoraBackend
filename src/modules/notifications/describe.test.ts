import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEvent, Facts, PREF_DEFAULTS } from './describe';
import { DomainEvent } from '../events/shared/domainEvents';

const facts: Facts = { eventTitle: 'Birthday Party', actorName: 'Priya', names: { u1: 'MST', u2: 'Arun', u3: 'Priya' } };
const base = { eventId: 'e1', actorId: 'u3' };
const one = (e: DomainEvent, f = facts) => { const out = describeEvent(e, f); assert.equal(out.length, 1); return out[0]; };

test('expense notifications carry the amount and open the expenses list', () => {
  const p = one({ type: 'expense.added', ...base, expenseId: 'x1', title: 'Cake', amountPaise: 200000 });
  assert.equal(p.payload.title, 'Birthday Party');
  assert.equal(p.payload.body, 'Priya added Cake — ₹2,000.00');
  assert.deepEqual(p.audience, { kind: 'members_except_actor' });
  assert.equal(p.category, 'expenses');
  assert.deepEqual(p.payload.data, { route: 'expenses', eventId: 'e1', expenseId: 'x1' });
  assert.match(one({ type: 'expense.updated', ...base, expenseId: 'x1', title: 'Cake', amountPaise: 1 }).payload.body, /updated Cake/);
  assert.match(one({ type: 'expense.voided', ...base, expenseId: 'x1', title: 'Cake', amountPaise: 100 }).payload.body, /removed Cake \(₹1\.00\)/);
});

test('member activity obeys the "members" switch, but join requests always reach admins', () => {
  const joined = one({ type: 'member.joined', ...base, userId: 'u1' });
  assert.equal(joined.category, 'members');
  assert.equal(joined.payload.body, 'MST joined the event');
  assert.equal(one({ type: 'member.left', ...base, userId: 'u1' }).payload.body, 'MST left the event');

  const requested = one({ type: 'member.requested', ...base, userId: 'u1' });
  assert.deepEqual(requested.audience, { kind: 'staff_except_actor' });
  assert.equal(requested.category, null, 'an action item is never muted by the activity switch');
  assert.equal(requested.payload.data.route, 'members');
});

test('direct outcomes go only to the person concerned, and always', () => {
  for (const type of ['member.approved', 'member.rejected', 'member.removed'] as const) {
    const p = one({ type, ...base, userId: 'u1' });
    assert.deepEqual(p.audience, { kind: 'users', userIds: ['u1'] }, type);
    assert.equal(p.category, null, type);
  }
  assert.equal(one({ type: 'member.approved', ...base, userId: 'u1' }).payload.data.route, 'event');
  assert.equal(one({ type: 'member.removed', ...base, userId: 'u1' }).payload.data.route, 'events', 'the event is no longer reachable');
});

test('settlement notifications go to the right party and name the right person', () => {
  const s = { eventId: 'e1', settlementId: 's1', fromUser: 'u1', toUser: 'u2', amountPaise: 50000 };
  const created = one({ type: 'settlement.created', actorId: 'u1', ...s });
  assert.deepEqual(created.audience, { kind: 'users', userIds: ['u2'] }, 'the recipient is asked to confirm');
  assert.equal(created.payload.body, 'MST marked ₹500.00 as paid. Confirm once you receive it.');
  assert.equal(created.category, 'settlements');
  assert.equal(created.payload.data.settlementId, 's1');

  const confirmed = one({ type: 'settlement.confirmed', actorId: 'u2', ...s });
  assert.deepEqual(confirmed.audience, { kind: 'users', userIds: ['u1'] });
  assert.equal(confirmed.payload.body, 'Arun confirmed your ₹500.00 payment.');

  const rejected = one({ type: 'settlement.rejected', actorId: 'u2', ...s }, { ...facts, actorName: 'Arun' });
  assert.deepEqual(rejected.audience, { kind: 'users', userIds: ['u1'] });
  assert.match(rejected.payload.body, /Arun could not confirm your ₹500\.00 payment/);

  assert.deepEqual(one({ type: 'settlement.cancelled', actorId: 'u1', ...s }).audience, { kind: 'users', userIds: ['u2'] }, 'payer cancels -> recipient told');
  assert.deepEqual(one({ type: 'settlement.cancelled', actorId: 'u2', ...s }).audience, { kind: 'users', userIds: ['u1'] }, 'recipient cancels -> payer told');
});

test('chat pushes never include the message text and collapse into one notification per event', () => {
  const p = one({ type: 'chat.message', ...base, messageId: 'm1' });
  assert.equal(p.payload.body, 'Priya sent a message');
  assert.equal(p.payload.tag, 'chat-e1');
  assert.equal(p.category, 'chat');
  assert.equal(p.payload.data.route, 'chat');
  assert.ok(!JSON.stringify(p).includes('m1'), 'not even the message id');
});

test('reminders and requests go to the debtor regardless of switches', () => {
  const remind = one({ type: 'reminder.sent', ...base, targetUser: 'u1', kind: 'remind', amountPaise: 10000 });
  assert.deepEqual(remind.audience, { kind: 'users', userIds: ['u1'] });
  assert.equal(remind.category, null);
  assert.equal(remind.payload.title, 'Payment reminder');
  assert.equal(remind.payload.body, 'Priya reminded you to settle ₹100.00 for Birthday Party.');
  const request = one({ type: 'reminder.sent', ...base, targetUser: 'u1', kind: 'request', amountPaise: 10000 });
  assert.equal(request.payload.title, 'Payment request');
  assert.equal(request.payload.data.route, 'balances');
});

test('event lifecycle: completion/reopen to members, deletion to everyone but the owner, nothing for create/archive', () => {
  assert.equal(one({ type: 'event.completed', ...base }).category, 'settlements');
  assert.equal(one({ type: 'event.reopened', ...base }).payload.body, 'The event was reopened.');
  const deleted = one({ type: 'event.deleted', ...base, title: 'Old Trip', memberIds: ['u1', 'u2', 'u3'] });
  assert.deepEqual(deleted.audience, { kind: 'users', userIds: ['u1', 'u2'] });
  assert.equal(deleted.payload.title, 'Old Trip');
  assert.equal(deleted.payload.data.route, 'events');
  assert.deepEqual(describeEvent({ type: 'event.created', ...base }, facts), []);
  assert.deepEqual(describeEvent({ type: 'event.archived', ...base }, facts), []);
});

test('push data values are all strings (an FCM requirement) and defaults match the design', () => {
  const events: DomainEvent[] = [
    { type: 'expense.added', ...base, expenseId: 'x', title: 'A', amountPaise: 1 },
    { type: 'settlement.created', actorId: 'u1', eventId: 'e1', settlementId: 's', fromUser: 'u1', toUser: 'u2', amountPaise: 1 },
    { type: 'chat.message', ...base, messageId: 'm' },
  ];
  for (const e of events) for (const p of describeEvent(e, facts)) {
    for (const v of Object.values(p.payload.data)) assert.equal(typeof v, 'string');
  }
  assert.deepEqual(PREF_DEFAULTS, { expenses: true, members: false, settlements: true, chat: true });
});
