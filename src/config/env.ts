import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool.default(false),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  /**
   * Optional. With Redis: shared cache + BullMQ worker (`node dist/worker.js`).
   * Without it (unset or empty): no cache, and the API itself sends the
   * outbox events (invitation / password-reset emails) — no worker needed.
   */
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('school-management'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Absolute session lifetime from sign-in; rotation never extends it. */
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** A session not refreshed for this long must sign in again. */
  REFRESH_IDLE_DAYS: z.coerce.number().int().positive().default(7),
  INVITATION_TTL_HOURS: z.coerce.number().int().positive().default(72),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  /** Who issues subscription invoices and receipts (printed in the header of the PDFs). */
  /** Bill a student their class fees automatically when enrolled. Set to 'false' to turn it off. */
  FEES_AUTO_BILL: z.enum(['true', 'false']).default('true'),
  BILLING_ISSUER_NAME: z.string().default('Platform Billing'),
  BILLING_ISSUER_DETAILS: z.string().default(''),
  /** Days between issuing a subscription invoice and its due date. */
  BILLING_DUE_DAYS: z.coerce.number().int().min(0).max(120).default(14),

  APP_BASE_URL: z.string().url().default('http://localhost:8080'),
  MAIL_DRIVER: z.enum(['console', 'memory']).default('console'),
  MAIL_FROM: z.string().default('no-reply@example.com'),

  /** Where uploaded files live. `s3` is reserved for the S3-compatible driver (not built yet). */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./storage'),
  /** Encrypts sensitive fields at rest (bank account numbers). Required in production. */
  DATA_ENCRYPTION_KEY: z
    .string()
    .min(32, 'DATA_ENCRYPTION_KEY must be at least 32 characters')
    .optional(),

  SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().nonnegative().default(30),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  DOCS_ENABLED: bool.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.MAIL_DRIVER === 'memory') {
    throw new Error('MAIL_DRIVER=memory is only allowed in tests');
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.DATA_ENCRYPTION_KEY) {
    throw new Error('DATA_ENCRYPTION_KEY is required in production');
  }
  return parsed.data;
}
