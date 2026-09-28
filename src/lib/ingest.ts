import crypto from "node:crypto";
import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertOutbox, connectionTargets, monitoringTargets, socialAnalyses, socialConnections, socialItems } from "@/db/schema";
import { analyzeComment, PROMPT_VERSION, type Analysis } from "@/lib/llm";
import { log } from "@/lib/log";
import { enqueueAlertIfNeeded } from "@/lib/alerts";

export type SocialItemInput = {
  connectionId?: string | null;
  platform: "facebook" | "instagram";
  externalId: string;
  parentExternalId?: string | null;
  rootExternalId?: string | null;
  itemType?: "comment" | "reply" | "mention";
  authorId?: string | null;
  authorName?: string | null;
  text: string;
  permalink?: string | null;
  sourceCreatedAt?: Date | null;
  raw?: unknown;
};

export async function upsertSocialItem(input: SocialItemInput) {
  return db.transaction(async (tx) => {
    const existing = await tx.query.socialItems.findFirst({
      where: and(eq(socialItems.platform, input.platform), eq(socialItems.externalId, input.externalId)),
    });
    const now = new Date();

    if (!existing) {
      const [created] = await tx.insert(socialItems).values({
        connectionId: input.connectionId ?? null,
        platform: input.platform,
        externalId: input.externalId,
        parentExternalId: input.parentExternalId ?? null,
        rootExternalId: input.rootExternalId ?? null,
        itemType: input.itemType ?? "comment",
        authorId: input.authorId ?? null,
        authorName: input.authorName ?? null,
        text: input.text,
        permalink: input.permalink ?? null,
        sourceCreatedAt: input.sourceCreatedAt ?? null,
        raw: input.raw as never,
        analysisStatus: "pending",
        analysisAvailableAt: now,
      }).returning();
      if (!created) throw new Error("social item oluşturulamadı");
      return { item: created, created: true, changed: true };
    }

    const changed = existing.text !== input.text;
    const [updated] = await tx.update(socialItems).set({
      connectionId: input.connectionId ?? existing.connectionId,
      parentExternalId: input.parentExternalId ?? existing.parentExternalId,
      rootExternalId: input.rootExternalId ?? existing.rootExternalId,
      itemType: input.itemType ?? existing.itemType,
      authorId: input.authorId ?? existing.authorId,
      authorName: input.authorName ?? existing.authorName,
      text: input.text,
      permalink: input.permalink ?? existing.permalink,
      sourceCreatedAt: input.sourceCreatedAt ?? existing.sourceCreatedAt,
      raw: input.raw as never,
      ...(changed ? {
        analysisStatus: "pending",
        analysisAttempts: 0,
        analysisAvailableAt: now,
        analysisLockedAt: null,
        analysisLockId: null,
        analysisError: null,
      } : {}),
      updatedAt: now,
    }).where(eq(socialItems.id, existing.id)).returning();
    if (changed) {
      await tx.delete(socialAnalyses).where(eq(socialAnalyses.itemId, existing.id));
      await tx.update(alertOutbox).set({
        status: "cancelled",
        lockedAt: null,
        lockId: null,
        lastError: "source text changed; superseded by re-analysis",
        updatedAt: now,
      }).where(and(eq(alertOutbox.itemId, existing.id), inArray(alertOutbox.status, ["pending", "retry"])));
    }
    return { item: updated ?? existing, created: false, changed };
  });
}

function deterministicEmptyAnalysis(): Analysis {
  return {
    target_match: false,
    target_confidence: 0,
    matched_target: null,
    sentiment: "neutral",
    category: "spam",
    severity: 0,
    contains_insult: false,
    contains_threat: false,
    contains_claim: false,
    claim_text: null,
    needs_review: false,
    summary: "Analiz edilecek anlamlı metin bulunamadı.",
  };
}

async function persistAnalysis(itemId: string, result: {
  data: Analysis;
  model: string;
  provider: string;
  promptVersion: string;
  inputHash: string;
  latencyMs: number;
  raw: Record<string, unknown>;
}) {
  const a = result.data;
  await db.insert(socialAnalyses).values({
    itemId,
    targetMatch: a.target_match,
    targetConfidence: a.target_confidence,
    matchedTarget: a.matched_target,
    sentiment: a.sentiment,
    category: a.category,
    severity: a.severity,
    containsInsult: a.contains_insult,
    containsThreat: a.contains_threat,
    containsClaim: a.contains_claim,
    claimText: a.claim_text,
    needsReview: a.needs_review,
    summary: a.summary,
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    inputHash: result.inputHash,
    latencyMs: result.latencyMs,
    raw: result.raw as never,
  }).onConflictDoUpdate({
    target: socialAnalyses.itemId,
    set: {
      targetMatch: a.target_match,
      targetConfidence: a.target_confidence,
      matchedTarget: a.matched_target,
      sentiment: a.sentiment,
      category: a.category,
      severity: a.severity,
      containsInsult: a.contains_insult,
      containsThreat: a.contains_threat,
      containsClaim: a.contains_claim,
      claimText: a.claim_text,
      needsReview: a.needs_review,
      summary: a.summary,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      inputHash: result.inputHash,
      latencyMs: result.latencyMs,
      raw: result.raw as never,
      analyzedAt: new Date(),
    },
  });
}

export async function analyzeClaimedItem(itemId: string, lockId: string) {
  const item = await db.query.socialItems.findFirst({
    where: and(eq(socialItems.id, itemId), eq(socialItems.analysisStatus, "processing"), eq(socialItems.analysisLockId, lockId)),
  });
  if (!item) return { processed: false as const, reason: "lost_lock" };
  if (item.deletedAt) {
    await db.update(socialItems).set({
      analysisStatus: "complete",
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: "source item deleted before analysis",
      updatedAt: new Date(),
    }).where(and(eq(socialItems.id, item.id), eq(socialItems.analysisLockId, lockId)));
    return { processed: true as const, reason: "deleted" };
  }

  try {
    if (item.text.trim().length < 2) {
      const data = deterministicEmptyAnalysis();
      await persistAnalysis(item.id, {
        data,
        model: "deterministic",
        provider: "local",
        promptVersion: PROMPT_VERSION,
        inputHash: crypto.createHash("sha256").update(item.text).digest("hex"),
        latencyMs: 0,
        raw: { output: data },
      });
    } else {
      const targets = await db.select().from(monitoringTargets).where(eq(monitoringTargets.enabled, true));
      let sourceTargets: string[] = [];
      let source: { platform?: string; accountName?: string | null; accountUsername?: string | null; itemType?: string } = {
        platform: item.platform,
        itemType: item.itemType,
      };
      if (item.connectionId) {
        const [connection, mapped] = await Promise.all([
          db.query.socialConnections.findFirst({ where: eq(socialConnections.id, item.connectionId) }),
          db.select({ name: monitoringTargets.name })
            .from(connectionTargets)
            .innerJoin(monitoringTargets, eq(connectionTargets.targetId, monitoringTargets.id))
            .where(and(eq(connectionTargets.connectionId, item.connectionId), eq(monitoringTargets.enabled, true))),
        ]);
        sourceTargets = mapped.map((row) => row.name);
        source = {
          platform: item.platform,
          accountName: connection?.displayName ?? null,
          accountUsername: connection?.username ?? null,
          itemType: item.itemType,
        };
      }
      const analyzed = await analyzeComment({
        text: item.text,
        targets: targets.map((t) => ({ name: t.name, aliases: t.aliases })),
        sourceTargets,
        source,
      });
      await persistAnalysis(item.id, analyzed);
      await enqueueAlertIfNeeded(item, analyzed.data, analyzed.inputHash);
    }
    await db.update(socialItems).set({
      analysisStatus: "complete",
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: null,
      updatedAt: new Date(),
    }).where(and(eq(socialItems.id, item.id), eq(socialItems.analysisLockId, lockId)));
    return { processed: true as const };
  } catch (error) {
    const attempts = item.analysisAttempts + 1;
    const dead = attempts >= 5;
    const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
    const message = error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200);
    await db.update(socialItems).set({
      analysisStatus: dead ? "dead" : "retry",
      analysisAttempts: attempts,
      analysisAvailableAt: dead ? new Date() : new Date(Date.now() + delayMs),
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: message,
      updatedAt: new Date(),
    }).where(and(eq(socialItems.id, item.id), eq(socialItems.analysisLockId, lockId)));
    log.warn("analysis.failed", { itemId: item.id, attempts, dead, message });
    return { processed: false as const, reason: dead ? "dead" : "retry" };
  }
}

export async function claimAnalysisJobs(limit = 20): Promise<Array<{ id: string; lockId: string }>> {
  const now = new Date();
  const candidates = await db.select({ id: socialItems.id }).from(socialItems).where(and(
    inArray(socialItems.analysisStatus, ["pending", "retry"]),
    lte(socialItems.analysisAvailableAt, now),
  )).orderBy(asc(socialItems.analysisAvailableAt), asc(socialItems.ingestedAt)).limit(Math.max(1, Math.min(limit * 2, 100)));

  const claimed: Array<{ id: string; lockId: string }> = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    const lockId = crypto.randomUUID();
    const [row] = await db.update(socialItems).set({
      analysisStatus: "processing",
      analysisLockedAt: now,
      analysisLockId: lockId,
      updatedAt: now,
    }).where(and(
      eq(socialItems.id, candidate.id),
      inArray(socialItems.analysisStatus, ["pending", "retry"]),
      lte(socialItems.analysisAvailableAt, now),
    )).returning({ id: socialItems.id });
    if (row) claimed.push({ id: row.id, lockId });
  }
  return claimed;
}

export async function requeueStaleAnalysisLocks(maxAgeMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const rows = await db.update(socialItems).set({
    analysisStatus: "retry",
    analysisLockedAt: null,
    analysisLockId: null,
    analysisAvailableAt: new Date(),
    analysisError: "stale analysis lock recovered",
    updatedAt: new Date(),
  }).where(and(eq(socialItems.analysisStatus, "processing"), lte(socialItems.analysisLockedAt, cutoff))).returning({ id: socialItems.id });
  return rows.length;
}
