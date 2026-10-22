import { NextResponse } from "next/server";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertOutbox, auditLogs, authRateLimits, oauthNonces, socialItems, webhookEvents } from "@/db/schema";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { rotateStoredTokens } from "@/lib/token-rotation";

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

  const batchLimit = 1000;
  const retainedContext = sql`case when jsonb_typeof(${socialItems.raw}->'source_post') = 'object'
    then jsonb_build_object('source_post', jsonb_build_object('id', ${socialItems.raw}->'source_post'->'id',
      'text', ${socialItems.raw}->'source_post'->'text')) || case when ${socialItems.raw}->'context_incomplete' = 'true'::jsonb
        then jsonb_build_object('context_incomplete', true) else '{}'::jsonb end
    when ${socialItems.raw}->'context_incomplete' = 'true'::jsonb then jsonb_build_object('context_incomplete', true) else null end`;
  const oauth = await db.delete(oauthNonces).where(inArray(oauthNonces.id, db.select({ id: oauthNonces.id }).from(oauthNonces)
    .where(lt(oauthNonces.expiresAt, oauthCutoff)).orderBy(asc(oauthNonces.id)).limit(batchLimit).for("update", { skipLocked: true }))).returning({ id: oauthNonces.id });
  const rate = await db.delete(authRateLimits).where(inArray(authRateLimits.keyHash, db.select({ key: authRateLimits.keyHash }).from(authRateLimits)
    .where(lt(authRateLimits.updatedAt, rateCutoff)).orderBy(asc(authRateLimits.keyHash)).limit(batchLimit).for("update", { skipLocked: true }))).returning({ key: authRateLimits.keyHash });
  const webhooks = await db.delete(webhookEvents).where(inArray(webhookEvents.id, db.select({ id: webhookEvents.id }).from(webhookEvents)
    .where(and(eq(webhookEvents.status, "processed"), lt(webhookEvents.receivedAt, webhookCutoff))).orderBy(asc(webhookEvents.id)).limit(batchLimit).for("update", { skipLocked: true }))).returning({ id: webhookEvents.id });
  const audits = await db.delete(auditLogs).where(inArray(auditLogs.id, db.select({ id: auditLogs.id }).from(auditLogs)
    .where(lt(auditLogs.createdAt, auditCutoff)).orderBy(asc(auditLogs.id)).limit(batchLimit).for("update", { skipLocked: true }))).returning({ id: auditLogs.id });
  const rawItems = await db.update(socialItems).set({ raw: retainedContext, updatedAt: new Date() }).where(inArray(socialItems.id, db.select({ id: socialItems.id }).from(socialItems)
    .where(and(lt(socialItems.ingestedAt, rawCutoff), isNotNull(socialItems.raw), sql`${socialItems.raw} is distinct from ${retainedContext}`)).orderBy(asc(socialItems.id)).limit(batchLimit).for("update", { skipLocked: true }))).returning({ id: socialItems.id });
  const alerts = await db.delete(alertOutbox).where(inArray(alertOutbox.id, db.select({ id: alertOutbox.id }).from(alertOutbox)
    .where(and(inArray(alertOutbox.status, ["delivered", "dead", "cancelled"]), lt(alertOutbox.createdAt, alertCutoff))).orderBy(asc(alertOutbox.id)).limit(batchLimit).for("update", { skipLocked: true }))).returning({ id: alertOutbox.id });

  const tokenRotation = await rotateStoredTokens();
  const batchMayHaveMore = [oauth, rate, webhooks, audits, rawItems, alerts].some((rows) => rows.length === batchLimit);
  return NextResponse.json({ oauthNonces: oauth.length, rateLimits: rate.length, webhookEvents: webhooks.length, auditLogs: audits.length, rawItemsCleared: rawItems.length, alertOutbox: alerts.length, batchLimit, batchMayHaveMore, tokenRotation });
}
