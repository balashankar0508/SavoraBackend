import { z } from 'zod';

export const parseReceiptSchema = z.object({
  // base64 of an image up to ~7 MB; the body limit for /ai is 10 MB
  image: z.string().min(1).max(10_000_000),
  // passed on to the AI provider, so only real image types are accepted
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
});
