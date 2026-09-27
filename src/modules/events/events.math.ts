import { HttpError } from "../../lib/httpError";
export type Split = { user_id: string; value: number };
export function splitExpense(
  amount: number,
  mode: "equal" | "percentage" | "custom" | "exact" | "shares",
  input: Split[]
) {
  if (
    !input.length ||
    new Set(input.map((s) => s.user_id)).size !== input.length
  )
    throw new HttpError(400, "invalid_split_members");
  if (mode === "custom" || mode === "exact") {
    if (
      input.some((s) => !Number.isSafeInteger(s.value) || s.value < 0) ||
      input.reduce((n, s) => n + s.value, 0) !== amount
    )
      throw new HttpError(400, "splits_must_match_amount");
    return input.map((s) => ({ user_id: s.user_id, amount_paise: s.value }));
  }
  const weights = input.map((s) => (mode === "equal" ? 1 : s.value));
  const total = weights.reduce((a, b) => a + b, 0);
  if (mode === "shares" && (total <= 0 || weights.some((v) => !Number.isInteger(v) || v <= 0)))
    throw new HttpError(400, "shares_must_be_positive_integers");
  if (
    mode === "percentage" &&
    (total !== 10000 || weights.some((v) => !Number.isInteger(v) || v < 0))
  )
    throw new HttpError(400, "percentages_must_total_100");
  const amounts = weights.map((w) => Math.floor((amount * w) / total));
  let remaining = amount - amounts.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, remainder: (amount * w) % total }))
    .sort(
      (a, b) =>
        b.remainder - a.remainder ||
        input[a.i].user_id.localeCompare(input[b.i].user_id)
    );
  for (const item of order) {
    if (remaining-- <= 0) break;
    amounts[item.i]++;
  }
  return input.map((s, i) => ({
    user_id: s.user_id,
    amount_paise: amounts[i],
  }));
}
export function balances(
  members: string[],
  expenses: any[],
  settlements: any[]
) {
  const result: Record<string, number> = Object.fromEntries(
    members.map((id) => [id, 0])
  );
  for (const e of expenses) {
    result[e.paid_by] += e.amount_paise;
    for (const s of e.splits) result[s.user_id] -= s.amount_paise;
  }
  for (const s of settlements.filter((s) => s.confirmed)) {
    result[s.from_user] += s.amount_paise;
    result[s.to_user] -= s.amount_paise;
  }
  return result;
}
