import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { alertOutbox, auditLogs, itemReviewEvents, itemTranslations, monitoringTargets, socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { getAiPolicy } from "@/lib/ai-policy";
import { translationPromptHash } from "@/lib/translation";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const { policy } = await getAiPolicy();
  return db.transaction(async (tx) => {
  const item = await tx.query.socialItems.findFirst({ where: eq(socialItems.id, id) });
  if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const before = new URL(req.url).searchParams.get("before");
  if (before && !z.string().uuid().safeParse(before).success) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  const cursor = before ? await tx.query.itemReviewEvents.findFirst({ where: and(eq(itemReviewEvents.id, before), eq(itemReviewEvents.itemId, id)) }) : undefined;
  if (before && !cursor) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  const [events, latest, alerts, translations, targets, legacy] = await Promise.all([
    tx.select().from(itemReviewEvents).where(and(eq(itemReviewEvents.itemId, id), cursor
      ? sql`${itemReviewEvents.sequence} < ${cursor.sequence}` : undefined))
      .orderBy(desc(itemReviewEvents.sequence)).limit(51),
    tx.select().from(itemReviewEvents).where(eq(itemReviewEvents.itemId, id)).orderBy(desc(itemReviewEvents.sequence)).limit(1),
    tx.select({ id: alertOutbox.id, status: alertOutbox.status, lastError: alertOutbox.lastError,
      deliveredAt: alertOutbox.deliveredAt, availableAt: alertOutbox.availableAt }).from(alertOutbox)
      .where(and(eq(alertOutbox.itemId, id), eq(alertOutbox.analysisRevision, item.analysisRevision))).orderBy(desc(alertOutbox.createdAt)).limit(10),
    tx.select({ text: itemTranslations.text, model: itemTranslations.model }).from(itemTranslations)
      .where(and(eq(itemTranslations.itemId, id), eq(itemTranslations.analysisRevision, item.analysisRevision), eq(itemTranslations.targetLanguage, "tr"), eq(itemTranslations.promptHash, translationPromptHash(policy)), sql`${itemTranslations.lockId} is null`)),
    tx.select({ name: monitoringTargets.name }).from(monitoringTargets).where(eq(monitoringTargets.enabled, true)),
    tx.select({ id: auditLogs.id, createdAt: auditLogs.createdAt, metadata: auditLogs.metadata }).from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "social_item.review_status_changed"), sql`${auditLogs.metadata}->>'reviewEventId' is null`))
      .orderBy(desc(auditLogs.createdAt)).limit(30),
  ]);
  return NextResponse.json({ analysisRevision: item.analysisRevision, reviewStatus: item.reviewStatus,
    latest: latest[0] ?? null, events: events.slice(0, 50), nextCursor: events.length > 50 ? events[49]!.id : null,
    alerts, translation: translations[0] ?? null, targets, legacy }, { headers: { "Cache-Control": "no-store" } });
  }, { isolationLevel: "repeatable read" });
}
