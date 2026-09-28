import { z } from "zod";

function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const encryptionKeySchema = z.string().min(40).refine((value) => {
  try { return Buffer.from(value, "base64").length === 32; } catch { return false; }
}, "base64 decode edildiğinde tam 32 byte olmalı");

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD_HASH: z.preprocess(blankToUndefined, z.string().min(20).optional()),
  ADMIN_PASSWORD: z.preprocess(blankToUndefined, z.string().min(8).optional()),
  SESSION_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(32),
  AUDIT_HASH_SECRET: z.string().min(32),
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/),
  META_REDIRECT_URI: z.string().url(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(16),
  META_SCOPES: z.string().default("pages_show_list,pages_read_engagement,pages_read_user_content,instagram_basic,instagram_manage_comments"),
  TOKEN_ENCRYPTION_KEY: encryptionKeySchema,
  TOKEN_ENCRYPTION_KEY_PREVIOUS: z.preprocess(blankToUndefined, encryptionKeySchema.optional()),
  LLM_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_FALLBACK_BASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  LLM_FALLBACK_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  LLM_FALLBACK_MODEL: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(4).default(2),
  SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SYNC_MAX_POSTS_PER_CONNECTION: z.coerce.number().int().min(10).max(1000).default(100),
  SYNC_MAX_COMMENTS_PER_PARENT: z.coerce.number().int().min(50).max(5000).default(1000),
  SYNC_CONNECTION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(6),
  SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  SYNC_LEASE_MS: z.coerce.number().int().min(60_000).max(7_200_000).default(1_800_000),
  WEBHOOK_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  ANALYSIS_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(8),
  ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ALERT_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  ALERT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  HEALTH_CHECK_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ALERT_WEBHOOK_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  ALERT_WEBHOOK_SECRET: z.preprocess(blankToUndefined, z.string().min(32).optional()),
  ALERT_SEVERITY_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
  ALERT_ON_THREAT: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  RETENTION_WEBHOOK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RETENTION_AUDIT_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  RETENTION_RAW_ITEM_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  RETENTION_ALERT_DAYS: z.coerce.number().int().min(7).max(3650).default(180),
});

let cached: z.infer<typeof serverEnvSchema> | null = null;

export function env() {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");
    throw new Error(`Ortam değişkenleri geçersiz: ${fields}`);
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.ADMIN_PASSWORD_HASH) {
    throw new Error("Production'da ADMIN_PASSWORD_HASH zorunludur; ADMIN_PASSWORD kullanmayın.");
  }
  if (parsed.data.ADMIN_PASSWORD_HASH && !parsed.data.ADMIN_PASSWORD_HASH.startsWith("scrypt$")) {
    throw new Error("ADMIN_PASSWORD_HASH geçerli scrypt formatında değil; npm run auth:hash kullanın.");
  }
  if (parsed.data.ALERT_WEBHOOK_URL && !parsed.data.ALERT_WEBHOOK_SECRET) {
    throw new Error("ALERT_WEBHOOK_URL tanımlıysa ALERT_WEBHOOK_SECRET (en az 32 karakter) zorunludur.");
  }
  const fallbackValues = [parsed.data.LLM_FALLBACK_BASE_URL, parsed.data.LLM_FALLBACK_API_KEY, parsed.data.LLM_FALLBACK_MODEL];
  const fallbackCount = fallbackValues.filter(Boolean).length;
  if (fallbackCount !== 0 && fallbackCount !== fallbackValues.length) {
    throw new Error("LLM fallback kullanılıyorsa LLM_FALLBACK_BASE_URL, LLM_FALLBACK_API_KEY ve LLM_FALLBACK_MODEL birlikte tanımlanmalıdır.");
  }
  const app = new URL(parsed.data.APP_URL);
  const callback = new URL(parsed.data.META_REDIRECT_URI);
  if (callback.origin !== app.origin || callback.pathname !== "/api/meta/callback") {
    throw new Error("META_REDIRECT_URI, APP_URL ile aynı origin'de /api/meta/callback olmalıdır.");
  }
  if (parsed.data.NODE_ENV === "production") {
    if (app.protocol !== "https:" || callback.protocol !== "https:") {
      throw new Error("Production'da APP_URL ve META_REDIRECT_URI HTTPS olmalıdır.");
    }
    if (parsed.data.ALERT_WEBHOOK_URL && new URL(parsed.data.ALERT_WEBHOOK_URL).protocol !== "https:") {
      throw new Error("Production'da ALERT_WEBHOOK_URL HTTPS olmalıdır.");
    }
  }
  cached = parsed.data;
  return cached;
}

export function appOrigin(): string {
  return new URL(env().APP_URL).origin;
}
