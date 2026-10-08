import sharp from 'sharp';
import { HttpError } from '../../lib/httpError';
import { SniffedImage } from './sniff';

/** Longest side kept. Receipts and chat photos stay sharp; nothing larger is needed. */
const MAX_SIDE = 2560;
/** Refuses "decompression bombs": a small file that would expand to a huge bitmap. */
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Re-encodes an uploaded image so only pixels are stored. Every piece of metadata is dropped
 * (EXIF GPS location, camera and phone model, timestamps, embedded thumbnails, comments), the
 * EXIF rotation is applied to the pixels first so the photo still shows the right way up, and
 * anything that does not decode as a real image is refused.
 */
export async function sanitizeImage(buffer: Buffer, kind: SniffedImage): Promise<Buffer> {
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate() // apply the EXIF orientation, then forget it
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    // sharp writes no metadata unless asked to (withMetadata), so the output carries none
    if (kind.ext === 'png') return await image.png({ compressionLevel: 9 }).toBuffer();
    if (kind.ext === 'webp') return await image.webp({ quality: 85 }).toBuffer();
    return await image.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  } catch {
    throw new HttpError(415, 'unsupported_file_type');
  }
}
