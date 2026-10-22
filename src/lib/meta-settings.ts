import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { metaSettings } from "@/db/schema";
import { env } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";

export const META_REQUIRED_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_read_user_content", "pages_manage_metadata", "instagram_basic", "instagram_manage_comments"];

export async function getMetaSettings() {
  const [row] = await db.select().from(metaSettings).where(eq(metaSettings.id, "primary"));
  const defaults = env();
  const publicOrigin = row?.publicOrigin || new URL(defaults.APP_URL).origin;
  return {
    ...defaults,
    META_APP_ID: row?.appId || defaults.META_APP_ID,
    metaLoginConfigId: row?.loginConfigId ?? "",
    META_APP_SECRET: row ? decryptSecret(row.appSecretEncrypted) : defaults.META_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN: row ? decryptSecret(row.verifyTokenEncrypted) : defaults.META_WEBHOOK_VERIFY_TOKEN,
    META_GRAPH_VERSION: row?.graphVersion || defaults.META_GRAPH_VERSION,
    META_SCOPES: [...new Set([...META_REQUIRED_SCOPES, ...defaults.META_SCOPES.split(",").map((v) => v.trim()).filter(Boolean)])].join(","),
    META_REDIRECT_URI: new URL("/api/meta/callback", publicOrigin).toString(),
    metaPublicOrigin: publicOrigin,
    metaSettingsRevision: row?.revision ?? 0,
  };
}
