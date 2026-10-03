import { formatINR } from './money';

export type StatsWindow = 'all' | 'week' | 'month';

export interface StatsExpense {
  paid_by: string;
  amount_paise: number;
  category: string;
  expense_date: string; // YYYY-MM-DD
  status: 'active' | 'voided';
  shares: { user_id: string; share_paise: number }[];
}

export interface EventStats {
  window: StatsWindow;
  range: { from: string | null; to: string | null };
  /** Spend inside the window. */
  spent_paise: number;
  expense_count: number;
  /** Spend in the equally long window just before this one (null for 'all'). */
  previous_spent_paise: number | null;
  /** Change vs the previous window, whole percent; null when there is nothing to compare. */
  change_pct: number | null;
  /** All-time spend: budget figures always use this, whatever the window. */
  total_spent_paise: number;
  budget_paise: number | null;
  /** Negative when over budget; null when the event has no budget. */
  remaining_paise: number | null;
  budget_used_pct: number | null;
  per_person_paise: number;
  categories: { category: string; total_paise: number; pct: number }[];
  top_category: { category: string; total_paise: number; pct: number } | null;
  members: { user_id: string; paid_paise: number; share_paise: number; paid_pct: number }[];
  trend: { date: string; total_paise: number }[];
  insights: string[];
}

const DAY_MS = 86_400_000;
const parseDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : 0);

/** Calendar window bounds. Week = Monday..Sunday, month = calendar month. `today` is YYYY-MM-DD. */
export function windowRange(window: StatsWindow, today: string): { from: string | null; to: string | null } {
  if (window === 'all') return { from: null, to: null };
  const t = parseDay(today);
  if (window === 'week') {
    const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
    const start = t - dow * DAY_MS;
    return { from: fmtDay(start), to: fmtDay(start + 6 * DAY_MS) };
  }
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  return { from: fmtDay(start), to: fmtDay(end) };
}

/** The window immediately before `window`: last week, or last calendar month. */
export function previousWindowRange(window: StatsWindow, today: string): { from: string; to: string } | null {
  if (window === 'all') return null;
  const current = windowRange(window, today);
  const from = parseDay(current.from!);
  if (window === 'week') return { from: fmtDay(from - 7 * DAY_MS), to: fmtDay(from - DAY_MS) };
  return windowRange('month', fmtDay(from - DAY_MS)) as { from: string; to: string };
}

export function computeEventStats(input: {
  budget_paise: number | null;
  memberIds: string[];
  expenses: StatsExpense[];
  window: StatsWindow;
  today: string;
}): EventStats {
  const active = input.expenses.filter(e => e.status === 'active');
  const range = windowRange(input.window, input.today);
  const inWindow = active.filter(
    e => (!range.from || e.expense_date >= range.from) && (!range.to || e.expense_date <= range.to),
  );

  const previousRange = previousWindowRange(input.window, input.today);
  const previousSpent = previousRange
    ? active.filter(e => e.expense_date >= previousRange.from && e.expense_date <= previousRange.to).reduce((n, e) => n + e.amount_paise, 0)
    : null;

  const total = active.reduce((n, e) => n + e.amount_paise, 0);
  const spent = inWindow.reduce((n, e) => n + e.amount_paise, 0);
  const budget = input.budget_paise;

  const catTotals = new Map<string, number>();
  for (const e of inWindow) catTotals.set(e.category, (catTotals.get(e.category) ?? 0) + e.amount_paise);
  const categories = [...catTotals.entries()]
    .map(([category, total_paise]) => ({ category, total_paise, pct: pct(total_paise, spent) }))
    .sort((a, b) => b.total_paise - a.total_paise || (a.category < b.category ? -1 : 1));

  const paid = new Map<string, number>(input.memberIds.map(id => [id, 0]));
  const share = new Map<string, number>(input.memberIds.map(id => [id, 0]));
  for (const e of inWindow) {
    paid.set(e.paid_by, (paid.get(e.paid_by) ?? 0) + e.amount_paise);
    for (const s of e.shares) share.set(s.user_id, (share.get(s.user_id) ?? 0) + s.share_paise);
  }
  const members = [...new Set([...paid.keys(), ...share.keys()])]
    .map(user_id => ({
      user_id,
      paid_paise: paid.get(user_id) ?? 0,
      share_paise: share.get(user_id) ?? 0,
      paid_pct: pct(paid.get(user_id) ?? 0, spent),
    }))
    .sort((a, b) => b.paid_paise - a.paid_paise || (a.user_id < b.user_id ? -1 : 1));

  const byDay = new Map<string, number>();
  for (const e of inWindow) byDay.set(e.expense_date, (byDay.get(e.expense_date) ?? 0) + e.amount_paise);
  let trend: { date: string; total_paise: number }[];
  if (range.from && range.to) {
    trend = [];
    for (let t = parseDay(range.from); t <= parseDay(range.to); t += DAY_MS) {
      const date = fmtDay(t);
      trend.push({ date, total_paise: byDay.get(date) ?? 0 });
    }
  } else {
    trend = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, total_paise]) => ({ date, total_paise }));
  }

  const usedPct = budget ? pct(total, budget) : null;
  const top = categories[0] ?? null;
  const insights: string[] = [];
  if (budget && usedPct !== null) {
    insights.push(
      total > budget
        ? `Spending is ${formatINR(total - budget)} over the event budget.`
        : `You have used ${usedPct}% of the event budget.`,
    );
  }
  if (top) insights.push(`${top.category} is currently the largest expense category.`);

  return {
    window: input.window,
    range,
    spent_paise: spent,
    expense_count: inWindow.length,
    previous_spent_paise: previousSpent,
    change_pct: previousSpent ? Math.round(((spent - previousSpent) * 100) / previousSpent) : null,
    total_spent_paise: total,
    budget_paise: budget,
    remaining_paise: budget === null ? null : budget - total,
    budget_used_pct: usedPct,
    per_person_paise: input.memberIds.length ? Math.round(spent / input.memberIds.length) : 0,
    categories,
    top_category: top,
    members,
    trend,
    insights,
  };
}
