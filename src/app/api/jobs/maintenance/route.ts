import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertOutbox, auditLogs, authRateLimits, oauthNonces, socialItems, webhookEvents } from "@/db/schema";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const cfg = env();
  if (!safeEqual(auth, `Bearer ${cfg.CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const oauthCutoff = new Date(now - 2 * day);
  const rateCutoff = new Date(now - 2 * day);
  const webhookCutoff = new Date(now - cfg.RETENTION_WEBHOOK_DAYS * day);
  const auditCutoff = new Date(now - cfg.RETENTION_AUDIT_DAYS * day);
  const rawCutoff = new Date(now - cfg.RETENTION_RAW_ITEM_DAYS * day);
  const alertCutoff = new Date(now - cfg.RETENTION_ALERT_DAYS * day);

  const oauth = await db.delete(oauthNonces).where(lt(oauthNonces.expiresAt, oauthCutoff)).returning({ id: oauthNonces.id });
  const rate = await db.delete(authRateLimits).where(lt(authRateLimits.updatedAt, rateCutoff)).returning({ key: authRateLimits.keyHash });
  const webhooks = await db.delete(webhookEvents).where(and(eq(webhookEvents.status, "processed"), lt(webhookEvents.receivedAt, webhookCutoff))).returning({ id: webhookEvents.id });
  const audits = await db.delete(auditLogs).where(lt(auditLogs.createdAt, auditCutoff)).returning({ id: auditLogs.id });
  const rawItems = await db.update(socialItems).set({ raw: null, updatedAt: new Date() }).where(and(lt(socialItems.ingestedAt, rawCutoff), isNotNull(socialItems.raw))).returning({ id: socialItems.id });
  const alerts = await db.delete(alertOutbox).where(and(inArray(alertOutbox.status, ["delivered", "dead", "cancelled"]), lt(alertOutbox.createdAt, alertCutoff))).returning({ id: alertOutbox.id });

  return NextResponse.json({ oauthNonces: oauth.length, rateLimits: rate.length, webhookEvents: webhooks.length, auditLogs: audits.length, rawItemsCleared: rawItems.length, alertOutbox: alerts.length });
}
