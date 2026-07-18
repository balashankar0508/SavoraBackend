import { z } from 'zod';

export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  target_amount: z.number().positive(),
  current_amount: z.number().min(0).optional(),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const updateGoalSchema = createGoalSchema.partial();

export const contributeSchema = z.object({
  amount: z.number().positive(),
});
