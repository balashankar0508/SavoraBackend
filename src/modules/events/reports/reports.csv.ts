/**
 * CSV for spreadsheets. Names, titles and notes are typed by users, so a cell that
 * begins with = + - @ (or a tab/CR) could run as a formula when the file is opened in
 * Excel or Sheets. Those cells get a leading apostrophe, which spreadsheets show as
 * plain text. Everything else follows RFC 4180 quoting.
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 BOM so Excel shows non-Latin names correctly; CRLF line endings per the RFC. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 123456 paise -> "1234.56" (exact integer arithmetic, no thousands separators, safe to sum). */
export function plainAmount(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export interface SettlementCsvRow {
  reference_code: string;
  paid_marked_at: string | Date;
  from_name: string;
  to_name: string;
  amount_paise: number;
  method: string;
  upi_app: string | null;
  utr: string | null;
  status: string;
  confirmed_at: string | Date | null;
}

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : '');

export function settlementsCsv(rows: SettlementCsvRow[]): string {
  return toCsv(
    ['Reference', 'Date', 'From', 'To', 'Amount (INR)', 'Method', 'UPI app', 'UTR', 'Status', 'Confirmed at'],
    rows.map(r => [
      r.reference_code, iso(r.paid_marked_at), r.from_name, r.to_name, plainAmount(r.amount_paise),
      r.method, r.upi_app, r.utr, r.status, iso(r.confirmed_at),
    ]),
  );
}
