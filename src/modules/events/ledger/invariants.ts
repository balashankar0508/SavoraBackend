import { LedgerError } from './errors';
import { MAX_PAISE } from './money';
import { LedgerExpense, LedgerSettlement, computeBalances } from './balances';

/**
 * Runs inside every money-writing transaction right before COMMIT. Any
 * violation throws a 500 so the transaction rolls back — a bug can never
 * persist an unbalanced ledger.
 */
export function assertLedgerConsistent(state: {
  memberIds: string[];
  expenses: LedgerExpense[];
  settlements: LedgerSettlement[];
}): void {
  const fail = (): never => {
    throw new LedgerError('ledger_inconsistent', 500);
  };

  for (const e of state.expenses) {
    if (e.status !== 'active') continue;
    if (!Number.isSafeInteger(e.amount_paise) || e.amount_paise <= 0 || e.amount_paise > MAX_PAISE) fail();
    if (!e.shares.length) fail();
    let sum = 0;
    for (const s of e.shares) {
      if (!Number.isSafeInteger(s.share_paise) || s.share_paise < 0) fail();
      sum += s.share_paise;
    }
    if (sum !== e.amount_paise) fail();
  }

  for (const s of state.settlements) {
    if (s.from_user === s.to_user) fail();
    if (!Number.isSafeInteger(s.amount_paise) || s.amount_paise <= 0 || s.amount_paise > MAX_PAISE) fail();
  }

  const balances = computeBalances(state.memberIds, state.expenses, state.settlements);
  let total = 0;
  for (const v of Object.values(balances)) {
    if (!Number.isSafeInteger(v)) fail();
    total += v;
  }
  if (total !== 0) fail();
}
