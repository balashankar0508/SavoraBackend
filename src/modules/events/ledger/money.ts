import { LedgerError } from './errors';

/** Largest single amount: INR 1,00,00,000 expressed in paise. */
export const MAX_PAISE = 1_000_000_000;

export function isValidPaise(value: unknown, { allowZero = false } = {}): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value <= MAX_PAISE &&
    (allowZero ? value >= 0 : value > 0)
  );
}

export function assertPaise(value: unknown, opts?: { allowZero?: boolean }): number {
  if (!isValidPaise(value, opts)) throw new LedgerError('invalid_amount');
  return value;
}

/** "100.01" -> 10001. Rejects more than two decimals, signs, separators, exponents. */
export function parseRupees(input: string): number {
  const trimmed = input.trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(trimmed)) throw new LedgerError('invalid_amount');
  const [whole, fraction = ''] = trimmed.split('.');
  return assertPaise(Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}

/** 123456789 -> "₹12,34,567.89" (Indian digit grouping, no ICU dependency). */
export function formatINR(paise: number, { symbol = true } = {}): string {
  if (!Number.isSafeInteger(paise)) throw new LedgerError('invalid_amount');
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const fraction = String(abs % 100).padStart(2, '0');
  const lastThree = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${grouped}.${fraction}`;
}
