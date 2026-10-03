export type EventRole = 'owner' | 'admin' | 'member';
export type EventStatus = 'active' | 'completed' | 'archived';
export type JoinPolicy = 'admins_only' | 'code' | 'code_approval';

/** The columns the policy reads. The loaded row carries every other `events` column too. */
export interface PolicyEvent {
  id: string;
  owner_id: string;
  status: EventStatus;
  join_policy: JoinPolicy;
  allow_member_expenses: boolean;
  members_edit_others: boolean;
}

export type EventRow = PolicyEvent & Record<string, any>;

/** Who is acting, on which event, in what role. Role comes from an ACTIVE membership only. */
export interface EventContext {
  userId: string;
  role: EventRole;
  event: EventRow;
}

/** Every permission check in the events module goes through one of these. */
export type Action =
  | 'event.view' | 'chat.read' | 'analytics.view'
  | 'event.edit' | 'settings.edit'
  | 'event.complete' | 'event.reopen' | 'event.archive' | 'event.delete' | 'event.duplicate'
  | 'ownership.transfer'
  | 'invite.view_code' | 'invite.regenerate' | 'invite.revoke' | 'invite.email' | 'invite.cancel'
  | 'member.approve_request' | 'member.remove' | 'member.promote' | 'member.demote' | 'member.leave'
  | 'expense.create' | 'expense.edit' | 'expense.void'
  | 'settlement.create' | 'settlement.confirm' | 'settlement.reject' | 'settlement.cancel'
  | 'settlement.remind' | 'settlement.request'
  | 'chat.write' | 'chat.delete_message'
  | 'file.upload' | 'file.read'
  | 'notifications.edit';

/** Facts about the thing being acted on, for actions that depend on it. */
export interface ResourceMap {
  'expense.edit': { created_by: string };
  'expense.void': { created_by: string };
  'member.remove': { user_id: string; role: EventRole };
  'member.promote': { user_id: string; role: EventRole };
  'member.demote': { user_id: string; role: EventRole };
  'settlement.create': { to_user: string };
  'settlement.confirm': { from_user: string; to_user: string; status: string };
  'settlement.reject': { from_user: string; to_user: string; status: string };
  'settlement.cancel': { from_user: string; to_user: string; status: string };
  'settlement.remind': { target_user: string };
  'settlement.request': { target_user: string };
  'chat.delete_message': { sender_id: string | null };
  'file.read': { event_id: string };
}

export type ResourceFor<A extends Action> = A extends keyof ResourceMap ? ResourceMap[A] : undefined;

export type DenyReason =
  | 'event_not_active'
  | 'event_not_completed'
  | 'event_archived'
  | 'role_required'
  | 'toggle_off'
  | 'not_a_party'
  | 'invalid_target'
  | 'wrong_state';

export type Decision = { ok: true } | { ok: false; reason: DenyReason };
