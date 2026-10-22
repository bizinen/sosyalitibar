import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, isNull, sql } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { db } from "@/lib/db";
import { auditLogs, metaSettings, metaAuthAccounts, socialConnections, oauthNonces } from "@/db/schema";
import { env } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { readResponseBody } from "@/lib/http-body";
import { getMetaSettings } from "@/lib/meta-settings";

const schema = z.object({
  appId: z.string().trim().regex(/^\d+$/).max(64),
  loginConfigId: z.string().trim().regex(/^\d*$/).max(64).optional(),
  appSecret: z.string().trim().max(4096).refine((v) => !v || v.length >= 16).optional(),
  verifyToken: z.string().trim().max(256).optional(),
  publicOrigin: z.string().trim().url().max(500),
  graphVersion: z.string().trim().regex(/^v\d+\.\d+$/).max(12),
  revision: z.number().int().min(0),
}).strict();

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const cfg = await getMetaSettings();
  return NextResponse.json({ verifyToken: cfg.META_WEBHOOK_VERIFY_TOKEN }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 8192))); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const value = parsed.data;
  const origin = new URL(value.publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || /^(localhost|127\.|\[::1\])/i.test(origin.hostname)) return NextResponse.json({ error: "public_https_required" }, { status: 400 });
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_meta_settings'))`);
      const [current] = await tx.select().from(metaSettings).where(eq(metaSettings.id, "primary")).for("update");
      if ((current?.revision ?? 0) !== value.revision) return "conflict";
      const previousId = current?.appId || env().META_APP_ID;
      if (previousId !== value.appId) {
        const [connection] = await tx.select({ id: socialConnections.id }).from(socialConnections).limit(1);
        const [owner] = await tx.select({ id: metaAuthAccounts.id }).from(metaAuthAccounts).limit(1);
        if (connection || owner) return "app_change_requires_disconnect";
        if (!value.appSecret) return "app_secret_required";
      }
      const secret = value.appSecret || (current ? decryptSecret(current.appSecretEncrypted) : env().META_APP_SECRET);
      const verifyToken = value.verifyToken || (current ? decryptSecret(current.verifyTokenEncrypted) : env().META_WEBHOOK_VERIFY_TOKEN);
      if (!secret || secret === "local-not-configured") return "app_secret_required";
      if (verifyToken.length < 16) return "verify_token_required";
      const fields = { appId: value.appId, loginConfigId: value.loginConfigId || null, appSecretEncrypted: encryptSecret(secret), verifyTokenEncrypted: encryptSecret(verifyToken), publicOrigin: origin.origin, graphVersion: value.graphVersion, revision: value.revision + 1, updatedAt: new Date() };
      if (current) await tx.update(metaSettings).set(fields).where(eq(metaSettings.id, "primary"));
      else await tx.insert(metaSettings).values({ id: "primary", ...fields });
      await tx.update(oauthNonces).set({ usedAt: new Date() }).where(isNull(oauthNonces.usedAt));
      await tx.insert(auditLogs).values({ actor: "admin", action: "meta.settings_updated", entityType: "meta_settings", entityId: "primary", metadata: { appId: value.appId, publicOrigin: origin.origin, graphVersion: value.graphVersion, revision: fields.revision, secretChanged: Boolean(value.appSecret), verifyTokenChanged: Boolean(value.verifyToken) } });
      return "saved";
    });
    return result === "saved" ? NextResponse.json({ saved: true, revision: value.revision + 1 }) : NextResponse.json({ error: result }, { status: result === "conflict" ? 409 : 400 });
  } catch { return NextResponse.json({ error: "settings_save_failed" }, { status: 500 }); }
}
