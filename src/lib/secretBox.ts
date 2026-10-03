import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Small AES-256-GCM / HMAC helpers keyed from a 64-hex-char master secret.
 * A separate sub-key is derived per purpose label, so the same master secret
 * can safely serve the lookup hash and the encrypted copy of invite codes.
 */

const subKey = (masterHex: string, label: string): Buffer =>
  createHmac('sha256', Buffer.from(masterHex, 'hex')).update(`spenxo:${label}`).digest();

/** Deterministic keyed hash, used as a lookup key (e.g. invite code -> row). */
export function hmacHex(masterHex: string, label: string, value: string): string {
  return createHmac('sha256', subKey(masterHex, label)).update(value).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** AES-256-GCM. `aad` is authenticated but not stored (bind the event id here so a
 * ciphertext copied into another event fails to decrypt). Returns iv and ciphertext||tag. */
export function encryptGcm(masterHex: string, label: string, plaintext: Buffer | string, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', subKey(masterHex, label), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, data: Buffer.concat([body, cipher.getAuthTag()]) };
}

/** Throws if the key, iv, aad or ciphertext were tampered with. */
export function decryptGcm(masterHex: string, label: string, iv: Buffer, data: Buffer, aad: string): Buffer {
  if (data.length < 16) throw new Error('ciphertext_too_short');
  const decipher = createDecipheriv('aes-256-gcm', subKey(masterHex, label), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

/** Convenience for short strings stored in one text column: base64(iv || ciphertext || tag). */
export function sealString(masterHex: string, label: string, text: string, aad: string): string {
  const { iv, data } = encryptGcm(masterHex, label, text, aad);
  return Buffer.concat([iv, data]).toString('base64');
}

export function openString(masterHex: string, label: string, sealed: string, aad: string): string {
  const raw = Buffer.from(sealed, 'base64');
  return decryptGcm(masterHex, label, raw.subarray(0, 12), raw.subarray(12), aad).toString('utf8');
}
