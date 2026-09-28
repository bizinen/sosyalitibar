import { eq, sql } from "drizzle-orm";
import { authRateLimits } from "@/db/schema";
import { db } from "@/lib/db";

const MAX_ATTEMPTS = 5;

export async function loginRateLimitState(keyHash: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const row = await db.query.authRateLimits.findFirst({ where: eq(authRateLimits.keyHash, keyHash) });
  if (!row?.blockedUntil || row.blockedUntil.getTime() <= Date.now()) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((row.blockedUntil.getTime() - Date.now()) / 1000)),
  };
}

/**
 * Single-statement UPSERT keeps counters correct when multiple app replicas receive
 * failed logins for the same key concurrently.
 */
export async function recordLoginFailure(keyHash: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO auth_rate_limits (key_hash, attempts, window_started_at, blocked_until, updated_at)
    VALUES (${keyHash}, 1, now(), NULL, now())
    ON CONFLICT (key_hash) DO UPDATE SET
      attempts = CASE
        WHEN auth_rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1
        ELSE auth_rate_limits.attempts + 1
      END,
      window_started_at = CASE
        WHEN auth_rate_limits.window_started_at <= now() - interval '15 minutes' THEN now()
        ELSE auth_rate_limits.window_started_at
      END,
      blocked_until = CASE
        WHEN auth_rate_limits.window_started_at <= now() - interval '15 minutes' THEN NULL
        WHEN auth_rate_limits.attempts + 1 >= ${MAX_ATTEMPTS} THEN now() + interval '15 minutes'
        WHEN auth_rate_limits.blocked_until > now() THEN auth_rate_limits.blocked_until
        ELSE NULL
      END,
      updated_at = now()
  `);
}

export async function clearLoginFailures(keyHash: string): Promise<void> {
  await db.delete(authRateLimits).where(eq(authRateLimits.keyHash, keyHash));
}
