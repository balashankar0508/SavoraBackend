import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constantTimeEqual, decryptGcm, encryptGcm, hmacHex, openString, sealString } from './secretBox';

const KEY = randomBytes(32).toString('hex');
const OTHER = randomBytes(32).toString('hex');

test('hmacHex is deterministic, keyed, and separated by label', () => {
  assert.equal(hmacHex(KEY, 'lookup', 'ABC'), hmacHex(KEY, 'lookup', 'ABC'));
  assert.notEqual(hmacHex(KEY, 'lookup', 'ABC'), hmacHex(OTHER, 'lookup', 'ABC'));
  assert.notEqual(hmacHex(KEY, 'lookup', 'ABC'), hmacHex(KEY, 'other', 'ABC'));
  assert.match(hmacHex(KEY, 'lookup', 'x'), /^[a-f0-9]{64}$/);
});

test('sealString round-trips and uses a fresh IV each time', () => {
  const a = sealString(KEY, 'invite', 'SPX-7K4M-92QD', 'event-1');
  const b = sealString(KEY, 'invite', 'SPX-7K4M-92QD', 'event-1');
  assert.notEqual(a, b);
  assert.equal(openString(KEY, 'invite', a, 'event-1'), 'SPX-7K4M-92QD');
  assert.equal(openString(KEY, 'invite', b, 'event-1'), 'SPX-7K4M-92QD');
  assert.ok(!a.includes('SPX'));
});

test('decryption fails for a wrong key, wrong label, wrong AAD, or any tampering', () => {
  const sealed = sealString(KEY, 'invite', 'secret', 'event-1');
  assert.throws(() => openString(OTHER, 'invite', sealed, 'event-1'));
  assert.throws(() => openString(KEY, 'chat', sealed, 'event-1'));
  assert.throws(() => openString(KEY, 'invite', sealed, 'event-2'), /./, 'AAD binds the event');
  const raw = Buffer.from(sealed, 'base64');
  for (const i of [0, 13, raw.length - 1]) {
    const bad = Buffer.from(raw);
    bad[i] ^= 0x01;
    assert.throws(() => openString(KEY, 'invite', bad.toString('base64'), 'event-1'), /./, `flip byte ${i}`);
  }
  assert.throws(() => openString(KEY, 'invite', Buffer.alloc(20).toString('base64'), 'event-1'));
});

test('encryptGcm / decryptGcm with a separate iv (chat storage layout)', () => {
  const { iv, data } = encryptGcm(KEY, 'chat', Buffer.from('hello group'), 'event-9');
  assert.equal(iv.length, 12);
  assert.equal(decryptGcm(KEY, 'chat', iv, data, 'event-9').toString(), 'hello group');
  assert.throws(() => decryptGcm(KEY, 'chat', iv, data, 'event-8'));
});

test('constantTimeEqual', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
});
