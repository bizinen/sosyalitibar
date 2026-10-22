import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, itemReviewEvents, monitoringTargets, socialAnalyses, socialItems } from "@/db/schema";
import { lockAnalysisContext } from "@/lib/analysis-state";
import { env } from "@/lib/config";
import { clientIp, hashIdentifier } from "@/lib/security";
import type { HumanAssessment } from "@/lib/review-contract";

export async function recordItemReview(id: string, input: {
  reviewStatus: string; expectedReviewStatus: string; analysisRevision: number;
  expectedReviewId?: string | null; assessment?: HumanAssessment; undoEventId?: string;
}, request?: Request) {
  return db.transaction(async (tx) => {
    await lockAnalysisContext(tx);
    const [item] = await tx.select().from(socialItems).where(eq(socialItems.id, id)).for("update");
    if (!item) return { error: "not_found" as const };
    const [latest] = await tx.select().from(itemReviewEvents).where(eq(itemReviewEvents.itemId, id))
      .orderBy(desc(itemReviewEvents.sequence)).limit(1);
    if (item.deletedAt || item.sourceUnavailableAt || item.analysisRevision !== input.analysisRevision
      || item.reviewStatus !== input.expectedReviewStatus
      || (input.expectedReviewId !== undefined && input.expectedReviewId !== (latest?.id ?? null))) {
      return { error: "review_conflict" as const };
    }
    let status = input.reviewStatus;
    let assessment = latest?.analysisRevision === item.analysisRevision ? latest.assessment : null;
    if (input.undoEventId) {
      if (!latest || latest.id !== input.undoEventId || latest.analysisRevision !== item.analysisRevision || latest.action === "undo") {
        return { error: "review_conflict" as const };
      }
      const [previous] = await tx.select().from(itemReviewEvents).where(and(eq(itemReviewEvents.itemId, id),
        sql`${itemReviewEvents.sequence} < ${latest.sequence}`))
        .orderBy(desc(itemReviewEvents.sequence)).limit(1);
      status = latest.previousStatus;
      assessment = previous?.analysisRevision === item.analysisRevision ? previous.assessment : null;
    } else if (input.assessment) {
      if (input.assessment.matchedTarget) {
        const [target] = await tx.select({ id: monitoringTargets.id }).from(monitoringTargets)
          .where(and(eq(monitoringTargets.name, input.assessment.matchedTarget), eq(monitoringTargets.enabled, true)));
        if (!target) return { error: "target_not_found" as const };
      }
      assessment = input.assessment;
    } else if (status === item.reviewStatus) {
      return { item, reviewEventId: latest?.id ?? null };
    }
    const [analysis] = await tx.select({ triageLabel: socialAnalyses.triageLabel, category: socialAnalyses.category, severity: socialAnalyses.severity,
      targetMatch: socialAnalyses.targetMatch, matchedTarget: socialAnalyses.matchedTarget,
      summary: socialAnalyses.summary, model: socialAnalyses.model, promptVersion: socialAnalyses.promptVersion,
      sentiment: socialAnalyses.sentiment, targetConfidence: socialAnalyses.targetConfidence, containsInsult: socialAnalyses.containsInsult,
      containsThreat: socialAnalyses.containsThreat, containsClaim: socialAnalyses.containsClaim, claimText: socialAnalyses.claimText,
      needsReview: socialAnalyses.needsReview, inputHash: socialAnalyses.inputHash, provider: socialAnalyses.provider,
    }).from(socialAnalyses).where(eq(socialAnalyses.itemId, id));
    const [updated] = await tx.update(socialItems).set({ reviewStatus: status, updatedAt: new Date() }).where(eq(socialItems.id, id)).returning();
    const [event] = await tx.insert(itemReviewEvents).values({ itemId: id, analysisRevision: item.analysisRevision,
      previousStatus: item.reviewStatus, reviewStatus: status, assessment, sourceText: item.text,
      llmSnapshot: analysis ?? null, action: input.undoEventId ? "undo" : input.assessment ? "correction" : "status",
      undoOf: input.undoEventId ?? null, actor: env().ADMIN_USERNAME,
    }).returning({ id: itemReviewEvents.id });
    await tx.insert(auditLogs).values({ actor: env().ADMIN_USERNAME, action: "social_item.review_status_changed",
      ipHash: request ? hashIdentifier(clientIp(request)) : null,
      entityType: "social_item", entityId: id, metadata: { reviewStatus: status, previousReviewStatus: item.reviewStatus,
        analysisRevision: item.analysisRevision, reviewEventId: event!.id, humanCorrection: Boolean(input.assessment), undoOf: input.undoEventId ?? null } });
    return { item: updated!, reviewEventId: event!.id };
  });
}
