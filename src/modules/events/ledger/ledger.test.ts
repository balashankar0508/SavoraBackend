import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  splitExpense, SplitMode, SplitInput,
  computeBalances, maxSettlement, assertSettlementAllowed, isFullySettled,
  suggestTransfers, assertLedgerConsistent, computeEventStats, windowRange, previousWindowRange, computePairwise,
  parseRupees, formatINR, assertPaise, LedgerError,
  LedgerExpense, LedgerSettlement,
} from './index';

// Small deterministic PRNG so failures are reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${String(i + 1).padStart(2, '0')}`);

// ── money ───────────────────────────────────────────────────────
test('parseRupees', () => {
  assert.equal(parseRupees('100.01'), 10001);
  assert.equal(parseRupees('0.5'), 50);
  assert.equal(parseRupees('1800'), 180000);
  assert.equal(parseRupees(' 7 '), 700);
  for (const bad of ['', '-5', '1.234', '1e3', '1,000', 'abc', '0', '0.00', '10000001', '.5']) {
    assert.throws(() => parseRupees(bad), LedgerError, bad);
  }
  assert.equal(parseRupees('10000000'), 1_000_000_000);
});

test('formatINR uses Indian grouping', () => {
  assert.equal(formatINR(10001), '₹100.01');
  assert.equal(formatINR(123456789), '₹12,34,567.89');
  assert.equal(formatINR(500), '₹5.00');
  assert.equal(formatINR(100000), '₹1,000.00');
  assert.equal(formatINR(10000000), '₹1,00,000.00');
  assert.equal(formatINR(-45000), '-₹450.00');
  assert.equal(formatINR(5, { symbol: false }), '0.05');
});

test('assertPaise rejects unsafe values', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, 1_000_000_001, '5', null, undefined]) {
    assert.throws(() => assertPaise(bad), LedgerError);
  }
  assert.equal(assertPaise(1), 1);
  assert.equal(assertPaise(0, { allowZero: true }), 0);
});

// ── split: shared vectors ───────────────────────────────────────
const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'split-vectors.json'), 'utf8'),
) as {
  cases: {
    name: string; amount: number; mode: SplitMode; inputs: SplitInput[];
    expect?: number[]; expectError?: string;
  }[];
};

for (const c of vectors.cases) {
  test(`split vector: ${c.name}`, () => {
    if (c.expectError) {
      assert.throws(
        () => splitExpense(c.amount, c.mode, c.inputs),
        (e: unknown) => e instanceof LedgerError && e.code === c.expectError,
      );
    } else {
      const shares = splitExpense(c.amount, c.mode, c.inputs);
      assert.deepEqual(shares.map(s => s.share_paise), c.expect);
      assert.deepEqual(shares.map(s => s.user_id), c.inputs.map(i => i.user_id));
      assert.equal(shares.reduce((n, s) => n + s.share_paise, 0), c.amount);
    }
  });
}

// ── split: properties ───────────────────────────────────────────
test('split property: shares always sum to the amount and are order-independent', () => {
  const rand = rng(42);
  const modes: SplitMode[] = ['equal', 'percentage', 'shares'];
  for (let iter = 0; iter < 2000; iter++) {
    const n = 1 + Math.floor(rand() * 12);
    const amount = 1 + Math.floor(rand() * 1_000_000_000);
    const mode = modes[iter % 3];
    const users = ids(n);
    let values: number[];
    if (mode === 'percentage') {
      // random basis points that sum to exactly 10000
      const cuts = Array.from({ length: n - 1 }, () => Math.floor(rand() * 10001)).sort((a, b) => a - b);
      values = [...cuts, 10000].map((c, i) => c - (i ? [...cuts, 10000][i - 1] : 0));
    } else if (mode === 'shares') {
      values = users.map(() => 1 + Math.floor(rand() * 20));
    } else {
      values = users.map(() => 0);
    }
    const input = users.map((user_id, i) => ({ user_id, value: values[i] }));
    const out = splitExpense(amount, mode, input);
    assert.equal(out.reduce((a, s) => a + s.share_paise, 0), amount, `${mode} n=${n} amount=${amount}`);
    assert.ok(out.every(s => Number.isSafeInteger(s.share_paise) && s.share_paise >= 0));

    // reversing the input order must give every user the identical share
    const reversed = splitExpense(amount, mode, [...input].reverse());
    const byUser = Object.fromEntries(out.map(s => [s.user_id, s.share_paise]));
    for (const s of reversed) assert.equal(s.share_paise, byUser[s.user_id]);
  }
});

test('split property: exact mode round-trips', () => {
  const rand = rng(7);
  for (let iter = 0; iter < 500; iter++) {
    const n = 1 + Math.floor(rand() * 8);
    const amount = 1 + Math.floor(rand() * 100000);
    const cuts = Array.from({ length: n - 1 }, () => Math.floor(rand() * (amount + 1))).sort((a, b) => a - b);
    const parts = [...cuts, amount].map((c, i) => c - (i ? [...cuts, amount][i - 1] : 0));
    const out = splitExpense(amount, 'exact', ids(n).map((user_id, i) => ({ user_id, value: parts[i] })));
    assert.deepEqual(out.map(s => s.share_paise), parts);
  }
});

// ── balances ────────────────────────────────────────────────────
const expense = (paid_by: string, amount: number, shares: Record<string, number>, status: 'active' | 'voided' = 'active'): LedgerExpense => ({
  paid_by, amount_paise: amount, status,
  shares: Object.entries(shares).map(([user_id, share_paise]) => ({ user_id, share_paise })),
});
const settlement = (from: string, to: string, amount: number, status: LedgerSettlement['status']): LedgerSettlement => ({
  from_user: from, to_user: to, amount_paise: amount, status,
});

test('balances: positive = owed, voided expenses and unconfirmed settlements ignored', () => {
  const expenses = [
    expense('a', 90000, { a: 30000, b: 30000, c: 30000 }),
    expense('b', 30000, { a: 10000, b: 10000, c: 10000 }),
    expense('c', 99999, { a: 99999 }, 'voided'),
  ];
  const pending = settlement('c', 'a', 20000, 'pending_confirmation');
  let b = computeBalances(['a', 'b', 'c'], expenses, [pending]);
  assert.deepEqual(b, { a: 50000, b: -10000, c: -40000 });

  const confirmed = settlement('c', 'a', 20000, 'confirmed');
  b = computeBalances(['a', 'b', 'c'], expenses, [confirmed, settlement('b', 'a', 5000, 'cancelled'), settlement('b', 'a', 5000, 'rejected')]);
  assert.deepEqual(b, { a: 30000, b: -10000, c: -20000 });
  assert.equal(Object.values(b).reduce((x, y) => x + y, 0), 0);
});

test('balances: former members with a non-zero balance stay in the books', () => {
  const b = computeBalances(['a'], [expense('a', 1000, { a: 500, gone: 500 })], []);
  assert.deepEqual(b, { a: 500, gone: -500 });
});

test('maxSettlement / assertSettlementAllowed', () => {
  const b = { a: 50000, b: -10000, c: -40000 };
  assert.equal(maxSettlement(b, 'c', 'a'), 40000);
  assert.equal(maxSettlement(b, 'b', 'a'), 10000);
  assert.equal(maxSettlement(b, 'a', 'c'), 0); // creditor can't pay
  assert.equal(maxSettlement(b, 'b', 'c'), 0); // debtor -> debtor
  assert.equal(maxSettlement(b, 'a', 'a'), 0);
  assert.doesNotThrow(() => assertSettlementAllowed(b, 'c', 'a', 40000));
  assert.throws(() => assertSettlementAllowed(b, 'c', 'a', 40001), LedgerError);
  assert.throws(() => assertSettlementAllowed(b, 'c', 'a', 0), LedgerError);
  assert.throws(() => assertSettlementAllowed(b, 'c', 'a', 1.5), LedgerError);
  assert.throws(
    () => assertSettlementAllowed(b, 'c', 'a', 40001, 'balance_changed'),
    (e: unknown) => e instanceof LedgerError && e.code === 'balance_changed' && e.status === 409,
  );
  assert.equal(isFullySettled({ a: 0, b: 0 }), true);
  assert.equal(isFullySettled({ a: 1, b: -1 }), false);
});

// ── simplify ────────────────────────────────────────────────────
test('suggestTransfers settles everyone with at most n-1 transfers', () => {
  const rand = rng(99);
  for (let iter = 0; iter < 500; iter++) {
    const n = 2 + Math.floor(rand() * 10);
    const users = ids(n);
    const raw = users.map(() => Math.floor(rand() * 200000) - 100000);
    raw[n - 1] -= raw.reduce((a, b) => a + b, 0); // force sum to zero
    const balances = Object.fromEntries(users.map((u, i) => [u, raw[i]]));
    const transfers = suggestTransfers(balances);

    const after = { ...balances };
    for (const t of transfers) {
      assert.ok(t.amount_paise > 0);
      assert.ok(t.from !== t.to);
      assert.ok(balances[t.from] < 0 && balances[t.to] > 0);
      after[t.from] += t.amount_paise;
      after[t.to] -= t.amount_paise;
    }
    assert.ok(Object.values(after).every(v => v === 0), 'everyone settled');
    const nonZero = Object.values(balances).filter(v => v !== 0).length;
    assert.ok(transfers.length <= Math.max(0, nonZero - 1));
    assert.deepEqual(transfers, suggestTransfers(balances), 'deterministic');
  }
});

test('suggestTransfers example from the design (MST owes, Priya owes)', () => {
  const t = suggestTransfers({ you: 45000, mst: -30000, priya: -15000, arun: 0 });
  assert.deepEqual(t, [
    { from: 'mst', to: 'you', amount_paise: 30000 },
    { from: 'priya', to: 'you', amount_paise: 15000 },
  ]);
  assert.deepEqual(suggestTransfers({ a: 0, b: 0 }), []);
});

// ── invariants ──────────────────────────────────────────────────
test('assertLedgerConsistent accepts a valid ledger', () => {
  assert.doesNotThrow(() =>
    assertLedgerConsistent({
      memberIds: ['a', 'b'],
      expenses: [expense('a', 1000, { a: 500, b: 500 })],
      settlements: [settlement('b', 'a', 500, 'confirmed')],
    }),
  );
});

test('assertLedgerConsistent rejects corrupt ledgers with a 500', () => {
  const bad: { name: string; expenses?: LedgerExpense[]; settlements?: LedgerSettlement[] }[] = [
    { name: 'shares != amount', expenses: [expense('a', 1000, { a: 500, b: 499 })] },
    { name: 'no shares', expenses: [expense('a', 1000, {})] },
    { name: 'negative share', expenses: [expense('a', 1000, { a: 1500, b: -500 })] },
    { name: 'zero amount', expenses: [expense('a', 0, { a: 0 })] },
    { name: 'self settlement', settlements: [settlement('a', 'a', 100, 'confirmed')] },
    { name: 'zero settlement', settlements: [settlement('a', 'b', 0, 'pending_confirmation')] },
  ];
  for (const c of bad) {
    assert.throws(
      () => assertLedgerConsistent({ memberIds: ['a', 'b'], expenses: c.expenses ?? [], settlements: c.settlements ?? [] }),
      (e: unknown) => e instanceof LedgerError && e.status === 500 && e.code === 'ledger_inconsistent',
      c.name,
    );
  }
});

test('invariant holds for random ledgers built through splitExpense', () => {
  const rand = rng(1234);
  for (let iter = 0; iter < 300; iter++) {
    const users = ids(2 + Math.floor(rand() * 6));
    const expenses: LedgerExpense[] = [];
    for (let k = 0; k < 1 + Math.floor(rand() * 8); k++) {
      const amount = 1 + Math.floor(rand() * 500000);
      const participants = users.filter(() => rand() > 0.3);
      if (!participants.length) participants.push(users[0]);
      const shares = splitExpense(amount, 'equal', participants.map(user_id => ({ user_id, value: 0 })));
      expenses.push({
        paid_by: users[Math.floor(rand() * users.length)], amount_paise: amount, status: 'active',
        shares: shares.map(s => ({ user_id: s.user_id, share_paise: s.share_paise })),
      });
    }
    const balances = computeBalances(users, expenses, []);
    const settlements = suggestTransfers(balances).map(t =>
      settlement(t.from, t.to, t.amount_paise, 'confirmed'));
    assert.doesNotThrow(() => assertLedgerConsistent({ memberIds: users, expenses, settlements }));
    assert.ok(isFullySettled(computeBalances(users, expenses, settlements)));
  }
});

// ── stats ───────────────────────────────────────────────────────
const sx = (paid_by: string, amount: number, category: string, date: string, shareUsers: string[]) => ({
  paid_by, amount_paise: amount, category, expense_date: date, status: 'active' as const,
  shares: shareUsers.map(user_id => ({ user_id, share_paise: Math.floor(amount / shareUsers.length) })),
});

test('windowRange', () => {
  assert.deepEqual(windowRange('all', '2026-09-27'), { from: null, to: null });
  // 2026-09-27 is a Sunday -> week Mon 21 .. Sun 27
  assert.deepEqual(windowRange('week', '2026-09-27'), { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(windowRange('week', '2026-09-28'), { from: '2026-09-28', to: '2026-10-04' });
  assert.deepEqual(windowRange('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(windowRange('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
});

test('stats match the design numbers (A4 / B6)', () => {
  const members = ['a', 'b', 'c', 'd', 'e', 'f'];
  const expenses = [
    sx('a', 125000, 'Food', '2026-09-21', members),
    sx('b', 55000, 'Food', '2026-09-22', members),
    sx('c', 90000, 'Travel', '2026-09-23', members),
    sx('d', 75000, 'Stay', '2026-09-23', members),
    sx('e', 50000, 'Shopping', '2026-09-25', members),
    sx('f', 30000, 'Other', '2026-09-27', members),
  ];
  const s = computeEventStats({ budget_paise: 800000, memberIds: members, expenses, window: 'all', today: '2026-09-27' });
  assert.equal(s.spent_paise, 425000);
  assert.equal(s.total_spent_paise, 425000);
  assert.equal(s.remaining_paise, 375000);
  assert.equal(s.budget_used_pct, 53);
  assert.equal(s.per_person_paise, 70833);
  assert.equal(s.top_category?.category, 'Food');
  assert.equal(s.top_category?.total_paise, 180000);
  assert.equal(s.top_category?.pct, 42);
  assert.equal(s.expense_count, 6);
  assert.ok(s.insights[0].includes('53%'));
  assert.ok(s.insights[1].startsWith('Food'));
  assert.equal(s.members[0].user_id, 'a');
  assert.equal(s.members[0].paid_pct, 29);
});

test('stats: windows, zero-filled trend, no budget, over budget, no expenses', () => {
  const members = ['a', 'b'];
  const expenses = [
    sx('a', 1000, 'Food', '2026-09-14', members), // previous week
    sx('b', 2000, 'Food', '2026-09-22', members), // Tue this week
    sx('a', 3000, 'Travel', '2026-09-22', members),
  ];
  const week = computeEventStats({ budget_paise: null, memberIds: members, expenses, window: 'week', today: '2026-09-24' });
  assert.equal(week.spent_paise, 5000);
  assert.equal(week.total_spent_paise, 6000);
  assert.equal(week.remaining_paise, null);
  assert.equal(week.budget_used_pct, null);
  assert.equal(week.trend.length, 7);
  assert.deepEqual(week.trend[1], { date: '2026-09-22', total_paise: 5000 });
  assert.equal(week.trend[0].total_paise, 0);

  const over = computeEventStats({ budget_paise: 4000, memberIds: members, expenses, window: 'all', today: '2026-09-24' });
  assert.equal(over.remaining_paise, -2000);
  assert.ok(over.insights[0].includes('over the event budget'));

  const empty = computeEventStats({ budget_paise: 1000, memberIds: members, expenses: [], window: 'month', today: '2026-09-24' });
  assert.equal(empty.spent_paise, 0);
  assert.equal(empty.top_category, null);
  assert.equal(empty.budget_used_pct, 0);
  assert.deepEqual(empty.categories, []);

  const voided = computeEventStats({
    budget_paise: null, memberIds: members, window: 'all', today: '2026-09-24',
    expenses: [{ ...sx('a', 999, 'Food', '2026-09-22', members), status: 'voided' as const }],
  });
  assert.equal(voided.spent_paise, 0);
});

// ── pairwise (Balances screen "Your balance" card) ───────────────
test('computePairwise: gross owe/owed, netted per person, matches the net balance', () => {
  const expenses = [
    expense('a', 90000, { a: 30000, b: 30000, c: 30000 }),
    expense('b', 30000, { a: 10000, b: 10000, c: 10000 }),
    expense('c', 99999, { a: 99999 }, 'voided'),
  ];
  const p = computePairwise('a', expenses, []);
  // b owes a 30000 and a owes b 10000 -> b owes a 20000 net; c owes a 30000, a owes c 0
  assert.deepEqual(p.by_member, { b: -20000, c: -30000 });
  assert.equal(p.owed_paise, 50000);
  assert.equal(p.you_owe_paise, 0);

  const confirmed = [settlement('c', 'a', 20000, 'confirmed'), settlement('b', 'a', 5000, 'pending_confirmation')];
  const q = computePairwise('a', expenses, confirmed);
  assert.deepEqual(q.by_member, { b: -20000, c: -10000 });
  const net = computeBalances(['a', 'b', 'c'], expenses, confirmed);
  assert.equal(q.owed_paise - q.you_owe_paise, net.a);
});

test('computePairwise: debt both ways at once (design: you owe 400, owed 850)', () => {
  const expenses = [
    expense('a', 100000, { b: 85000, a: 15000 }),   // b owes a 85000
    expense('c', 40000, { a: 40000 }),               // a owes c 40000
  ];
  const p = computePairwise('a', expenses, []);
  assert.equal(p.owed_paise, 85000);
  assert.equal(p.you_owe_paise, 40000);
  assert.equal(computeBalances(['a', 'b', 'c'], expenses, []).a, 45000); // +450 net, as in the design
});

test('computePairwise property: owed - you_owe always equals the net balance', () => {
  const rand = rng(555);
  for (let iter = 0; iter < 300; iter++) {
    const users = ids(2 + Math.floor(rand() * 5));
    const expenses: LedgerExpense[] = [];
    for (let k = 0; k < 1 + Math.floor(rand() * 6); k++) {
      const amount = 1 + Math.floor(rand() * 100000);
      const participants = users.filter(() => rand() > 0.3);
      if (!participants.length) participants.push(users[0]);
      const shares = splitExpense(amount, 'equal', participants.map(user_id => ({ user_id, value: 0 })));
      expenses.push({ paid_by: users[Math.floor(rand() * users.length)], amount_paise: amount, status: 'active', shares: shares.map(s => ({ user_id: s.user_id, share_paise: s.share_paise })) });
    }
    const balances = computeBalances(users, expenses, []);
    const settlements = suggestTransfers(balances).slice(0, 2).map(t => settlement(t.from, t.to, t.amount_paise, 'confirmed'));
    const after = computeBalances(users, expenses, settlements);
    for (const u of users) {
      const p = computePairwise(u, expenses, settlements);
      assert.equal(p.owed_paise - p.you_owe_paise, after[u], `user ${u}`);
    }
  }
});

test('previous window and change vs last week / last month', () => {
  assert.equal(previousWindowRange('all', '2026-09-27'), null);
  assert.deepEqual(previousWindowRange('week', '2026-09-27'), { from: '2026-09-14', to: '2026-09-20' });
  assert.deepEqual(previousWindowRange('month', '2026-03-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(previousWindowRange('month', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });

  const members = ['a', 'b'];
  const expenses = [
    sx('a', 10000, 'Food', '2026-09-15', members), // last week
    sx('b', 11200, 'Food', '2026-09-22', members), // this week
  ];
  const week = computeEventStats({ budget_paise: null, memberIds: members, expenses, window: 'week', today: '2026-09-24' });
  assert.equal(week.previous_spent_paise, 10000);
  assert.equal(week.change_pct, 12, '+12% from last week, as in the design');
  const drop = computeEventStats({ budget_paise: null, memberIds: members, expenses: [expenses[0], sx('b', 2500, 'Food', '2026-09-22', members)], window: 'week', today: '2026-09-24' });
  assert.equal(drop.change_pct, -75);
  const none = computeEventStats({ budget_paise: null, memberIds: members, expenses: [expenses[1]], window: 'week', today: '2026-09-24' });
  assert.equal(none.change_pct, null, 'nothing last week to compare with');
  assert.equal(computeEventStats({ budget_paise: null, memberIds: members, expenses, window: 'all', today: '2026-09-24' }).change_pct, null);
});
