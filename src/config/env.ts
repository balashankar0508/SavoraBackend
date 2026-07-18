import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_PEPPER: z.string().min(32, 'JWT_REFRESH_PEPPER must be at least 32 chars'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  MAIL_PROVIDER: z.enum(['brevo']).default('brevo'),
  BREVO_API_KEY: z.string().min(1, 'BREVO_API_KEY is required'),
  MAIL_FROM: z.string().min(1, 'MAIL_FROM is required'),
  CORS_ORIGIN: z.string().default('*'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
