import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, plainAmount, settlementsCsv, toCsv } from './reports.csv';

test('plainAmount is exact', () => {
  assert.equal(plainAmount(0), '0.00');
  assert.equal(plainAmount(5), '0.05');
  assert.equal(plainAmount(10001), '100.01');
  assert.equal(plainAmount(1_000_000_000), '10000000.00');
  assert.equal(plainAmount(-45000), '-450.00');
});

test('cells that could run as spreadsheet formulas are neutralised', () => {
  for (const evil of ['=HYPERLINK("http://evil","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', "=cmd|' /C calc'!A0"]) {
    assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), `${JSON.stringify(evil)} -> ${csvCell(evil)}`);
  }
  assert.equal(csvCell('Priya'), 'Priya');
  assert.equal(csvCell('a-b = c'), 'a-b = c', 'only a LEADING trigger matters');
  assert.equal(csvCell(450), '450');
});

test('RFC 4180 quoting for commas, quotes and newlines', () => {
  assert.equal(csvCell('Cake, Decor'), '"Cake, Decor"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('=A,B'), `"'=A,B"`, 'neutralised AND quoted');
});

test('toCsv: BOM, CRLF, header first, trailing newline', () => {
  const out = toCsv(['A', 'B'], [['1', 'x,y'], ['2', '']]);
  assert.equal(out, '﻿A,B\r\n1,"x,y"\r\n2,\r\n');
});

test('settlementsCsv: columns, ISO dates, plain amounts, hostile names', () => {
  const out = settlementsCsv([
    { reference_code: 'TXN-AAAA-0001', paid_marked_at: '2026-09-27T10:00:00.000Z', from_name: '=1+1', to_name: 'Priya', amount_paise: 50000, method: 'upi', upi_app: 'phonepe', utr: 'T123456', status: 'confirmed', confirmed_at: new Date('2026-09-27T11:00:00Z') },
    { reference_code: 'TXN-AAAA-0002', paid_marked_at: new Date('2026-09-28T10:00:00Z'), from_name: 'MST', to_name: 'Priya', amount_paise: 123, method: 'cash', upi_app: null, utr: null, status: 'pending_confirmation', confirmed_at: null },
  ]);
  const lines = out.replace('﻿', '').trimEnd().split('\r\n');
  assert.equal(lines[0], 'Reference,Date,From,To,Amount (INR),Method,UPI app,UTR,Status,Confirmed at');
  assert.equal(lines[1], "TXN-AAAA-0001,2026-09-27T10:00:00.000Z,'=1+1,Priya,500.00,upi,phonepe,T123456,confirmed,2026-09-27T11:00:00.000Z");
  assert.equal(lines[2], 'TXN-AAAA-0002,2026-09-28T10:00:00.000Z,MST,Priya,1.23,cash,,,pending_confirmation,');
});
