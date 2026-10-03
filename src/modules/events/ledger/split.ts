import { LedgerError } from './errors';
import { assertPaise } from './money';

export type SplitMode = 'equal' | 'exact' | 'percentage' | 'shares';

/** `value` meaning depends on mode: ignored for equal, paise for exact,
 * basis points (10000 = 100%) for percentage, positive integer weight for shares. */
export interface SplitInput {
  user_id: string;
  value: number;
}

export interface SplitShare {
  user_id: string;
  share_paise: number;
  input_value: number | null;
}

/**
 * Splits `amount` (paise) between members. Guarantees:
 *  - shares sum to exactly `amount` (largest-remainder allocation),
 *  - the result is deterministic: remainder ties are broken by user_id
 *    (plain code-unit comparison), never by input order,
 *  - output keeps the caller's input order.
 *
 * NOTE: the mobile app carries a copy of this algorithm for the live preview.
 * Both are verified against __fixtures__/split-vectors.json — keep them in sync.
 */
export function splitExpense(amount: number, mode: SplitMode, input: SplitInput[]): SplitShare[] {
  assertPaise(amount);

  if (!input.length || new Set(input.map(s => s.user_id)).size !== input.length) {
    throw new LedgerError('invalid_split_members');
  }

  if (mode === 'exact') {
    const sum = input.reduce((n, s) => n + s.value, 0);
    if (input.some(s => !Number.isSafeInteger(s.value) || s.value < 0) || sum !== amount) {
      throw new LedgerError('splits_must_match_amount');
    }
    return input.map(s => ({ user_id: s.user_id, share_paise: s.value, input_value: s.value }));
  }

  const weights = input.map(s => (mode === 'equal' ? 1 : s.value));
  if (mode !== 'equal' && weights.some(w => !Number.isSafeInteger(w))) {
    throw new LedgerError(mode === 'percentage' ? 'percentages_must_total_100' : 'shares_must_be_positive_integers');
  }
  const total = weights.reduce((a, b) => a + b, 0);

  if (mode === 'shares' && (total <= 0 || weights.some(w => w <= 0))) {
    throw new LedgerError('shares_must_be_positive_integers');
  }
  if (mode === 'percentage' && (total !== 10000 || weights.some(w => w < 0))) {
    throw new LedgerError('percentages_must_total_100');
  }

  // amount (<=1e9) * weight (<=1e10) can exceed 2^53, so multiply in BigInt.
  const bigAmount = BigInt(amount);
  const bigTotal = BigInt(total);
  const products = weights.map(w => bigAmount * BigInt(w));
  const shares = products.map(p => Number(p / bigTotal));
  let remaining = amount - shares.reduce((a, b) => a + b, 0);

  const order = products
    .map((p, i) => ({ i, remainder: p % bigTotal }))
    .sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      const ua = input[a.i].user_id;
      const ub = input[b.i].user_id;
      return ua < ub ? -1 : ua > ub ? 1 : 0;
    });

  for (const item of order) {
    if (remaining <= 0) break;
    shares[item.i] += 1;
    remaining -= 1;
  }

  return input.map((s, i) => ({
    user_id: s.user_id,
    share_paise: shares[i],
    input_value: mode === 'equal' ? null : s.value,
  }));
}
