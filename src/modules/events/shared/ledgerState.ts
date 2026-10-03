import { Queryable } from '../access/context';
import {
  Balances, LedgerExpense, LedgerSettlement, StatsExpense,
  computeBalances, suggestTransfers, SuggestedTransfer,
} from '../ledger';

export interface StateExpense extends LedgerExpense, StatsExpense {
  id: string;
  created_by: string;
}

export interface StateSettlement extends LedgerSettlement {
  id: string;
}

/** Everything the ledger needs, read inside the event lock for writes. */
export interface LedgerState {
  memberIds: string[];
  expenses: StateExpense[];
  settlements: StateSettlement[];
}

/** Active expenses (with their shares) and open/confirmed settlements. */
export async function loadLedgerState(db: Queryable, eventId: string): Promise<LedgerState> {
  const [members, expenses, shares, settlements] = await Promise.all([
    db.query("select user_id from event_members where event_id = $1 and status = 'active'", [eventId]),
    db.query(
      `select id, created_by, paid_by, amount_paise, category, expense_date::text as expense_date, status
         from event_expenses where event_id = $1 and status = 'active'`,
      [eventId],
    ),
    db.query(
      `select s.expense_id, s.user_id, s.share_paise
         from event_expense_shares s join event_expenses e on e.id = s.expense_id
        where e.event_id = $1 and e.status = 'active'`,
      [eventId],
    ),
    db.query(
      `select id, from_user, to_user, amount_paise, status from event_settlements
        where event_id = $1 and status in ('pending_confirmation', 'confirmed')`,
      [eventId],
    ),
  ]);

  const byExpense = new Map<string, { user_id: string; share_paise: number }[]>();
  for (const s of shares.rows) {
    const list = byExpense.get(s.expense_id) ?? [];
    list.push({ user_id: s.user_id, share_paise: s.share_paise });
    byExpense.set(s.expense_id, list);
  }

  return {
    memberIds: members.rows.map(r => r.user_id),
    expenses: expenses.rows.map(r => ({ ...r, shares: byExpense.get(r.id) ?? [] })),
    settlements: settlements.rows,
  };
}

export function balancesOf(state: LedgerState): Balances {
  return computeBalances(state.memberIds, state.expenses, state.settlements);
}

export function suggestionsOf(state: LedgerState): SuggestedTransfer[] {
  return suggestTransfers(balancesOf(state));
}

export async function loadNames(db: Queryable, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const { rows } = await db.query('select id, name from users where id = any($1::uuid[])', [[...new Set(userIds)]]);
  return new Map(rows.map(r => [r.id as string, r.name as string]));
}
