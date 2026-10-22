import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { itemReviewEvents, socialAnalyses, socialConnections, socialItems } from "@/db/schema";
import { commentDisplay } from "@/lib/comment-display";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const revision = z.coerce.number().int().positive().safeParse(new URL(req.url).searchParams.get("revision"));
  if (!z.string().uuid().safeParse(id).success || !revision.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  return db.transaction(async (tx) => {
    const item = await tx.query.socialItems.findFirst({ where: eq(socialItems.id, id) });
    if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (item.analysisRevision !== revision.data) return NextResponse.json({ error: "source_changed" }, { status: 409 });
    const connection = item.connectionId ? await tx.query.socialConnections.findFirst({ where: eq(socialConnections.id, item.connectionId) }) : null;
    const analysis = await tx.query.socialAnalyses.findFirst({ where: eq(socialAnalyses.itemId, id) });
    const events = await tx.select().from(itemReviewEvents).where(eq(itemReviewEvents.itemId, id)).orderBy(desc(itemReviewEvents.sequence)).limit(101);
    return NextResponse.json({ format: "comment-record-v1", exportedAt: new Date().toISOString(),
      notice: "Uygulamada saklanan kayıt görüntüsüdür; platforma şikâyet gönderimi veya hukuki tespit değildir.",
      demo: Boolean(item.raw && typeof item.raw === "object" && "demo_seed" in item.raw),
      item: { id: item.id, platform: item.platform, account: connection?.displayName ?? null, externalId: item.externalId,
        authorId: item.authorId, authorName: item.authorName, text: item.text, permalink: item.permalink,
        sourceCreatedAt: item.sourceCreatedAt, ingestedAt: item.ingestedAt, updatedAt: item.updatedAt,
        analysisRevision: item.analysisRevision, deletedAt: item.deletedAt, sourceUnavailableAt: item.sourceUnavailableAt,
        reviewStatus: item.reviewStatus, source: commentDisplay(item.raw) },
      analysis: analysis ? { triageLabel: analysis.triageLabel, needsReview: analysis.needsReview, category: analysis.category, severity: analysis.severity, summary: analysis.summary,
        targetMatch: analysis.targetMatch, matchedTarget: analysis.matchedTarget, containsThreat: analysis.containsThreat,
        containsInsult: analysis.containsInsult, containsClaim: analysis.containsClaim, claimText: analysis.claimText,
        model: analysis.model, promptVersion: analysis.promptVersion, analyzedAt: analysis.analyzedAt } : null,
      reviewEvents: events.slice(0,100), historyTruncated: events.length > 100,
    }, { headers: { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="yorum-kaydi-${id}.json"` } });
  }, { isolationLevel: "repeatable read" });
}
