import { randomInt } from 'crypto';

// Crockford base32: no I, L, O, U, so codes are hard to mis-read or mis-type.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY = /^[0-9A-HJKMNP-TV-Z]{8}$/;

function randomChars(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** "SPX-7K4M-92QD": 8 random characters, about 40 bits. */
export function generateInviteCode(): string {
  const c = randomChars(8);
  return `SPX-${c.slice(0, 4)}-${c.slice(4)}`;
}

/** "TXN-8829-4410": settlement reference shown to users. */
export function generateReference(): string {
  const c = randomChars(8);
  return `TXN-${c.slice(0, 4)}-${c.slice(4)}`;
}

/**
 * Canonical 8-character body of an invite code, or null if it can't be one.
 * Case-insensitive; ignores spaces/dashes; the SPX prefix is optional; common
 * look-alikes are mapped the way Crockford base32 defines (O->0, I/L->1).
 */
export function normalizeInviteCode(input: string): string | null {
  let s = String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 11 && s.startsWith('SPX')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return BODY.test(s) ? s : null;
}

export function formatInviteCode(body: string): string {
  return `SPX-${body.slice(0, 4)}-${body.slice(4)}`;
}
