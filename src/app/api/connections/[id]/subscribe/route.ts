import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { socialConnections } from "@/db/schema";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { metaConfigured } from "@/lib/config";
import { getMetaSettings } from "@/lib/meta-settings";
import { decryptSecret } from "@/lib/crypto";
import { subscribeFacebookPage } from "@/lib/meta";
import { checkConnectionHealth } from "@/lib/connection-health";
import { audit } from "@/lib/audit";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  if (!metaConfigured(await getMetaSettings())) return NextResponse.json({ error: "meta_not_configured" }, { status: 503 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const initial = await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, id) });
  if (!initial) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (initial.platform !== "facebook") return NextResponse.json({ error: "unsupported_platform" }, { status: 409 });
  if (initial.status === "disabled") return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  if (initial.status === "revoked") return NextResponse.json({ error: "reauthorization_required" }, { status: 409 });
  try {
    const health = await checkConnectionHealth(initial);
    if (health.status === "revoked") return NextResponse.json({ error: "reauthorization_required" }, { status: 409 });
    if (health.status === "superseded") return NextResponse.json({ error: "connection_changed_retry" }, { status: 409 });
    if ("error" in health || health.missingScopes.length) return NextResponse.json({ error: "connection_health_failed" }, { status: 409 });
    const current = await db.query.socialConnections.findFirst({ where: and(eq(socialConnections.id, id), inArray(socialConnections.status, ["active", "degraded"])) });
    if (!current) return NextResponse.json({ error: "connection_changed_retry" }, { status: 409 });
    if (current.lastError?.includes("token_app_identity_unavailable")) return NextResponse.json({ error: "connection_health_failed" }, { status: 409 });
    const subscribed = await subscribeFacebookPage(current.externalAccountId, decryptSecret(current.encryptedAccessToken));
    const [saved] = await db.update(socialConnections).set({
      webhookSubscribed: subscribed, status: "degraded", healthCheckedAt: null,
      lastError: subscribed ? "subscription restored; health refresh pending" : "Page webhook subscription failed", updatedAt: new Date(),
    }).where(and(eq(socialConnections.id, id), inArray(socialConnections.status, ["active", "degraded"]),
      eq(socialConnections.encryptedAccessToken, current.encryptedAccessToken))).returning();
    if (!saved) return NextResponse.json({ error: "connection_changed_retry" }, { status: 409 });
    await audit({ request: req, actor: "admin", action: subscribed ? "connection.webhook_restored" : "connection.webhook_restore_failed", entityType: "social_connection", entityId: id });
    if (!subscribed) return NextResponse.json({ error: "subscription_failed" }, { status: 502 });
    const refreshed = await checkConnectionHealth(saved);
    return NextResponse.json({ ok: true, status: refreshed.status });
  } catch {
    return NextResponse.json({ error: "subscription_restore_failed" }, { status: 502 });
  }
}
