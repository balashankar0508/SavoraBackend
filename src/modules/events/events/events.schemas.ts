import { z } from 'zod';
import { dateStr, eventType, joinPolicy, paiseAmount, uuid } from '../shared/schemas';

const text = (max: number) => z.string().trim().max(max);

export const createEventSchema = z
  .object({
    id: uuid, // client-generated: makes a retried create idempotent
    title: text(100).min(1),
    event_type: eventType.default('other'),
    start_date: dateStr,
    end_date: dateStr.optional(),
    location: text(120).optional(),
    budget_paise: paiseAmount.optional(), // the budget is optional
    description: text(1000).optional(),
    join_policy: joinPolicy.default('code'),
    allow_member_expenses: z.boolean().default(true),
    members_edit_others: z.boolean().default(false),
  })
  .strict()
  .refine(v => !v.end_date || v.end_date >= v.start_date, { message: 'end_date_before_start_date', path: ['end_date'] });

export const updateEventSchema = z
  .object({
    title: text(100).min(1).optional(),
    event_type: eventType.optional(),
    start_date: dateStr.optional(),
    end_date: dateStr.optional(),
    location: text(120).nullable().optional(),
    budget_paise: paiseAmount.nullable().optional(), // null removes the budget
    description: text(1000).nullable().optional(),
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'nothing_to_update' });

export const updateSettingsSchema = z
  .object({
    join_policy: joinPolicy.optional(),
    allow_member_expenses: z.boolean().optional(),
    members_edit_others: z.boolean().optional(),
  })
  .strict()
  .refine(v => Object.keys(v).length > 0, { message: 'nothing_to_update' });

export const duplicateEventSchema = z
  .object({ start_date: dateStr.optional(), end_date: dateStr.optional() })
  .strict()
  .refine(v => !v.end_date || !v.start_date || v.end_date >= v.start_date, { message: 'end_date_before_start_date' });

/** Deleting is irreversible, so the request must say so explicitly. */
export const deleteEventSchema = z.object({ confirm: z.literal(true) }).strict();

export const listEventsQuerySchema = z.object({
  status: z.enum(['active', 'completed', 'archived']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
