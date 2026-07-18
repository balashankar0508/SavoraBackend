import { z } from 'zod';

const categorySchema = z.enum([
  'Food',
  'Travel',
  'Shopping',
  'Bills',
  'Healthcare',
  'Entertainment',
  'Education',
  'Salary',
  'Freelance',
  'Investment',
  'Others',
]);

export const createTransactionSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.number().positive(),
  category: categorySchema,
  notes: z.string().max(2000).optional(),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  merchant_name: z.string().max(200).optional(),
  source: z.enum(['manual', 'upi_import', 'voice']).default('manual'),
});

export const updateTransactionSchema = createTransactionSchema.partial();

export const listTransactionsQuerySchema = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const summaryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});
