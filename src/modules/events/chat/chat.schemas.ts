import { z } from 'zod';
import { pageLimit, uuid } from '../shared/schemas';

export const MAX_TEXT = 2000;

export const sendMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    id: uuid, // client-generated: makes a retried send idempotent
    kind: z.literal('text'),
    text: z.string().trim().min(1).max(MAX_TEXT),
  }).strict(),
  z.object({
    id: uuid,
    kind: z.literal('attachment'),
    file_id: uuid, // an image uploaded with purpose "chat"
    caption: z.string().trim().max(500).optional(),
  }).strict(),
]);

/** Without `since`: the latest page (newest `limit` messages, oldest first); `before` pages back.
 * With `since`: everything created or deleted after that time, for cheap polling. */
export const listMessagesQuerySchema = z.object({
  limit: pageLimit(100, 50),
  before: z.string().max(300).optional(),
  since: z.string().datetime({ offset: true }).optional(),
});
