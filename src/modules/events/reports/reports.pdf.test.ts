import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatDay, formatInstant, ReceiptData, renderEventReport, renderReceipt, ReportData } from './reports.pdf';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fontkit = require('fontkit');

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

function sample(expenseCount = 6, over: Partial<ReportData> = {}): ReportData {
  const expenses = Array.from({ length: expenseCount }, (_, i) => ({
    date: `2026-09-${String(1 + (i % 27)).padStart(2, '0')}`, title: ['Dinner at The Grill', 'Cake & Decor', 'Taxi to Venue'][i % 3] + ` #${i + 1}`,
    category: ['Food', 'Celebration', 'Travel'][i % 3], paid_by_name: ['Balashankar M', 'Priya', 'MST'][i % 3], amount_paise: 45000 + i * 100,
  }));
  return {
    generated_at: new Date('2026-09-27T10:30:00Z'),
    event: { title: 'Birthday Party', event_type: 'birthday', start_date: '2026-09-27', end_date: '2026-09-27', location: 'Goa Beach Resort', description: 'Weekend celebration at the beach house', status: 'active', budget_paise: 800000 },
    totals: { spent_paise: 425000, remaining_paise: 375000, budget_used_pct: 53, member_count: 6, expense_count: expenseCount },
    balances: [{ name: 'Balashankar M', balance_paise: 45000 }, { name: 'MST', balance_paise: -30000 }, { name: 'Priya', balance_paise: -15000 }, { name: 'Arun', balance_paise: 0 }],
    categories: [{ category: 'Food', total_paise: 180000, pct: 42 }, { category: 'Travel', total_paise: 90000, pct: 21 }, { category: 'Stay', total_paise: 75000, pct: 18 }],
    expenses,
    settlements: [{ reference_code: 'TXN-8829-4410', date: '2026-09-27T09:00:00Z', from_name: 'MST', to_name: 'Balashankar M', amount_paise: 30000, method: 'upi', status: 'confirmed' }],
    ...over,
  };
}

const receipt = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  generated_at: new Date('2026-09-27T10:30:00Z'), event_title: 'Birthday Party', reference_code: 'TXN-8829-4410', status: 'confirmed',
  from_name: 'You', to_name: 'MST', amount_paise: 50000, method: 'upi', upi_app: 'phonepe', utr: 'T2609271234ABCD',
  paid_marked_at: '2026-09-27T09:00:00Z', confirmed_at: '2026-09-27T09:30:00Z', ...over,
});

test('the bundled fonts contain the rupee sign', () => {
  const dir = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
  for (const f of ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf']) {
    assert.equal(fontkit.openSync(path.join(dir, f)).hasGlyphForCodePoint(0x20b9), true, f);
  }
});

test('formatDay and formatInstant', () => {
  assert.equal(formatDay('2026-09-27'), '27 Sep 2026');
  assert.equal(formatDay('2027-01-05'), '5 Jan 2027');
  assert.match(formatInstant('2026-09-27T09:00:00Z'), /^27 Sep 2026 14:30$/, 'shown in Indian time (UTC+5:30)');
});

test('event report is a valid PDF', async () => {
  const pdf = await renderEventReport(sample());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.subarray(-16).toString('latin1'), /%%EOF/);
  assert.ok(pdf.length > 5000);
  assert.equal(pageCount(await renderEventReport(sample(), { compress: false })), 1);
});

test('event report handles an empty event, no budget, an over-budget event and no settlements', async () => {
  for (const data of [
    sample(0, { categories: [], settlements: [], balances: [], totals: { spent_paise: 0, remaining_paise: null, budget_used_pct: null, member_count: 1, expense_count: 0 }, event: { ...sample().event, budget_paise: null, description: null, location: null } }),
    sample(3, { totals: { spent_paise: 900000, remaining_paise: -100000, budget_used_pct: 113, member_count: 3, expense_count: 3 } }),
  ]) {
    const pdf = await renderEventReport(data);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pageCount(await renderEventReport(data, { compress: false })), 1);
  }
});

test('long expense lists continue on new pages; extreme lists are capped', async () => {
  const pages = pageCount(await renderEventReport(sample(300), { compress: false }));
  assert.ok(pages >= 8 && pages <= 14, `300 expenses -> ${pages} pages`);
  const capped = pageCount(await renderEventReport(sample(1500), { compress: false }));
  assert.ok(capped < 45, `1500 expenses are capped, got ${capped} pages`);
});

test('hostile or unusual text does not break rendering', async () => {
  const nasty = 'A'.repeat(500) + ' 🎂 <b>x</b> "q" \ \u0000 \u202e இன்று';
  const data = sample(2, {
    event: { ...sample().event, title: nasty, location: nasty, description: nasty },
    balances: [{ name: nasty, balance_paise: 100 }],
    expenses: [{ date: '2026-09-27', title: nasty, category: nasty, paid_by_name: nasty, amount_paise: 1_000_000_000 }],
  });
  const pdf = await renderEventReport(data);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('receipt: one page for every status and method', async () => {
  for (const over of [
    {}, { status: 'pending_confirmation' as const, confirmed_at: null }, { status: 'rejected' as const, confirmed_at: null },
    { status: 'cancelled' as const, confirmed_at: null }, { method: 'cash', upi_app: null, utr: null }, { method: 'bank' },
    { from_name: 'X'.repeat(300), to_name: '🎂' },
  ]) {
    const pdf = await renderReceipt(receipt(over), { compress: false });
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pageCount(pdf), 1, JSON.stringify(over).slice(0, 60));
  }
});

// Writes sample PDFs for a visual check when SPENXO_PDF_OUT is set (not part of the normal run).
test('write sample PDFs for visual inspection', { skip: !process.env.SPENXO_PDF_OUT }, async () => {
  const out = process.env.SPENXO_PDF_OUT!;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.pdf'), await renderEventReport(sample(40)));
  fs.writeFileSync(path.join(out, 'receipt.pdf'), await renderReceipt(receipt()));
});
