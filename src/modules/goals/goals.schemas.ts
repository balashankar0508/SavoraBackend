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

export const addContributionSchema = z.object({
  amount: z.number().positive(),
  note: z.string().trim().max(500).optional(),
  contribution_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Used once by the app to upload history that predates server storage; those
  // amounts are already part of the goal's current_amount.
  backfill: z.boolean().optional(),
});
