import { z } from 'zod';
import { MAX_PAISE } from '../ledger';

export const uuid = z.string().uuid();

/** YYYY-MM-DD, a real calendar day, between 2000 and 2100. */
export const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(s => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'invalid_date')
  .refine(s => s >= '2000-01-01' && s <= '2100-12-31', 'date_out_of_range');

export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const paiseAmount = z.number().int().positive().max(MAX_PAISE);

export const eventType = z.enum(['trip', 'birthday', 'dinner', 'wedding', 'other']);
export const joinPolicy = z.enum(['admins_only', 'code', 'code_approval']);
export const splitMode = z.enum(['equal', 'exact', 'percentage', 'shares']);
export const paymentMethod = z.enum(['upi', 'bank', 'cash', 'other']);
export const upiApp = z.enum(['gpay', 'phonepe', 'paytm', 'bhim', 'other']);

/** Escapes % _ \ so user text can't act as a LIKE wildcard. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
}

export function pageLimit(max = 100, fallback = 20) {
  return z.coerce.number().int().min(1).max(max).default(fallback);
}
