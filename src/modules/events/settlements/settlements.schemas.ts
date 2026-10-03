import { z } from 'zod';
import { pageLimit, paiseAmount, paymentMethod, upiApp, uuid } from '../shared/schemas';

export const createSettlementSchema = z
  .object({
    id: uuid, // client-generated: makes a retried "Mark as paid" idempotent
    to_user: uuid,
    amount_paise: paiseAmount,
    method: paymentMethod,
    upi_app: upiApp.optional(),
    utr: z.string().trim().regex(/^[A-Za-z0-9]{6,64}$/, 'invalid_utr').optional(),
    proof_file_id: uuid.optional(),
  })
  .strict()
  .refine(v => !v.upi_app || v.method === 'upi', { message: 'upi_app_requires_upi_method', path: ['upi_app'] });

export const rejectSettlementSchema = z
  .object({ reason: z.string().trim().min(1).max(300).optional() })
  .strict();

export const listSettlementsQuerySchema = z.object({
  status: z.enum(['pending_confirmation', 'confirmed', 'rejected', 'cancelled']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: pageLimit(100, 20),
  cursor: z.string().max(300).optional(),
});

export const remindSchema = z
  .object({ target_user: uuid, kind: z.enum(['remind', 'request']) })
  .strict();

export const paymentProfileSchema = z
  .object({
    upi_id: z
      .string()
      .trim()
      .toLowerCase()
      .min(5)
      .max(120)
      .regex(/^[a-z0-9._-]{2,100}@[a-z0-9.-]{2,64}$/, 'invalid_upi_id'),
  })
  .strict();
