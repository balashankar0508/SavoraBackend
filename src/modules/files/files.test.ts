import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDiskDriver } from './storage';
import { sniffImage } from './sniff';

function tmpDriver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spenxo-files-'));
  return { dir, driver: new LocalDiskDriver(path.join(dir, 'uploads')) };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

test('sniffImage recognises JPEG, PNG and WebP by magic bytes', () => {
  assert.deepEqual(sniffImage(JPEG), { mime: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(sniffImage(PNG), { mime: 'image/png', ext: 'png' });
  assert.deepEqual(sniffImage(WEBP), { mime: 'image/webp', ext: 'webp' });
});

test('sniffImage rejects everything else (the declared MIME type is never trusted)', () => {
  assert.equal(sniffImage(Buffer.from('%PDF-1.7 ...')), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html><body>hi</body></html>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  assert.equal(sniffImage(Buffer.from('RIFF....WAVEfmt ')), null); // RIFF but not WebP
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null); // truncated
});

test('LocalDiskDriver: put / exists / read / remove round-trip', async () => {
  const { dir, driver } = tmpDriver();
  try {
    const key = 'events/e1/f1.jpg';
    assert.equal(await driver.exists(key), false);
    await driver.put(key, JPEG);
    assert.equal(await driver.exists(key), true);

    const chunks: Buffer[] = [];
    for await (const chunk of driver.createReadStream(key)) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), JPEG);

    // no temp files left behind
    const left = fs.readdirSync(path.join(dir, 'uploads', 'events', 'e1'));
    assert.deepEqual(left, ['f1.jpg']);

    await driver.remove(key);
    assert.equal(await driver.exists(key), false);
    await driver.remove(key); // removing a missing file is not an error
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LocalDiskDriver: removePrefix deletes one event, leaves others and the root', async () => {
  const { dir, driver } = tmpDriver();
  try {
    await driver.put('events/e1/a.jpg', JPEG);
    await driver.put('events/e1/b.png', PNG);
    await driver.put('events/e2/c.webp', WEBP);
    await driver.removePrefix('events/e1');
    assert.equal(await driver.exists('events/e1/a.jpg'), false);
    assert.equal(await driver.exists('events/e1/b.png'), false);
    assert.equal(await driver.exists('events/e2/c.webp'), true);
    await driver.removePrefix('events/never-existed'); // no error
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LocalDiskDriver rejects path traversal and unsafe keys', async () => {
  const { dir, driver } = tmpDriver();
  try {
    const bad = [
      '../evil.jpg', 'events/../../evil.jpg', '/etc/passwd', 'events//x.jpg', 'events/./x.jpg',
      'events\\x.jpg', 'C:/windows/x.jpg', '', '.hidden', 'events/..', 'Events/Upper.jpg',
      'events/e1/a b.jpg', 'events/e1/a%2e%2e.jpg', 'events/e1/\u0000.jpg',
    ];
    for (const key of bad) {
      await assert.rejects(() => driver.put(key, JPEG), /invalid_storage_key/, `put ${JSON.stringify(key)}`);
      assert.equal(await driver.exists(key), false, `exists ${JSON.stringify(key)}`);
      assert.throws(() => driver.createReadStream(key), /invalid_storage_key/, `read ${JSON.stringify(key)}`);
    }
    // the root can never be wiped through removePrefix
    await assert.rejects(() => driver.removePrefix('.'), /invalid_storage_key/);
    // nothing escaped the uploads directory
    assert.deepEqual(fs.readdirSync(dir), ['uploads']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
