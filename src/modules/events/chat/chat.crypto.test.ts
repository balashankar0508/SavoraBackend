import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { decryptChat, encryptChat } from './chat.crypto';

const KEY = randomBytes(32).toString('hex');
const [EVENT, OTHER_EVENT, MSG, OTHER_MSG] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

test('round trip: text, caption, emoji and unicode survive unchanged', () => {
  for (const content of [{ text: 'Are we ordering the cake today?' }, { text: '₹2,000 இன்று 🎂 "quotes" \ \n newline' }, { caption: '' }, { text: 'x'.repeat(2000) }]) {
    const { ciphertext, iv, key_version } = encryptChat(KEY, EVENT, MSG, content);
    assert.equal(key_version, 1);
    assert.deepEqual(decryptChat(KEY, EVENT, MSG, ciphertext, iv), content);
  }
});

test('ciphertext does not contain the plain text and differs every time (fresh IV)', () => {
  const a = encryptChat(KEY, EVENT, MSG, { text: 'secret plan' });
  const b = encryptChat(KEY, EVENT, MSG, { text: 'secret plan' });
  assert.ok(!a.ciphertext.includes(Buffer.from('secret plan')));
  assert.equal(a.iv.length, 12);
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test('tampering with the ciphertext, the tag or the IV is rejected', () => {
  const { ciphertext, iv } = encryptChat(KEY, EVENT, MSG, { text: 'pay rent' });
  const flip = (buf: Buffer, i: number) => { const c = Buffer.from(buf); c[i] ^= 0x80; return c; };
  assert.throws(() => decryptChat(KEY, EVENT, MSG, flip(ciphertext, 0), iv), 'first byte');
  assert.throws(() => decryptChat(KEY, EVENT, MSG, flip(ciphertext, ciphertext.length - 1), iv), 'last byte of the auth tag');
  assert.throws(() => decryptChat(KEY, EVENT, MSG, ciphertext, flip(iv, 3)), 'iv');
  assert.throws(() => decryptChat(KEY, EVENT, MSG, ciphertext.subarray(0, ciphertext.length - 1), iv), 'truncated');
  assert.throws(() => decryptChat(KEY, EVENT, MSG, Buffer.concat([ciphertext, Buffer.from([0])]), iv), 'extended');
  assert.throws(() => decryptChat(KEY, EVENT, MSG, Buffer.alloc(0), iv), 'empty');
});

test('a ciphertext cannot be replayed into another event or onto another message', () => {
  const { ciphertext, iv } = encryptChat(KEY, EVENT, MSG, { text: 'hello' });
  assert.throws(() => decryptChat(KEY, OTHER_EVENT, MSG, ciphertext, iv), 'other event');
  assert.throws(() => decryptChat(KEY, EVENT, OTHER_MSG, ciphertext, iv), 'other message');
});

test('the wrong key never decrypts', () => {
  const { ciphertext, iv } = encryptChat(KEY, EVENT, MSG, { text: 'hello' });
  assert.throws(() => decryptChat(randomBytes(32).toString('hex'), EVENT, MSG, ciphertext, iv));
});
