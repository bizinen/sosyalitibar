import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { socialConnections } from "@/db/schema";
import { decryptSecret, encryptSecret, secretNeedsRotation } from "@/lib/crypto";
import { debugToken, MetaApiError } from "@/lib/meta";
import { env } from "@/lib/config";
import { getMetaSettings } from "@/lib/meta-settings";
import { mapLimit } from "@/lib/concurrency";
import { safeErrorMessage } from "@/lib/log";

const REQUIRED: Record<string, string[]> = {
  facebook: ["pages_read_engagement", "pages_read_user_content", "pages_manage_metadata"],
  instagram: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"],
};

export async function checkConnectionHealth(connection: typeof socialConnections.$inferSelect) {
  if (connection.status === "disabled" || connection.status === "revoked") {
    return { id: connection.id, platform: connection.platform, status: connection.status, scopes: connection.grantedScopes, missingScopes: [], expiresAt: connection.tokenExpiresAt, skipped: true as const };
  }
  const current = and(eq(socialConnections.id, connection.id), inArray(socialConnections.status, ["active", "degraded"]),
    eq(socialConnections.encryptedAccessToken, connection.encryptedAccessToken));
  const syncError = sql`coalesce(${socialConnections.syncState}->>'syncError',
    case when ${socialConnections.lastError} like 'sync_error:%' then ${socialConnections.lastError} end)`;
  try {
    const token = decryptSecret(connection.encryptedAccessToken);
    const debug = await debugToken(token);
    const scopes = debug.scopes;
    const required = REQUIRED[connection.platform] || [];
    const missingScopes = required.filter((scope) => !scopes.includes(scope));
    const expiresAt = debug.expiresAt !== undefined ? debug.expiresAt : connection.tokenExpiresAt;
    const expired = Boolean(expiresAt && expiresAt.getTime() <= Date.now());
    const dataAccessExpired = Boolean(debug.dataAccessExpiresAt && debug.dataAccessExpiresAt.getTime() <= Date.now());
    const dataAccessExpiresSoon = Boolean(debug.dataAccessExpiresAt && debug.dataAccessExpiresAt.getTime() < Date.now() + 7 * 24 * 60 * 60 * 1000);
    const expiresSoon = Boolean(expiresAt && expiresAt.getTime() < Date.now() + 7 * 24 * 60 * 60 * 1000);
    const appMismatch = Boolean(debug.appId && debug.appId !== (await getMetaSettings()).META_APP_ID);
    const appUnknown = !debug.appId;
    const subscriptionMissing = connection.platform === "facebook" && !connection.webhookSubscribed;
    const status = !debug.isValid || expired || dataAccessExpired || appMismatch ? "revoked" : (missingScopes.length || expiresSoon || dataAccessExpiresSoon || appUnknown || subscriptionMissing ? "degraded" : "active");
    const reasons = [
      ...missingScopes.map((s) => `missing_scope:${s}`),
      ...(expiresSoon ? ["token_expires_within_7_days"] : []),
      ...(!debug.isValid ? ["token_invalid"] : []),
      ...(expired ? ["token_expired"] : []),
      ...(dataAccessExpired ? ["data_access_expired"] : dataAccessExpiresSoon ? ["data_access_expires_within_7_days"] : []),
      ...(appMismatch ? ["token_app_mismatch"] : []),
      ...(appUnknown ? ["token_app_identity_unavailable"] : []),
      ...(subscriptionMissing ? ["page_webhook_not_subscribed"] : []),
    ];
    const changed = await db.update(socialConnections).set({
      encryptedAccessToken: secretNeedsRotation(connection.encryptedAccessToken) ? encryptSecret(token) : connection.encryptedAccessToken,
      grantedScopes: scopes,
      tokenExpiresAt: expiresAt,
      status: sql`case when ${status} = 'active' and ${syncError} is not null then 'degraded' else ${status} end`,
      lastError: sql`nullif(concat_ws('; ', ${syncError}, ${reasons.length ? reasons.join(", ") : null}::text), '')`,
      syncState: sql`${socialConnections.syncState} || jsonb_build_object('healthError', ${reasons.length ? reasons.join(", ") : null}::text)`,
      healthCheckedAt: new Date(),
      updatedAt: new Date(),
    }).where(current).returning({ id: socialConnections.id, status: socialConnections.status });
    if (!changed.length) return { id: connection.id, platform: connection.platform, status: "superseded", scopes, missingScopes, expiresAt, skipped: true as const };
    return { id: connection.id, platform: connection.platform,
      status: changed[0]!.status,
      scopes, missingScopes, expiresAt };
  } catch (error) {
    const message = safeErrorMessage(error, 1000);
    const status = error instanceof MetaApiError && error.code === 190 ? "revoked" : "degraded";
    const changed = await db.update(socialConnections).set({ status,
      lastError: sql`concat_ws('; ', ${syncError}, ${message}::text)`,
      syncState: sql`${socialConnections.syncState} || jsonb_build_object('healthError', ${message}::text)`,
      healthCheckedAt: new Date(), updatedAt: new Date() }).where(current).returning({ id: socialConnections.id });
    if (!changed.length) return { id: connection.id, platform: connection.platform, status: "superseded", scopes: connection.grantedScopes, missingScopes: [], expiresAt: connection.tokenExpiresAt, skipped: true as const };
    return { id: connection.id, platform: connection.platform, status, scopes: connection.grantedScopes, missingScopes: [], error: message, expiresAt: connection.tokenExpiresAt };
  }
}

export async function checkAllConnections() {
  const connections = await db.select().from(socialConnections).where(inArray(socialConnections.status, ["active", "degraded"]));
  return mapLimit(connections, env().HEALTH_CHECK_CONCURRENCY, (connection) => checkConnectionHealth(connection));
}
