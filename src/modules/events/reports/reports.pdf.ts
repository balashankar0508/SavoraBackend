import path from 'path';
import PDFDocument from 'pdfkit';
import { formatINR } from '../ledger';

/**
 * PDF documents, drawn from plain data (no database access here) so they can be
 * unit-tested. Text uses DejaVu Sans because PDF's built-in fonts have no rupee
 * sign; names in scripts DejaVu lacks (e.g. Tamil, Hindi) show as empty boxes.
 */

const FONT_DIR = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

const C = {
  primary: '#5B4FCF', dark: '#3B2FAF', ink: '#1A1A2E', muted: '#6B6B8A', line: '#E8E8F0',
  tint: '#EEEDFB', red: '#E5484D', green: '#1F9D6B', white: '#FFFFFF',
};

const MAX_EXPENSE_ROWS = 1000;
const MAX_SETTLEMENT_ROWS = 300;
const TZ = 'Asia/Kolkata'; // INR-only product: show Indian time

export interface ReportData {
  generated_at: Date;
  event: {
    title: string; event_type: string; start_date: string; end_date: string; location: string | null;
    description: string | null; status: string; budget_paise: number | null;
  };
  totals: { spent_paise: number; remaining_paise: number | null; budget_used_pct: number | null; member_count: number; expense_count: number };
  balances: { name: string; balance_paise: number }[];
  categories: { category: string; total_paise: number; pct: number }[];
  expenses: { date: string; title: string; category: string; paid_by_name: string; amount_paise: number }[];
  settlements: { reference_code: string; date: string | Date; from_name: string; to_name: string; amount_paise: number; method: string; status: string }[];
}

export interface ReceiptData {
  generated_at: Date;
  event_title: string;
  reference_code: string;
  status: 'pending_confirmation' | 'confirmed' | 'rejected' | 'cancelled';
  from_name: string;
  to_name: string;
  amount_paise: number;
  method: string;
  upi_app: string | null;
  utr: string | null;
  paid_marked_at: Date | string;
  confirmed_at: Date | string | null;
}

// ── formatting ──────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-27" -> "27 Sep 2026" (no time-zone maths: it is a calendar date). */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "27 Sep 2026 14:30" in Indian time. Built from parts so ICU's locale quirks ("Sept") can't change it. */
export function formatInstant(value: Date | string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(value)).map(p => [p.type, p.value]),
  );
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year} ${parts.hour}:${parts.minute}`;
}

const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
const STATUS_LABEL: Record<string, string> = {
  pending_confirmation: 'Pending', confirmed: 'Confirmed', rejected: 'Rejected', cancelled: 'Cancelled',
};
const METHOD_LABEL: Record<string, string> = { upi: 'UPI', bank: 'Bank transfer', cash: 'Cash', other: 'Other' };
const APP_LABEL: Record<string, string> = { gpay: 'Google Pay', phonepe: 'PhonePe', paytm: 'Paytm', bhim: 'BHIM', other: 'Other UPI app' };

// ── drawing helpers ─────────────────────────────────────────────

type Doc = InstanceType<typeof PDFDocument>;

function newDoc(title: string, size: 'A4' | 'A5', compress: boolean): Doc {
  const doc = new PDFDocument({
    size, margin: size === 'A4' ? 48 : 36, bufferPages: true, compress,
    info: { Title: title, Author: 'Spenxo', Creator: 'Spenxo', Producer: 'Spenxo' },
  });
  doc.registerFont('R', REGULAR);
  doc.registerFont('B', BOLD);
  return doc;
}

function finish(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function put(doc: Doc, text: string, x: number, y: number, o: { w?: number; size?: number; bold?: boolean; color?: string; align?: 'left' | 'right' | 'center'; h?: number } = {}) {
  doc.font(o.bold ? 'B' : 'R').fontSize(o.size ?? 9).fillColor(o.color ?? C.ink);
  doc.text(text, x, y, { width: o.w, align: o.align ?? 'left', height: o.h, ellipsis: o.h !== undefined });
}

/** Page footer on every page, written after layout so it can say "Page i of n". */
function addFooters(doc: Doc, generatedAt: Date) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const m = doc.page.margins;
    const bottom = m.bottom;
    m.bottom = 0; // otherwise text this low would spill onto a new page
    const y = doc.page.height - 30;
    const w = doc.page.width - m.left - m.right;
    doc.moveTo(m.left, y - 6).lineTo(m.left + w, y - 6).lineWidth(0.5).strokeColor(C.line).stroke();
    put(doc, `Calculated by Spenxo on ${formatInstant(generatedAt)} from recorded transactions.`, m.left, y, { w: w - 70, size: 7, color: C.muted });
    put(doc, `Page ${i + 1} of ${range.count}`, m.left + w - 70, y, { w: 70, size: 7, color: C.muted, align: 'right' });
    m.bottom = bottom;
  }
}

interface Col { title: string; w: number; align?: 'left' | 'right' }
const ROW_H = 20;

function section(doc: Doc, title: string, y: number, need = 80): number {
  if (y + need > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
  put(doc, title, doc.page.margins.left, y, { size: 12, bold: true, color: C.primary });
  const lineY = y + 18;
  doc.moveTo(doc.page.margins.left, lineY).lineTo(doc.page.width - doc.page.margins.right, lineY).lineWidth(0.8).strokeColor(C.primary).stroke();
  return lineY + 8;
}

/** Fixed-height rows; long text is cut with an ellipsis. Repeats the header on each new page. */
function table(doc: Doc, y: number, cols: Col[], rows: { cells: string[]; colors?: (string | undefined)[]; bar?: number }[]): number {
  const left = doc.page.margins.left;
  const width = cols.reduce((n, c) => n + c.w, 0);
  const header = (at: number) => {
    doc.rect(left, at, width, ROW_H).fill(C.tint);
    let x = left;
    for (const c of cols) { put(doc, c.title.toUpperCase(), x + 5, at + 6, { w: c.w - 10, size: 7, bold: true, color: C.muted, align: c.align }); x += c.w; }
    return at + ROW_H;
  };
  y = header(y);
  for (const row of rows) {
    if (y + ROW_H > doc.page.height - 60) { doc.addPage(); y = header(doc.page.margins.top); }
    let x = left;
    cols.forEach((c, i) => {
      if (row.bar !== undefined && i === 1) {
        doc.rect(x + 5, y + 7, c.w - 10, 6).fill(C.line);
        doc.rect(x + 5, y + 7, Math.max(1, ((c.w - 10) * row.bar) / 100), 6).fill(C.primary);
      } else {
        put(doc, row.cells[i] ?? '', x + 5, y + 6, { w: c.w - 10, h: 12, size: 8.5, color: row.colors?.[i], align: c.align });
      }
      x += c.w;
    });
    doc.moveTo(left, y + ROW_H).lineTo(left + width, y + ROW_H).lineWidth(0.3).strokeColor(C.line).stroke();
    y += ROW_H;
  }
  return y + 14;
}

// ── event report ────────────────────────────────────────────────

export async function renderEventReport(data: ReportData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = newDoc(`${data.event.title} - Spenxo report`, 'A4', opts.compress ?? true);
  const m = doc.page.margins.left;
  const W = doc.page.width - m * 2;
  const { event, totals } = data;

  // header band
  doc.rect(0, 0, doc.page.width, 96).fill(C.dark);
  put(doc, event.title, m, 26, { w: W - 90, h: 30, size: 20, bold: true, color: C.white });
  const dates = event.end_date === event.start_date ? formatDay(event.start_date) : `${formatDay(event.start_date)} – ${formatDay(event.end_date)}`;
  put(doc, [label(event.event_type), dates, event.location].filter(Boolean).join('  ·  '), m, 62, { w: W - 90, h: 14, size: 10, color: '#D9D6F7' });
  put(doc, event.status.toUpperCase(), m + W - 86, 30, { w: 86, size: 9, bold: true, color: '#D9D6F7', align: 'right' });

  // summary tiles
  const tiles: [string, string, string?][] = [
    ['Budget', event.budget_paise === null ? 'No budget' : formatINR(event.budget_paise)],
    ['Spent', formatINR(totals.spent_paise), totals.budget_used_pct !== null ? `${totals.budget_used_pct}% of budget` : undefined],
    ['Remaining', totals.remaining_paise === null ? '—' : formatINR(totals.remaining_paise), totals.remaining_paise !== null && totals.remaining_paise < 0 ? 'over budget' : undefined],
    ['Members', String(totals.member_count), `${totals.expense_count} expenses`],
  ];
  const tw = (W - 30) / 4;
  tiles.forEach(([name, value, sub], i) => {
    const x = m + i * (tw + 10);
    doc.roundedRect(x, 114, tw, 58, 6).lineWidth(0.6).strokeColor(C.line).stroke();
    put(doc, name.toUpperCase(), x + 8, 122, { w: tw - 16, size: 7, bold: true, color: C.muted });
    put(doc, value, x + 8, 136, { w: tw - 16, h: 16, size: 12.5, bold: true, color: name === 'Remaining' && totals.remaining_paise !== null && totals.remaining_paise < 0 ? C.red : C.ink });
    if (sub) put(doc, sub, x + 8, 156, { w: tw - 16, h: 10, size: 7, color: C.muted });
  });

  let y = 190;
  if (event.description) {
    put(doc, event.description, m, y, { w: W, h: 36, size: 9, color: C.muted });
    y += 46;
  }

  // final balances
  y = section(doc, 'Final balances', y);
  const owed = data.balances.reduce((n, b) => n + Math.max(0, b.balance_paise), 0);
  y = table(doc, y, [{ title: 'Member', w: W - 260 }, { title: 'Status', w: 120 }, { title: 'Balance', w: 140, align: 'right' }],
    data.balances.map(b => ({
      cells: [b.name, b.balance_paise === 0 ? 'Settled' : b.balance_paise > 0 ? 'To receive' : 'To pay', b.balance_paise === 0 ? '—' : `${b.balance_paise > 0 ? '+' : '−'}${formatINR(Math.abs(b.balance_paise))}`],
      colors: [undefined, undefined, b.balance_paise > 0 ? C.green : b.balance_paise < 0 ? C.red : C.muted],
    })));
  put(doc, owed === 0 ? 'Everyone is settled.' : `${formatINR(owed)} still to be settled between members.`, m, y - 8, { w: W, size: 8, color: C.muted });
  y += 12;

  // categories
  if (data.categories.length) {
    y = section(doc, 'Spending by category', y, 100);
    y = table(doc, y, [{ title: 'Category', w: 150 }, { title: 'Share', w: W - 150 - 90 - 59 }, { title: 'Amount', w: 90, align: 'right' }, { title: '%', w: 59, align: 'right' }],
      data.categories.map(c => ({ cells: [c.category, '', formatINR(c.total_paise), `${c.pct}%`], bar: c.pct })));
  }

  // expenses
  y = section(doc, `Expenses (${totals.expense_count})`, y, 90);
  if (!data.expenses.length) {
    put(doc, 'No expenses were recorded.', m, y, { size: 9, color: C.muted });
    y += 24;
  } else {
    const shown = data.expenses.slice(0, MAX_EXPENSE_ROWS);
    y = table(doc, y, [{ title: 'Date', w: 72 }, { title: 'Description', w: W - 72 - 100 - 100 - 76 }, { title: 'Category', w: 100 }, { title: 'Paid by', w: 100 }, { title: 'Amount', w: 76, align: 'right' }],
      shown.map(e => ({ cells: [formatDay(e.date), e.title, e.category, e.paid_by_name, formatINR(e.amount_paise)] })));
    if (data.expenses.length > shown.length) {
      put(doc, `…and ${data.expenses.length - shown.length} more expenses not shown. Export them from the app.`, m, y - 8, { w: W, size: 8, color: C.muted });
      y += 12;
    }
  }

  // settlements
  if (data.settlements.length) {
    y = section(doc, 'Settlements', y, 90);
    const shown = data.settlements.slice(0, MAX_SETTLEMENT_ROWS);
    y = table(doc, y, [{ title: 'Reference', w: 92 }, { title: 'Date', w: 66 }, { title: 'From → To', w: W - 92 - 66 - 62 - 66 - 72 }, { title: 'Method', w: 62 }, { title: 'Status', w: 66 }, { title: 'Amount', w: 72, align: 'right' }],
      shown.map(s => ({
        cells: [s.reference_code, formatInstant(s.date).split(' ').slice(0, 3).join(' '), `${s.from_name} → ${s.to_name}`, METHOD_LABEL[s.method] ?? label(s.method), STATUS_LABEL[s.status] ?? label(s.status), formatINR(s.amount_paise)],
        colors: [undefined, undefined, undefined, undefined, s.status === 'confirmed' ? C.green : C.muted, undefined],
      })));
  }

  addFooters(doc, data.generated_at);
  return finish(doc);
}

// ── settlement receipt ──────────────────────────────────────────

export async function renderReceipt(data: ReceiptData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = newDoc(`Spenxo payment receipt ${data.reference_code}`, 'A5', opts.compress ?? true);
  const m = doc.page.margins.left;
  const W = doc.page.width - m * 2;
  const confirmed = data.status === 'confirmed';

  doc.rect(0, 0, doc.page.width, 70).fill(C.dark);
  put(doc, 'Spenxo', m, 22, { size: 18, bold: true, color: C.white });
  put(doc, confirmed ? 'Settlement receipt' : 'Payment record', m, 46, { size: 10, color: '#D9D6F7' });

  put(doc, confirmed ? 'SETTLEMENT RECORDED' : (STATUS_LABEL[data.status] ?? data.status).toUpperCase(), m, 96, {
    w: W, size: 8, bold: true, color: confirmed ? C.green : C.muted, align: 'center',
  });
  put(doc, formatINR(data.amount_paise), m, 112, { w: W, size: 28, bold: true, align: 'center' });
  put(doc, `${data.from_name}  →  ${data.to_name}`, m, 152, { w: W, h: 16, size: 11, color: C.muted, align: 'center' });

  const rows: [string, string][] = [
    ['Reference', data.reference_code],
    ['Event', data.event_title],
    ['Marked as paid', formatInstant(data.paid_marked_at)],
    ['Method', data.method === 'upi' && data.upi_app ? `UPI · ${APP_LABEL[data.upi_app] ?? label(data.upi_app)}` : (METHOD_LABEL[data.method] ?? label(data.method))],
  ];
  if (data.utr) rows.push(['UTR / transaction ID', data.utr]);
  rows.push(['Confirmed by recipient', data.confirmed_at ? formatInstant(data.confirmed_at) : 'Not yet confirmed']);

  let y = 190;
  doc.rect(m, y - 8, W, rows.length * 30 + 8).fill('#F8F9FE');
  for (const [k, v] of rows) {
    put(doc, k.toUpperCase(), m + 12, y, { w: 120, size: 7, bold: true, color: C.muted });
    put(doc, v, m + 135, y - 2, { w: W - 147, h: 14, size: 9.5, align: 'right' });
    y += 30;
  }

  put(doc, confirmed
    ? 'This receipt records a payment made between members outside Spenxo and confirmed by the recipient.'
    : 'This payment has not been confirmed by the recipient yet, so it has not changed anyone’s balance.',
  m, y + 14, { w: W, size: 8, color: C.muted, align: 'center' });

  addFooters(doc, data.generated_at);
  return finish(doc);
}
