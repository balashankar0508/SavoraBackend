import { z } from 'zod';
import { pool } from '../../../db/pool';
import { HttpError } from '../../../lib/httpError';
import { EventContext } from '../access/types';
import { StatsWindow, computeEventStats, formatINR, isFullySettled } from '../ledger';
import { balancesOf, loadLedgerState, loadNames } from '../shared/ledgerState';
import { dateStr } from '../shared/schemas';
import { settlementsCsv } from './reports.csv';
import { ReceiptData, ReportData, renderEventReport, renderReceipt } from './reports.pdf';

export const analyticsQuerySchema = z.object({
  window: z.enum(['all', 'week', 'month']).default('all'),
  // The app sends its own local date so "this week" matches the user's calendar, not the server's.
  today: dateStr.optional(),
});

const serverToday = () => new Date().toISOString().slice(0, 10);

// ── analytics screen ────────────────────────────────────────────

export async function getAnalytics(ctx: EventContext, query: z.infer<typeof analyticsQuerySchema>) {
  const state = await loadLedgerState(pool, ctx.event.id);
  const stats = computeEventStats({
    budget_paise: ctx.event.budget_paise ?? null, memberIds: state.memberIds, expenses: state.expenses,
    window: query.window as StatsWindow, today: query.today ?? serverToday(),
  });
  const names = await loadNames(pool, stats.members.map(m => m.user_id));
  return {
    ...stats,
    members: stats.members.map(m => ({ ...m, name: names.get(m.user_id) ?? 'Member', is_me: m.user_id === ctx.userId })),
    generated_at: new Date().toISOString(),
  };
}

// ── summary screen ──────────────────────────────────────────────

export async function getSummary(ctx: EventContext) {
  const eventId = ctx.event.id;
  const state = await loadLedgerState(pool, eventId);
  const balances = balancesOf(state);
  const stats = computeEventStats({
    budget_paise: ctx.event.budget_paise ?? null, memberIds: state.memberIds, expenses: state.expenses, window: 'all', today: serverToday(),
  });
  const names = await loadNames(pool, Object.keys(balances));
  const pending = state.settlements.filter(s => s.status === 'pending_confirmation');

  const finalBalances = Object.entries(balances)
    .map(([user_id, balance_paise]) => ({
      user_id, name: names.get(user_id) ?? 'Member', balance_paise, is_me: user_id === ctx.userId,
      label: balance_paise === 0 ? 'settled' : balance_paise > 0 ? 'to_receive' : 'to_pay',
    }))
    .sort((a, b) => b.balance_paise - a.balance_paise || (a.user_id < b.user_id ? -1 : 1));

  const toReceive = finalBalances.reduce((n, b) => n + Math.max(0, b.balance_paise), 0);
  return {
    event: {
      id: eventId, title: ctx.event.title, event_type: ctx.event.event_type, start_date: ctx.event.start_date,
      end_date: ctx.event.end_date, location: ctx.event.location ?? null, status: ctx.event.status,
    },
    totals: {
      budget_paise: stats.budget_paise, spent_paise: stats.total_spent_paise, remaining_paise: stats.remaining_paise,
      budget_used_pct: stats.budget_used_pct, member_count: state.memberIds.length, expense_count: stats.expense_count,
    },
    final_balances: finalBalances,
    categories: stats.categories,
    settlement_status: {
      all_settled: isFullySettled(balances) && pending.length === 0,
      members_to_settle: finalBalances.filter(b => b.balance_paise < 0).length,
      pending_inbound_paise: toReceive,
      pending_confirmations: pending.length,
    },
    deep_link: `spenxo://event/${eventId}`,
    // Plain text for the share sheet. It carries amounts but no payment details.
    share_text: [
      `${ctx.event.title} on Spenxo`,
      stats.budget_paise === null ? null : `Budget: ${formatINR(stats.budget_paise)}`,
      `Spent: ${formatINR(stats.total_spent_paise)}`,
      `${state.memberIds.length} members · ${stats.expense_count} expenses`,
    ].filter(Boolean).join('\n'),
    calculated_at: new Date().toISOString(),
  };
}

// ── PDF / CSV downloads ─────────────────────────────────────────

/** "Goa Trip 2026!" -> "goa-trip-2026", safe for a download file name. */
export function fileSlug(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
}

async function loadReportData(ctx: EventContext): Promise<ReportData> {
  const eventId = ctx.event.id;
  const state = await loadLedgerState(pool, eventId);
  const balances = balancesOf(state);
  const stats = computeEventStats({
    budget_paise: ctx.event.budget_paise ?? null, memberIds: state.memberIds, expenses: state.expenses, window: 'all', today: serverToday(),
  });
  const [names, expenses, settlements] = await Promise.all([
    loadNames(pool, Object.keys(balances)),
    pool.query(
      `select e.expense_date::text as date, e.title, e.category, u.name as paid_by_name, e.amount_paise
         from event_expenses e join users u on u.id = e.paid_by
        where e.event_id = $1 and e.status = 'active'
        order by e.expense_date, e.created_at`,
      [eventId],
    ),
    pool.query(
      `select s.reference_code, s.paid_marked_at as date, fu.name as from_name, tu.name as to_name, s.amount_paise, s.method, s.status
         from event_settlements s join users fu on fu.id = s.from_user join users tu on tu.id = s.to_user
        where s.event_id = $1 and s.status in ('confirmed', 'pending_confirmation')
        order by s.paid_marked_at`,
      [eventId],
    ),
  ]);

  return {
    generated_at: new Date(),
    event: {
      title: ctx.event.title, event_type: ctx.event.event_type, start_date: ctx.event.start_date, end_date: ctx.event.end_date,
      location: ctx.event.location ?? null, description: ctx.event.description ?? null, status: ctx.event.status, budget_paise: ctx.event.budget_paise ?? null,
    },
    totals: {
      spent_paise: stats.total_spent_paise, remaining_paise: stats.remaining_paise, budget_used_pct: stats.budget_used_pct,
      member_count: state.memberIds.length, expense_count: stats.expense_count,
    },
    balances: Object.entries(balances)
      .map(([id, balance_paise]) => ({ name: names.get(id) ?? 'Member', balance_paise }))
      .sort((a, b) => b.balance_paise - a.balance_paise || (a.name < b.name ? -1 : 1)),
    categories: stats.categories,
    expenses: expenses.rows,
    settlements: settlements.rows,
  };
}

export async function buildReportPdf(ctx: EventContext) {
  return { filename: `spenxo-${fileSlug(ctx.event.title)}-report.pdf`, body: await renderEventReport(await loadReportData(ctx)) };
}

export async function buildSettlementsCsv(ctx: EventContext) {
  const { rows } = await pool.query(
    `select s.reference_code, s.paid_marked_at, fu.name as from_name, tu.name as to_name, s.amount_paise, s.method,
            s.upi_app, s.utr, s.status, s.confirmed_at
       from event_settlements s join users fu on fu.id = s.from_user join users tu on tu.id = s.to_user
      where s.event_id = $1 order by s.paid_marked_at desc, s.id`,
    [ctx.event.id],
  );
  return { filename: `spenxo-${fileSlug(ctx.event.title)}-settlements.csv`, body: settlementsCsv(rows) };
}

/** A receipt is for the two people in the payment and the admins; anyone else gets a plain 404. */
export async function buildReceiptPdf(ctx: EventContext, settlementId: string) {
  const { rows } = await pool.query(
    `select s.reference_code, s.status, s.from_user, s.to_user, fu.name as from_name, tu.name as to_name, s.amount_paise,
            s.method, s.upi_app, s.utr, s.paid_marked_at, s.confirmed_at
       from event_settlements s join users fu on fu.id = s.from_user join users tu on tu.id = s.to_user
      where s.id = $1 and s.event_id = $2`,
    [settlementId, ctx.event.id],
  );
  const s = rows[0];
  const staff = ctx.role === 'owner' || ctx.role === 'admin';
  if (!s || !(staff || s.from_user === ctx.userId || s.to_user === ctx.userId)) throw new HttpError(404, 'settlement_not_found');

  const data: ReceiptData = {
    generated_at: new Date(), event_title: ctx.event.title, reference_code: s.reference_code, status: s.status,
    from_name: s.from_user === ctx.userId ? 'You' : s.from_name, to_name: s.to_user === ctx.userId ? 'You' : s.to_name,
    amount_paise: s.amount_paise, method: s.method, upi_app: s.upi_app, utr: s.utr,
    paid_marked_at: s.paid_marked_at, confirmed_at: s.confirmed_at,
  };
  return { filename: `spenxo-receipt-${s.reference_code}.pdf`, body: await renderReceipt(data) };
}
