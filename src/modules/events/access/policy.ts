import { Action, Decision, DenyReason, EventContext, ResourceFor, ResourceMap } from './types';

/**
 * THE permission matrix for the Events module (EVENTS_REBUILD_PLAN.md §4).
 * Pure functions, no I/O, so every row is unit-tested in policy.test.ts.
 *
 * Scope: identity, role, event status and event-setting toggles.
 * NOT here (they need ledger state read under the event lock, so services check them):
 *   - "balance must be 0" for removing a member / leaving / completing,
 *   - "amount <= what the payer owes" for settlements,
 *   - "1 reminder per pair per 24 h".
 *
 * Passing no resource asks "could this user EVER do this, for some resource?" —
 * used to build the `permissions` list the app uses to show or hide buttons.
 */

const ok: Decision = { ok: true };
const deny = (reason: DenyReason): Decision => ({ ok: false, reason });

type Rule<A extends Action> = (ctx: EventContext, resource?: ResourceFor<A>) => Decision;

const isOwner = (c: EventContext) => c.role === 'owner';
const isStaff = (c: EventContext) => c.role === 'owner' || c.role === 'admin';
const active = (c: EventContext): Decision => (c.event.status === 'active' ? ok : deny('event_not_active'));
const needOwner = (c: EventContext): Decision => (isOwner(c) ? ok : deny('role_required'));
const needStaff = (c: EventContext): Decision => (isStaff(c) ? ok : deny('role_required'));
const all = (...checks: Decision[]): Decision => checks.find(d => !d.ok) ?? ok;

const rules: { [A in Action]: Rule<A> } = {
  // ── read ──
  'event.view': () => ok,
  'chat.read': () => ok,
  'analytics.view': () => ok,

  // ── event ──
  'event.edit': c => all(needStaff(c), active(c)),
  'settings.edit': c => all(needStaff(c), active(c)),
  'event.complete': c => all(needOwner(c), active(c)),
  'event.reopen': c => all(needOwner(c), c.event.status === 'completed' ? ok : deny('event_not_completed')),
  'event.archive': c => all(needOwner(c), c.event.status === 'archived' ? deny('event_archived') : ok),
  'event.delete': c => needOwner(c),
  'event.duplicate': c => needOwner(c),
  'ownership.transfer': c => all(needOwner(c), c.event.status === 'archived' ? deny('event_archived') : ok),

  // ── invitations ──
  'invite.view_code': c =>
    all(active(c), isStaff(c) || c.event.join_policy === 'code' ? ok : deny('role_required')),
  'invite.regenerate': c => all(needStaff(c), active(c)),
  'invite.revoke': c => all(needStaff(c), active(c)),
  'invite.email': c => all(needStaff(c), active(c)),
  'invite.cancel': c => all(needStaff(c), active(c)),

  // ── members ──
  'member.approve_request': c => all(needStaff(c), active(c)),
  'member.remove': (c, target) => {
    const base = all(needStaff(c), active(c));
    if (!base.ok || !target) return base;
    if (target.user_id === c.userId) return deny('invalid_target'); // use "leave"
    if (target.role === 'owner') return deny('invalid_target');
    if (c.role === 'admin' && target.role !== 'member') return deny('role_required');
    return ok;
  },
  'member.promote': (c, target) => {
    const base = all(needOwner(c), active(c));
    if (!base.ok || !target) return base;
    return target.user_id !== c.userId && target.role === 'member' ? ok : deny('invalid_target');
  },
  'member.demote': (c, target) => {
    const base = all(needOwner(c), active(c));
    if (!base.ok || !target) return base;
    return target.role === 'admin' ? ok : deny('invalid_target');
  },
  'member.leave': c => (isOwner(c) ? deny('role_required') : ok), // owner must transfer first

  // ── expenses ──
  'expense.create': c =>
    all(active(c), isStaff(c) || c.event.allow_member_expenses ? ok : deny('toggle_off')),
  // Members may change expenses only while "Allow member expense entry" is on:
  // their own, or anyone's when "Member editing rules" is also on.
  'expense.edit': (c, x) => memberExpenseRule(c, x),
  'expense.void': (c, x) => memberExpenseRule(c, x),

  // ── settlements ──
  'settlement.create': (c, s) => {
    const base = active(c);
    if (!base.ok || !s) return base;
    return s.to_user !== c.userId ? ok : deny('invalid_target');
  },
  'settlement.confirm': (c, s) => reviewRule(c, s),
  'settlement.reject': (c, s) => reviewRule(c, s),
  'settlement.cancel': (c, s) => {
    const base = active(c);
    if (!base.ok || !s) return base;
    if (s.status !== 'pending_confirmation') return deny('wrong_state');
    return s.from_user === c.userId || s.to_user === c.userId ? ok : deny('not_a_party');
  },
  'settlement.remind': (c, r) => remindRule(c, r),
  'settlement.request': (c, r) => remindRule(c, r),

  // ── chat ──
  'chat.write': c => active(c),
  'chat.delete_message': (c, m) => {
    if (isStaff(c) || !m) return ok;
    return m.sender_id === c.userId ? ok : deny('role_required');
  },

  // ── files ──
  'file.upload': c => active(c),
  'file.read': (c, f) => (!f || f.event_id === c.event.id ? ok : deny('invalid_target')),

  // ── personal ──
  'notifications.edit': () => ok,
};

function memberExpenseRule(c: EventContext, x?: ResourceMap['expense.edit']): Decision {
  const base = active(c);
  if (!base.ok || isStaff(c)) return base;
  if (!c.event.allow_member_expenses) return deny('toggle_off');
  if (!x) return ok;
  return x.created_by === c.userId || c.event.members_edit_others ? ok : deny('toggle_off');
}

function reviewRule(c: EventContext, s?: ResourceMap['settlement.confirm']): Decision {
  const base = active(c);
  if (!base.ok || !s) return base;
  if (s.status !== 'pending_confirmation') return deny('wrong_state');
  if (s.from_user === c.userId) return deny('not_a_party'); // never approve your own payment
  return s.to_user === c.userId || isOwner(c) ? ok : deny('not_a_party');
}

function remindRule(c: EventContext, r?: ResourceMap['settlement.remind']): Decision {
  const base = active(c);
  if (!base.ok || !r) return base;
  return r.target_user !== c.userId ? ok : deny('invalid_target');
}

export function authorize<A extends Action>(ctx: EventContext, action: A, resource?: ResourceFor<A>): Decision {
  return (rules[action] as Rule<A>)(ctx, resource);
}

export const ALL_ACTIONS = Object.keys(rules) as Action[];

/** Actions this user could ever perform on this event (resource-independent view). */
export function listPermissions(ctx: EventContext): Action[] {
  return ALL_ACTIONS.filter(a => authorize(ctx, a).ok);
}
