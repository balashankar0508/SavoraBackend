import 'dotenv/config';
import path from 'path';
import { z } from 'zod';

const hex32 = (name: string) =>
  z.string().regex(/^[a-f0-9]{64}$/, `${name} must be 64 hex chars (openssl rand -hex 32)`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_PEPPER: z.string().min(32, 'JWT_REFRESH_PEPPER must be at least 32 chars'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  // Optional -- fallback for AI receipt parsing when Gemini is overloaded.
  // Leave unset to skip the fallback entirely (Gemini failures surface as-is).
  ANTHROPIC_API_KEY: z.string().optional(),
  MAIL_PROVIDER: z.enum(['brevo']).default('brevo'),
  BREVO_API_KEY: z.string().min(1, 'BREVO_API_KEY is required'),
  MAIL_FROM: z.string().min(1, 'MAIL_FROM is required'),
  CORS_ORIGIN: z.string().default('*'),
  // Events v2
  // Private directory for uploaded receipts/proofs/chat images. Must be outside
  // the web root and the repo; production: /var/lib/spenxo/uploads (mode 700).
  UPLOAD_DIR: z.string().min(1).default(path.join(process.cwd(), 'uploads')),
  // AES-256-GCM key for chat messages at rest.
  CHAT_ENCRYPTION_KEY: hex32('CHAT_ENCRYPTION_KEY'),
  // Keys the HMAC lookup hash and AES-GCM display copy of event invite codes.
  INVITE_CODE_KEY: hex32('INVITE_CODE_KEY'),
  // Optional: Firebase service-account JSON for push notifications. Unset = pushes are skipped.
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional().transform(v => (v ? v : undefined)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
