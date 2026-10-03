import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInviteCode, generateInviteCode, generateReference, normalizeInviteCode } from './codes';

test('generated invite codes look like SPX-XXXX-XXXX with no ambiguous characters', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const code = generateInviteCode();
    assert.match(code, /^SPX-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(normalizeInviteCode(code), code.slice(4).replace('-', ''));
    seen.add(code);
  }
  assert.ok(seen.size > 1990, 'codes are not repeating');
});

test('generated references look like TXN-XXXX-XXXX', () => {
  assert.match(generateReference(), /^TXN-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

test('normalizeInviteCode accepts every sensible way a user types a code', () => {
  for (const input of ['SPX-7K4M-92QD', 'spx-7k4m-92qd', ' SPX 7K4M 92QD ', '7K4M92QD', '7k4m-92qd', 'SPX7K4M92QD']) {
    assert.equal(normalizeInviteCode(input), '7K4M92QD', input);
  }
  // Crockford look-alikes
  assert.equal(normalizeInviteCode('SPX-7K4M-92QO'), '7K4M92Q0');
  assert.equal(normalizeInviteCode('SPX-IL4M-92QD'), '114M92QD');
});

test('a code whose body itself starts with SPX is not mangled', () => {
  assert.equal(normalizeInviteCode('SPX-SPXA-1234'), 'SPXA1234');
  assert.equal(normalizeInviteCode('SPXA1234'), 'SPXA1234');
  assert.equal(formatInviteCode('SPXA1234'), 'SPX-SPXA-1234');
});

test('normalizeInviteCode rejects anything else', () => {
  for (const bad of ['', 'SPX', 'SPX-7K4M', 'SPX-7K4M-92QDX', 'SPX-7K4M-92QU', '<script>', "'; drop table--", '0'.repeat(30), 'SPX-7K4M-92Q!']) {
    assert.equal(normalizeInviteCode(bad), null, bad);
  }
});
