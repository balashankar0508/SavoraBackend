import { Balances } from './balances';

export interface SuggestedTransfer {
  from: string;
  to: string;
  amount_paise: number;
}

/**
 * Greedy minimum-cash-flow: repeatedly match the biggest debtor with the
 * biggest creditor. Produces at most (people with a non-zero balance - 1)
 * transfers and fully settles everyone. Ties are broken by user_id so the
 * output is deterministic (stable suggestions between refreshes).
 */
export function suggestTransfers(balances: Balances): SuggestedTransfer[] {
  const byAmountThenId = (a: [string, number], b: [string, number]) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

  const debtors = Object.entries(balances)
    .filter(([, v]) => v < 0)
    .map(([id, v]): [string, number] => [id, -v])
    .sort(byAmountThenId);
  const creditors = Object.entries(balances)
    .filter(([, v]) => v > 0)
    .sort(byAmountThenId);

  const transfers: SuggestedTransfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d][1], creditors[c][1]);
    transfers.push({ from: debtors[d][0], to: creditors[c][0], amount_paise: amount });
    debtors[d][1] -= amount;
    creditors[c][1] -= amount;
    if (debtors[d][1] === 0) d++;
    if (creditors[c][1] === 0) c++;
  }
  return transfers;
}
