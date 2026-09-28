import { eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { socialConnections } from "@/db/schema";
import { decryptSecret, encryptSecret, secretNeedsRotation } from "@/lib/crypto";
import { debugToken } from "@/lib/meta";
import { env } from "@/lib/config";
import { mapLimit } from "@/lib/concurrency";

const REQUIRED: Record<string, string[]> = {
  facebook: ["pages_read_engagement", "pages_read_user_content"],
  instagram: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
};

export async function checkConnectionHealth(connection: typeof socialConnections.$inferSelect) {
  if (connection.status === "disabled") {
    return { id: connection.id, platform: connection.platform, status: "disabled", scopes: connection.grantedScopes, missingScopes: [], expiresAt: connection.tokenExpiresAt, skipped: true as const };
  }
  try {
    const token = decryptSecret(connection.encryptedAccessToken);
    const debug = await debugToken(token);
    const scopes = debug.scopes.length ? debug.scopes : connection.grantedScopes;
    const required = REQUIRED[connection.platform] || [];
    const missingScopes = required.filter((scope) => !scopes.includes(scope));
    const expiresSoon = Boolean(debug.expiresAt && debug.expiresAt.getTime() < Date.now() + 7 * 24 * 60 * 60 * 1000);
    const status = !debug.isValid ? "revoked" : (missingScopes.length || expiresSoon ? "degraded" : "active");
    const reasons = [
      ...missingScopes.map((s) => `missing_scope:${s}`),
      ...(expiresSoon ? ["token_expires_within_7_days"] : []),
      ...(!debug.isValid ? ["token_invalid"] : []),
    ];
    await db.update(socialConnections).set({
      encryptedAccessToken: secretNeedsRotation(connection.encryptedAccessToken) ? encryptSecret(token) : connection.encryptedAccessToken,
      grantedScopes: scopes,
      tokenExpiresAt: debug.expiresAt ?? connection.tokenExpiresAt,
      status,
      lastError: reasons.length ? reasons.join(", ") : null,
      healthCheckedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(socialConnections.id, connection.id));
    return { id: connection.id, platform: connection.platform, status, scopes, missingScopes, expiresAt: debug.expiresAt ?? connection.tokenExpiresAt };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
    await db.update(socialConnections).set({ status: "degraded", lastError: message, healthCheckedAt: new Date(), updatedAt: new Date() }).where(eq(socialConnections.id, connection.id));
    return { id: connection.id, platform: connection.platform, status: "degraded", scopes: connection.grantedScopes, missingScopes: [], error: message, expiresAt: connection.tokenExpiresAt };
  }
}

export async function checkAllConnections() {
  const connections = await db.select().from(socialConnections).where(ne(socialConnections.status, "disabled"));
  return mapLimit(connections, env().HEALTH_CHECK_CONCURRENCY, (connection) => checkConnectionHealth(connection));
}
