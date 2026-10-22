import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import { alertOutbox, connectionTargets, monitoringTargets, socialAnalyses, socialConnections, socialItems, watchedVideos } from "@/db/schema";
import { analyzeComment, type AnalyzeCommentInput, type LlmResult } from "@/lib/llm";
import { createBatchAnalyzer, type TriageResult } from "@/lib/batch-triage";
import type { getLlmSettings } from "@/lib/llm-settings";
import { mapLimit } from "@/lib/concurrency";
import { log, safeErrorMessage } from "@/lib/log";
import { invalidateAnalyses, lockAnalysisContext } from "@/lib/analysis-state";
import { enqueueAlertIfNeeded } from "@/lib/alerts";

export type SocialItemInput = {
  connectionId?: string | null;
  platform: "facebook" | "instagram" | "youtube";
  externalId: string;
  parentExternalId?: string | null;
  rootExternalId?: string | null;
  itemType?: "comment" | "reply" | "mention";
  authorId?: string | null;
  authorName?: string | null;
  text: string;
  permalink?: string | null;
  sourceCreatedAt?: Date | null;
  sourceReadVersion?: number;
  analysisExcluded?: boolean;
  raw?: unknown;
};

export async function beginSourceRead(): Promise<number> {
  const rows = await db.execute(sql`select nextval('social_item_source_read_seq')::text as version`);
  const version = Number(rows[0]?.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("source read version invalid");
  return version;
}

function sourcePostText(raw: unknown, rootId: string | null | undefined): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const post = (raw as Record<string, unknown>).source_post;
  if (!post || typeof post !== "object" || Array.isArray(post)) return null;
  const context = post as Record<string, unknown>;
  return context.id === rootId && typeof context.text === "string" ? context.text : null;
}

export async function upsertSocialItem(input: SocialItemInput, assertOwnership?: (tx: Transaction) => Promise<void>) {
  if (typeof input.externalId !== "string" || !input.externalId.trim() || typeof input.text !== "string") {
    throw new Error("source item identity or text invalid");
  }
  if (input.parentExternalId === input.externalId) throw new Error("source item cannot be its own parent");
  const sourceReadVersion = input.sourceReadVersion ?? await beginSourceRead();
  if (!Number.isSafeInteger(sourceReadVersion) || sourceReadVersion < 1) throw new Error("source read version invalid");
  return db.transaction(async (tx) => {
    await lockAnalysisContext(tx, true);
    if (input.rootExternalId) {
      const [removed] = await tx.select({ id: watchedVideos.id }).from(watchedVideos).where(and(
        eq(watchedVideos.platform, input.platform), eq(watchedVideos.externalId, input.rootExternalId),
        eq(watchedVideos.status, "removed"), sql`${watchedVideos.purgedAt} is not null`,
      ));
      if (removed) return { item: null, created: false, changed: false, suppressed: true };
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.platform}), hashtext(${input.externalId}))`);
    const [existing] = await tx.select().from(socialItems).where(and(
      eq(socialItems.platform, input.platform), eq(socialItems.externalId, input.externalId),
    )).for("update");
    await assertOwnership?.(tx);
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
        sourceReadVersion,
        sourceCheckedAt: now,
        raw: input.raw as never,
        analysisExcluded: input.analysisExcluded ?? false,
        analysisStatus: input.analysisExcluded ? "complete" : "pending",
        analysisAvailableAt: now,
      }).returning();
      if (!created) throw new Error("social item oluşturulamadı");
      await invalidateAnalyses(tx, and(eq(socialItems.platform, input.platform), eq(socialItems.parentExternalId, input.externalId)));
      return { item: created, created: true, changed: true };
    }

    if (existing.deletedAt) return { item: existing, created: false, changed: false };
    if (existing.sourceReadVersion >= sourceReadVersion) return { item: existing, created: false, changed: false };
    const incomingRaw = input.raw && typeof input.raw === "object" && !Array.isArray(input.raw) ? input.raw as Record<string, unknown> : undefined;
    const previousRaw = existing.raw && typeof existing.raw === "object" && !Array.isArray(existing.raw) ? existing.raw as Record<string, unknown> : undefined;
    let raw = incomingRaw && incomingRaw.source_post === undefined && previousRaw?.source_post !== undefined
      && (input.rootExternalId ?? existing.rootExternalId) === existing.rootExternalId
      ? { ...incomingRaw, source_post: previousRaw.source_post } : input.raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && previousRaw?.watched_video_id
      && incomingRaw?.watched_video_id === undefined && (input.rootExternalId ?? existing.rootExternalId) === existing.rootExternalId) {
      raw = { ...raw, watched_video_id: previousRaw.watched_video_id, external_source: previousRaw.external_source, source_channel: previousRaw.source_channel };
    }
    const changed = Boolean(existing.sourceUnavailableAt) || existing.text !== input.text || Boolean(input.connectionId && input.connectionId !== existing.connectionId)
      || Boolean(input.parentExternalId && input.parentExternalId !== existing.parentExternalId)
      || Boolean(input.itemType && input.itemType !== existing.itemType)
      || Boolean(input.rootExternalId && input.rootExternalId !== existing.rootExternalId)
      || (incomingRaw !== undefined && Boolean(incomingRaw.context_incomplete) !== Boolean(previousRaw?.context_incomplete))
      || (raw !== undefined && Boolean((raw as Record<string, unknown>)?.external_source) !== Boolean(previousRaw?.external_source))
      || (raw !== undefined && sourcePostText(raw, input.rootExternalId ?? existing.rootExternalId) !== sourcePostText(existing.raw, existing.rootExternalId));
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
      sourceReadVersion,
      sourceCheckedAt: now,
      sourceUnavailableAt: null,
      raw: raw as never,
      ...(changed ? {
        reviewStatus: "new",
        analysisStatus: existing.analysisExcluded ? "complete" : "pending",
        analysisRevision: existing.analysisRevision + 1,
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
      }).where(and(eq(alertOutbox.itemId, existing.id), sql`(${alertOutbox.status} in ('pending', 'retry', 'dead') or (${alertOutbox.status} = 'processing' and ${alertOutbox.dispatchStartedAt} is null))`));
      await invalidateAnalyses(tx, and(eq(socialItems.platform, input.platform), eq(socialItems.parentExternalId, input.externalId)));
    }
    return { item: updated ?? existing, created: false, changed };
  });
}

export async function markSourceUnavailable(itemId: string, sourceReadVersion: number, assertOwnership: (tx: Transaction) => Promise<void>) {
  if (!Number.isSafeInteger(sourceReadVersion) || sourceReadVersion < 1) throw new Error("source read version invalid");
  return db.transaction(async (tx) => {
    await lockAnalysisContext(tx, true);
    const [item] = await tx.select().from(socialItems).where(eq(socialItems.id, itemId)).for("update");
    await assertOwnership(tx);
    if (!item || item.deletedAt || item.sourceReadVersion >= sourceReadVersion) return;
    if (!item.sourceUnavailableAt) await invalidateAnalyses(tx, and(eq(socialItems.platform, item.platform),
      sql`(${socialItems.id} = ${item.id} or ${socialItems.parentExternalId} = ${item.externalId})`));
    await tx.update(socialItems).set({ sourceReadVersion, sourceCheckedAt: new Date(),
      sourceUnavailableAt: item.sourceUnavailableAt ?? new Date(), analysisStatus: "complete",
      analysisLockedAt: null, analysisLockId: null, analysisError: "Meta source unavailable; deletion not confirmed", updatedAt: new Date(),
    }).where(eq(socialItems.id, item.id));
  });
}

async function persistAnalysis(item: typeof socialItems.$inferSelect, lockId: string, result: LlmResult | TriageResult) {
  return db.transaction(async (tx) => {
  await lockAnalysisContext(tx);
  const [owned] = await tx.update(socialItems).set({
    analysisStatus: "complete", analysisLockedAt: null, analysisLockId: null,
    analysisError: null, updatedAt: new Date(),
  }).where(and(eq(socialItems.id, item.id), eq(socialItems.analysisLockId, lockId),
    eq(socialItems.analysisStatus, "processing"), eq(socialItems.analysisRevision, item.analysisRevision)))
    .returning({ id: socialItems.id });
  if (!owned) return false;
  const label = "label" in result.data ? result.data.label : null;
  const a = "label" in result.data ? null : result.data;
  await tx.insert(socialAnalyses).values({
    itemId: item.id,
    targetMatch: a?.target_match ?? null,
    targetConfidence: a?.target_confidence ?? null,
    matchedTarget: a?.matched_target ?? null,
    sentiment: a?.sentiment ?? null,
    category: a?.category ?? null,
    severity: a?.severity ?? null,
    containsInsult: a?.contains_insult ?? null,
    containsThreat: a?.contains_threat ?? null,
    containsClaim: a?.contains_claim ?? null,
    claimText: a?.claim_text ?? null,
    needsReview: label ? label !== "inceleme_gerekmiyor" : a!.needs_review,
    summary: a?.summary ?? null,
    triageLabel: label,
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    inputHash: result.inputHash,
    latencyMs: result.latencyMs,
    raw: result.raw as never,
  }).onConflictDoUpdate({
    target: socialAnalyses.itemId,
    set: {
      targetMatch: a?.target_match ?? null,
      targetConfidence: a?.target_confidence ?? null,
      matchedTarget: a?.matched_target ?? null,
      sentiment: a?.sentiment ?? null,
      category: a?.category ?? null,
      severity: a?.severity ?? null,
      containsInsult: a?.contains_insult ?? null,
      containsThreat: a?.contains_threat ?? null,
      containsClaim: a?.contains_claim ?? null,
      claimText: a?.claim_text ?? null,
      needsReview: label ? label !== "inceleme_gerekmiyor" : a!.needs_review,
      summary: a?.summary ?? null,
      triageLabel: label,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      inputHash: result.inputHash,
      latencyMs: result.latencyMs,
      raw: result.raw as never,
      analyzedAt: new Date(),
    },
  });
  await enqueueAlertIfNeeded(item, result.data, result.inputHash, tx);
  return true;
  });
}

export async function analyzeClaimedItem(itemId: string, lockId: string, analyzer: (input: AnalyzeCommentInput) => Promise<LlmResult | TriageResult> = analyzeComment) {
  const item = await db.query.socialItems.findFirst({
    where: and(eq(socialItems.id, itemId), eq(socialItems.analysisStatus, "processing"), eq(socialItems.analysisLockId, lockId)),
  });
  if (!item) return { processed: false as const, reason: "lost_lock" };
  if (item.deletedAt || item.sourceUnavailableAt) {
    const changed = await db.update(socialItems).set({
      analysisStatus: "complete",
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: item.sourceUnavailableAt ? "Meta source unavailable; deletion not confirmed" : "source item deleted before analysis",
      updatedAt: new Date(),
    }).where(and(eq(socialItems.id, item.id), eq(socialItems.analysisLockId, lockId),
      eq(socialItems.analysisStatus, "processing"), eq(socialItems.analysisRevision, item.analysisRevision)))
      .returning({ id: socialItems.id });
    if (!changed.length) return { processed: false as const, reason: "lost_lock" };
    return { processed: true as const, reason: "deleted" };
  }

  try {
    let persisted: boolean;
    if (item.text.trim().length === 0) {
      const data = { label: "insan_incelemesi_gerekli" as const };
      persisted = await persistAnalysis(item, lockId, {
        data,
        model: "deterministic",
        provider: "local",
        promptVersion: "triage-v1:empty",
        inputHash: crypto.createHash("sha256").update(item.text).digest("hex"),
        latencyMs: 0,
        raw: { output: data, reason: "empty_text", modelCalled: false },
      });
    } else {
      const context = await db.transaction(async (tx) => {
      await lockAnalysisContext(tx);
      const targets = await tx.select().from(monitoringTargets).where(eq(monitoringTargets.enabled, true));
      let sourceTargets: string[] = [];
      let source: { platform?: string; accountName?: string | null; accountUsername?: string | null; itemType?: string } = {
        platform: item.platform,
        itemType: item.itemType,
      };
      const externalSource = Boolean(item.raw && typeof item.raw === "object" && (item.raw as Record<string, unknown>).external_source);
      if (externalSource) {
        source.accountName = typeof (item.raw as Record<string, unknown>).source_channel === "string" ? String((item.raw as Record<string, unknown>).source_channel) : null;
      }
      if (item.connectionId && !externalSource) {
        const [connection, mapped] = await Promise.all([
          tx.query.socialConnections.findFirst({ where: eq(socialConnections.id, item.connectionId) }),
          tx.select({ name: monitoringTargets.name })
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
      const parent = item.parentExternalId && item.parentExternalId !== item.externalId
        ? await tx.query.socialItems.findFirst({ where: and(eq(socialItems.platform, item.platform), eq(socialItems.externalId, item.parentExternalId), isNull(socialItems.deletedAt), isNull(socialItems.sourceUnavailableAt)) })
        : undefined;
      return { targets, sourceTargets, source, parentText: parent?.text ?? null };
      });
      let leaseLost = false;
      let heartbeatPending: Promise<void> | undefined;
      const heartbeat = async () => {
        const held = await db.update(socialItems).set({ analysisLockedAt: new Date() })
          .where(and(eq(socialItems.id, item.id), eq(socialItems.analysisLockId, lockId),
            eq(socialItems.analysisStatus, "processing"), eq(socialItems.analysisRevision, item.analysisRevision)))
          .returning({ id: socialItems.id });
        if (!held.length) leaseLost = true;
      };
      await heartbeat();
      if (leaseLost) return { processed: false as const, reason: "lost_lock" };
      const timer = setInterval(() => {
        if (heartbeatPending || leaseLost) return;
        heartbeatPending = heartbeat().catch(() => {
          leaseLost = true;
          log.warn("analysis.heartbeat_failed", { itemId: item.id });
        }).finally(() => { heartbeatPending = undefined; });
      }, 60_000);
      let analyzed;
      try {
      analyzed = await analyzer({
        text: item.text,
        targets: context.targets.map((t) => ({ name: t.name, aliases: t.aliases })),
        sourceTargets: context.sourceTargets,
        source: context.source,
        parentText: context.parentText,
        postText: sourcePostText(item.raw, item.rootExternalId),
        contextIncomplete: Boolean(item.raw && typeof item.raw === "object" && (item.raw as Record<string, unknown>).context_incomplete),
      });
      } finally {
        clearInterval(timer);
        await heartbeatPending;
      }
      if (leaseLost) return { processed: false as const, reason: "lost_lock" };
      persisted = await persistAnalysis(item, lockId, analyzed);
    }
    return persisted ? { processed: true as const } : { processed: false as const, reason: "lost_lock" };
  } catch (error) {
    const attempts = item.analysisAttempts + 1;
    const dead = attempts >= 5;
    const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
    const message = safeErrorMessage(error);
    const changed = await db.update(socialItems).set({
      analysisStatus: dead ? "dead" : "retry",
      analysisAttempts: attempts,
      analysisAvailableAt: dead ? new Date() : new Date(Date.now() + delayMs),
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: message,
      updatedAt: new Date(),
    }).where(and(eq(socialItems.id, item.id), eq(socialItems.analysisLockId, lockId),
      eq(socialItems.analysisStatus, "processing"), eq(socialItems.analysisRevision, item.analysisRevision)))
      .returning({ id: socialItems.id });
    if (!changed.length) return { processed: false as const, reason: "lost_lock" };
    log.warn("analysis.failed", { itemId: item.id, attempts, dead, message });
    return { processed: false as const, reason: dead ? "dead" : "retry" };
  }
}

export async function processAnalysisJobs(jobs: Array<{ id: string; lockId: string }>, cfg: Awaited<ReturnType<typeof getLlmSettings>>) {
  const analyzer = createBatchAnalyzer(jobs.length, cfg);
  const completions: Array<Promise<Awaited<ReturnType<typeof analyzeClaimedItem>>>> = [];
  // Bound context reads separately from waiting for the shared provider response.
  await mapLimit(jobs, cfg.ANALYSIS_CONCURRENCY, (job) => new Promise<void>((ready) => {
    const work = analyzeClaimedItem(job.id, job.lockId, (input) => {
      ready();
      return analyzer(input);
    });
    completions.push(work);
    void work.then(() => ready(), () => ready());
  }));
  return mapLimit(completions, cfg.ANALYSIS_CONCURRENCY, (work) => work);
}

export async function claimAnalysisJobs(limit = 20): Promise<Array<{ id: string; lockId: string }>> {
  const now = new Date();
  const candidates = await db.select({ id: socialItems.id }).from(socialItems).where(and(
    inArray(socialItems.analysisStatus, ["pending", "retry"]),
    eq(socialItems.analysisExcluded, false),
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
      eq(socialItems.analysisExcluded, false),
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
