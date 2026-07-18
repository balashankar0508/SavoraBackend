import { z } from 'zod';

export const parseReceiptSchema = z.object({
  image: z.string().min(1),
  mimeType: z.string().default('image/jpeg'),
});
