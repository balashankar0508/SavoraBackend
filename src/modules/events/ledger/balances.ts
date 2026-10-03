import { LedgerError } from './errors';

export interface LedgerExpense {
  paid_by: string;
  amount_paise: number;
  status: 'active' | 'voided';
  shares: { user_id: string; share_paise: number }[];
}

export interface LedgerSettlement {
  from_user: string;
  to_user: string;
  amount_paise: number;
  status: 'pending_confirmation' | 'confirmed' | 'rejected' | 'cancelled';
}

export type Balances = Record<string, number>;

/**
 * Net position per user, in paise. POSITIVE = the member is owed money,
 * NEGATIVE = the member owes money.
 *
 * Only active expenses and *confirmed* settlements count. Pending settlements
 * never move a balance. Users who appear in the ledger but are no longer
 * members (removed/left) are still included, so the books always balance.
 *
 * Invariant: the values always sum to 0 (see invariants.ts).
 */
export function computeBalances(
  memberIds: string[],
  expenses: LedgerExpense[],
  settlements: LedgerSettlement[],
): Balances {
  const result: Balances = Object.fromEntries(memberIds.map(id => [id, 0]));
  const add = (id: string, delta: number) => {
    result[id] = (result[id] ?? 0) + delta;
  };

  for (const e of expenses) {
    if (e.status !== 'active') continue;
    add(e.paid_by, e.amount_paise);
    for (const s of e.shares) add(s.user_id, -s.share_paise);
  }
  for (const s of settlements) {
    if (s.status !== 'confirmed') continue;
    add(s.from_user, s.amount_paise);
    add(s.to_user, -s.amount_paise);
  }
  return result;
}

/** Largest amount `from` may pay `to` right now: min(from's debt, to's credit). */
export function maxSettlement(balances: Balances, from: string, to: string): number {
  if (from === to) return 0;
  return Math.max(0, Math.min(-(balances[from] ?? 0), balances[to] ?? 0));
}

export function assertSettlementAllowed(
  balances: Balances,
  from: string,
  to: string,
  amount: number,
  errorCode = 'invalid_settlement',
): void {
  if (from === to || !Number.isSafeInteger(amount) || amount <= 0 || amount > maxSettlement(balances, from, to)) {
    throw new LedgerError(errorCode, errorCode === 'balance_changed' ? 409 : 400);
  }
}

export function isFullySettled(balances: Balances): boolean {
  return Object.values(balances).every(v => v === 0);
}
