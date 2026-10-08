import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { sanitizeImage } from './sanitize';
import { HttpError } from '../../lib/httpError';

const JPG = { mime: 'image/jpeg', ext: 'jpg' } as const;

/** A 40x20 photo that says "rotate 90°" and carries GPS and phone details, like a real camera photo. */
async function cameraPhoto(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: '#3366cc' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: 'PhoneMaker', Model: 'Phone 15' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 4/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '80/1 16/1 0/1' },
    })
    .toBuffer();
}

test('sanitizeImage removes all metadata (GPS, phone model) and keeps the photo upright', async () => {
  const input = await cameraPhoto();
  const before = await sharp(input).metadata();
  assert.ok(before.exif, 'the test photo really has EXIF');
  assert.equal(before.orientation, 6);
  assert.ok(input.includes(Buffer.from('Phone 15')));

  const out = await sanitizeImage(input, JPG);
  const after = await sharp(out).metadata();
  assert.equal(after.exif, undefined);
  assert.equal(after.orientation, undefined);
  assert.ok(!out.includes(Buffer.from('Phone 15')) && !out.includes(Buffer.from('PhoneMaker')));
  assert.deepEqual([after.width, after.height], [20, 40], 'rotation applied to the pixels');
});

test('sanitizeImage keeps PNG and WebP in their own format', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00000000' } }).png().toBuffer();
  assert.equal((await sharp(await sanitizeImage(png, { mime: 'image/png', ext: 'png' })).metadata()).format, 'png');
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).webp().toBuffer();
  assert.equal((await sharp(await sanitizeImage(webp, { mime: 'image/webp', ext: 'webp' })).metadata()).format, 'webp');
});

test('sanitizeImage refuses a file that only looks like a JPEG', async () => {
  const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<script>not an image</script>')]);
  await assert.rejects(sanitizeImage(fake, JPG), (err: unknown) => err instanceof HttpError && err.code === 'unsupported_file_type');
});

test('sanitizeImage shrinks very large images to 2560 px on the long side', async () => {
  const big = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const meta = await sharp(await sanitizeImage(big, JPG)).metadata();
  assert.deepEqual([meta.width, meta.height], [2560, 640]);
});
