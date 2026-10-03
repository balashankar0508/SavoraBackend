import { z } from 'zod';
import { dateStr, paiseAmount, pageLimit, splitMode, timeStr, uuid } from '../shared/schemas';

const text = (max: number) => z.string().trim().max(max);

const splitInput = z.object({ user_id: uuid, value: z.number().int().min(0).max(1_000_000_000) }).strict();

const expenseFields = {
  title: text(120).min(1),
  category: text(40).min(1),
  amount_paise: paiseAmount,
  expense_date: dateStr,
  expense_time: timeStr.optional(),
  notes: text(1000).optional(),
  paid_by: uuid,
  split_mode: splitMode,
  splits: z.array(splitInput).min(1).max(100),
};

export const createExpenseSchema = z
  .object({ id: uuid, ...expenseFields, receipt_file_id: uuid.optional() })
  .strict();

/** A full replacement of the expense (the editor always sends everything).
 * receipt_file_id: omitted = keep, null = remove, uuid = replace. */
export const updateExpenseSchema = z
  .object({ ...expenseFields, receipt_file_id: uuid.nullable().optional(), version: z.number().int().positive().optional() })
  .strict();

export const listExpensesQuerySchema = z.object({
  limit: pageLimit(100, 20),
  cursor: z.string().max(300).optional(),
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(40).optional(),
});
