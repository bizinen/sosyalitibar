import crypto from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import { alertOutbox, socialAnalyses, socialConnections, socialItems, webhookEvents } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getFacebookComment, getInstagramComment, getFacebookPost, getInstagramMediaItem } from "@/lib/meta";
import { beginSourceRead, upsertSocialItem } from "@/lib/ingest";
import { log, safeErrorMessage } from "@/lib/log";
import { invalidateAnalyses, lockAnalysisContext } from "@/lib/analysis-state";

type JsonObject = Record<string, unknown>;
type AssertOwnership = (tx?: Transaction) => Promise<void>;

function obj(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function dateFrom(value: unknown): Date | null {
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function connectionFor(platform: "facebook" | "instagram", externalAccountId: string, deferUnknown = false) {
  const connection = await db.query.socialConnections.findFirst({
    where: and(eq(socialConnections.platform, platform), eq(socialConnections.externalAccountId, externalAccountId)),
  });
  if (!connection && deferUnknown) throw new Error("webhook connection registration pending");
  return connection;
}

function connectionOwnership(connection: typeof socialConnections.$inferSelect, assertOwnership?: AssertOwnership, allowRevoked = false) {
  return async (tx: Transaction) => {
    await assertOwnership?.(tx);
    const [current] = await tx.select({ id: socialConnections.id }).from(socialConnections).where(and(
      eq(socialConnections.id, connection.id),
      eq(socialConnections.encryptedAccessToken, connection.encryptedAccessToken),
      inArray(socialConnections.status, allowRevoked ? ["active", "degraded", "revoked"] : ["active", "degraded"]),
    )).for("share");
    if (!current) throw new Error("webhook connection changed during processing");
  };
}

async function markDeleted(platform: "facebook" | "instagram", externalId: string, connectionId: string, assertOwnership?: (tx: Transaction) => Promise<void>) {
  await db.transaction(async (tx) => {
    await lockAnalysisContext(tx, true);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${platform}), hashtext(${externalId}))`);
    const [existing] = await tx.select({ id: socialItems.id, deletedAt: socialItems.deletedAt }).from(socialItems)
      .where(and(eq(socialItems.platform, platform), eq(socialItems.externalId, externalId))).for("update");
    await assertOwnership?.(tx);
    if (existing?.deletedAt) return;
    if (!existing) {
      await tx.insert(socialItems).values({
        connectionId, platform, externalId, text: "", deletedAt: new Date(),
        analysisStatus: "complete", analysisError: "source item deleted before ingestion",
      });
      await invalidateAnalyses(tx, and(eq(socialItems.platform, platform), eq(socialItems.parentExternalId, externalId)));
      return;
    }
    const [item] = await tx.update(socialItems).set({
      deletedAt: new Date(),
      analysisRevision: sql`${socialItems.analysisRevision} + 1`,
      analysisStatus: "complete",
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: "source item deleted",
      updatedAt: new Date(),
    }).where(and(
      eq(socialItems.platform, platform),
      eq(socialItems.externalId, externalId),
    )).returning({ id: socialItems.id });
    if (!item) return;
    await tx.delete(socialAnalyses).where(eq(socialAnalyses.itemId, item.id));
    await tx.update(alertOutbox).set({
      status: "cancelled",
      lockedAt: null,
      lockId: null,
      lastError: "source item deleted",
      updatedAt: new Date(),
    }).where(and(eq(alertOutbox.itemId, item.id), sql`(${alertOutbox.status} in ('pending', 'retry', 'dead') or (${alertOutbox.status} = 'processing' and ${alertOutbox.dispatchStartedAt} is null))`));
    await invalidateAnalyses(tx, and(eq(socialItems.platform, platform), eq(socialItems.parentExternalId, externalId)));
  });
}

async function processFacebookChange(entryId: string, change: JsonObject, assertOwnership?: AssertOwnership, deferUnknown = false): Promise<number> {
  if (str(change.field) !== "feed") return 0;
  const value = obj(change.value);
  if (!value) throw new Error("Facebook feed change value invalid");
  const item = str(value.item);
  const commentId = str(value.comment_id) || (item === "comment" ? str(value.id) : null);
  if (!commentId) {
    if (item === "comment") throw new Error("Facebook comment change identity missing");
    return 0;
  }
  const connection = await connectionFor("facebook", entryId, deferUnknown);
  if (!connection || connection.status === "disabled") return 0;

  const verb = str(value.verb)?.toLowerCase();
  if (verb === "remove" || verb === "delete") {
    await markDeleted("facebook", commentId, connection.id, connectionOwnership(connection, assertOwnership, true));
    return 1;
  }
  if (connection.status === "revoked") throw new Error("connection requires reauthorization");

  const token = decryptSecret(connection.encryptedAccessToken);
  try {
    const sourceReadVersion = await beginSourceRead();
    const detail = await getFacebookComment(commentId, token);
    if (detail.id !== commentId) throw new Error("Facebook comment response identity mismatch");
    const postId = str(value.post_id) || str(value.post) || null;
    const parentId = detail.parent?.id || str(value.parent_id) || postId;
    const isReply = Boolean(postId && parentId && parentId !== postId);
    let contextIncomplete = false;
    const post = postId ? await getFacebookPost(postId, token).catch((error) => {
      contextIncomplete = true;
      log.warn("webhook.post_context_unavailable", { platform: "facebook", postId, message: safeErrorMessage(error) });
      return null;
    }) : null;
    if (post && post.id !== postId) throw new Error("Facebook post context identity mismatch");
    if (isReply && parentId && parentId !== commentId) {
      const parent = await getFacebookComment(parentId, token).catch((error) => {
        contextIncomplete = true;
        log.warn("webhook.parent_context_unavailable", { platform: "facebook", parentId, message: safeErrorMessage(error) });
        return null;
      });
      if (parent) {
        if (parent.id !== parentId) throw new Error("Facebook parent context identity mismatch");
        await upsertSocialItem({ connectionId: connection.id, platform: "facebook", externalId: parent.id,
          parentExternalId: parent.parent?.id ?? postId, rootExternalId: postId,
          itemType: parent.parent?.id && parent.parent.id !== postId ? "reply" : "comment",
          text: parent.message ?? "", authorId: parent.from?.id ?? null, authorName: parent.from?.name ?? null,
          permalink: parent.permalink_url ?? post?.permalink_url ?? null, sourceCreatedAt: dateFrom(parent.created_time), sourceReadVersion,
          raw: { detail: parent, context_incomplete: contextIncomplete, ...(post ? { source_post: { id: post.id, text: post.message ?? null, permalink: post.permalink_url ?? null } } : {}) },
        }, connectionOwnership(connection, assertOwnership));
      }
    }
    await upsertSocialItem({
      connectionId: connection.id,
      platform: "facebook",
      externalId: detail.id,
      parentExternalId: parentId,
      rootExternalId: postId,
      itemType: postId && parentId ? (isReply ? "reply" : "comment") : undefined,
      authorId: detail.from?.id ?? str(obj(value.from)?.id) ?? null,
      authorName: detail.from?.name ?? str(obj(value.from)?.name) ?? null,
      text: detail.message ?? str(value.message) ?? "",
      permalink: detail.permalink_url ?? null,
      sourceCreatedAt: dateFrom(detail.created_time) ?? dateFrom(value.created_time),
      sourceReadVersion,
      raw: { webhook: value, detail, context_incomplete: contextIncomplete, ...(post ? { source_post: { id: post.id, text: post.message ?? null, permalink: post.permalink_url ?? null } } : {}) },
    }, connectionOwnership(connection, assertOwnership));
    return 1;
  } catch (error) {
    throw error;
  }
}

async function processInstagramChange(entryId: string, change: JsonObject, assertOwnership?: AssertOwnership, deferUnknown = false): Promise<number> {
  const field = str(change.field);
  if (field !== "comments" && field !== "live_comments") return 0;
  const value = obj(change.value);
  if (!value) throw new Error("Instagram comment change value invalid");
  const commentId = str(value.id) || str(value.comment_id);
  if (!commentId) throw new Error("Instagram comment change identity missing");
  const connection = await connectionFor("instagram", entryId, deferUnknown);
  if (!connection || connection.status === "disabled") return 0;

  const verb = str(value.verb)?.toLowerCase();
  if (verb === "remove" || verb === "delete") {
    await markDeleted("instagram", commentId, connection.id, connectionOwnership(connection, assertOwnership, true));
    return 1;
  }
  if (connection.status === "revoked") throw new Error("connection requires reauthorization");

  const token = decryptSecret(connection.encryptedAccessToken);
  try {
    const sourceReadVersion = await beginSourceRead();
    const detail = await getInstagramComment(commentId, token);
    if (detail.id !== commentId) throw new Error("Instagram comment response identity mismatch");
    const valueMedia = obj(value.media);
    const mediaId = detail.media?.id || str(valueMedia?.id) || str(value.media_id);
    const parentId = detail.parent_id || str(value.parent_id) || mediaId;
    let contextIncomplete = false;
    const media = mediaId ? await getInstagramMediaItem(mediaId, token).catch((error) => {
      contextIncomplete = true;
      log.warn("webhook.post_context_unavailable", { platform: "instagram", mediaId, message: safeErrorMessage(error) });
      return null;
    }) : null;
    if (media && media.id !== mediaId) throw new Error("Instagram media context identity mismatch");
    if (parentId && mediaId && parentId !== mediaId && parentId !== commentId) {
      const parent = await getInstagramComment(parentId, token).catch((error) => {
        contextIncomplete = true;
        log.warn("webhook.parent_context_unavailable", { platform: "instagram", parentId, message: safeErrorMessage(error) });
        return null;
      });
      if (parent) {
        if (parent.id !== parentId) throw new Error("Instagram parent context identity mismatch");
        await upsertSocialItem({ connectionId: connection.id, platform: "instagram", externalId: parent.id,
          parentExternalId: parent.parent_id ?? mediaId, rootExternalId: mediaId,
          itemType: parent.parent_id && parent.parent_id !== mediaId ? "reply" : "comment",
          text: parent.text ?? "", authorName: parent.username ?? null, sourceCreatedAt: dateFrom(parent.timestamp), sourceReadVersion,
          permalink: media?.permalink ?? detail.media?.permalink ?? null,
          raw: { detail: parent, context_incomplete: contextIncomplete, ...(media ? { source_post: { id: media.id, text: media.caption ?? null, permalink: media.permalink ?? null } } : {}) },
        }, connectionOwnership(connection, assertOwnership));
      }
    }
    await upsertSocialItem({
      connectionId: connection.id,
      platform: "instagram",
      externalId: detail.id,
      parentExternalId: parentId,
      rootExternalId: mediaId,
      itemType: parentId && mediaId ? (parentId !== mediaId ? "reply" : "comment") : undefined,
      authorId: str(obj(value.from)?.id),
      authorName: detail.username ?? str(obj(value.from)?.username) ?? null,
      text: detail.text ?? str(value.text) ?? "",
      permalink: detail.media?.permalink ?? media?.permalink ?? null,
      sourceCreatedAt: dateFrom(detail.timestamp) ?? dateFrom(value.timestamp),
      sourceReadVersion,
      raw: { webhook: value, detail, context_incomplete: contextIncomplete, ...(media ? { source_post: { id: media.id, text: media.caption ?? null, permalink: media.permalink ?? null } } : {}) },
    }, connectionOwnership(connection, assertOwnership));
    return 1;
  } catch (error) {
    throw error;
  }
}

export async function processMetaWebhookPayload(payload: unknown, assertOwnership?: AssertOwnership, deferUnknown = false): Promise<{ processedChanges: number; ignoredChanges: number }> {
  const root = obj(payload);
  if (!root) throw new Error("Webhook payload nesne değil");
  const objectType = str(root.object);
  if ((objectType === "page" || objectType === "instagram") && !Array.isArray(root.entry)) {
    throw new Error("Webhook entry list invalid");
  }
  const entries = Array.isArray(root.entry) ? root.entry : [];
  let processedChanges = 0;
  let ignoredChanges = 0;

  for (const rawEntry of entries) {
    const entry = obj(rawEntry);
    if (!entry) throw new Error("Webhook entry invalid");
    if (entry.changes !== undefined && !Array.isArray(entry.changes)) throw new Error("Webhook changes list invalid");
    const entryId = str(entry?.id);
    const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
    if (!entryId) {
      if (changes.length) throw new Error("Webhook entry identity missing");
      ignoredChanges += changes.length || 1;
      continue;
    }
    for (const rawChange of changes) {
      const change = obj(rawChange);
      if (!change) {
        throw new Error("Webhook change invalid");
      }
      let count = 0;
      await assertOwnership?.();
      if (objectType === "page") count = await processFacebookChange(entryId, change, assertOwnership, deferUnknown);
      else if (objectType === "instagram") count = await processInstagramChange(entryId, change, assertOwnership, deferUnknown);
      if (count) processedChanges += count;
      else ignoredChanges++;
    }
  }
  return { processedChanges, ignoredChanges };
}

export async function claimWebhookJobs(limit = 25): Promise<Array<{ id: string; lockId: string }>> {
  const now = new Date().toISOString();
  const rows = await db.execute(sql`
    with candidates as materialized (
      select id from webhook_events where status in ('pending', 'retry') and available_at <= ${now}::timestamptz
      order by available_at, received_at, id for update skip locked limit ${Math.max(1, Math.min(limit, 100))}
    ) update webhook_events as event set status = 'processing', locked_at = ${now}::timestamptz, lock_id = gen_random_uuid()
    from candidates where event.id = candidates.id returning event.id, event.lock_id as "lockId"
  `);
  return Array.from(rows as unknown as Iterable<{ id: string; lockId: string }>);
}

export async function processClaimedWebhook(id: string, lockId: string) {
  const row = await db.query.webhookEvents.findFirst({
    where: and(eq(webhookEvents.id, id), eq(webhookEvents.status, "processing"), eq(webhookEvents.lockId, lockId)),
  });
  if (!row) return { ok: false as const, reason: "lost_lock" };
  const root = obj(row.payload);
  const units = root && Array.isArray(root.entry) ? root.entry.flatMap((rawEntry) => {
    const entry = obj(rawEntry);
    return entry && Array.isArray(entry.changes) && entry.changes.length > 0
      ? entry.changes.map((change) => ({ ...root, entry: [{ ...entry, changes: [change] }] }))
      : [{ ...root, entry: [rawEntry] }];
  }) : [];
  if (units.length > 1) {
    const split = await db.transaction(async (tx) => {
      const [owned] = await tx.select({ id: webhookEvents.id }).from(webhookEvents).where(and(
        eq(webhookEvents.id, id), eq(webhookEvents.status, "processing"), eq(webhookEvents.lockId, lockId),
      )).for("update");
      if (!owned) return false;
      await tx.insert(webhookEvents).values(units.map((payload, index) => ({
        source: row.source, objectType: row.objectType, payload,
        dedupeKey: crypto.createHash("sha256").update(`${row.dedupeKey}:change:${index}`).digest("hex"),
        receivedAt: row.receivedAt,
      }))).onConflictDoNothing({ target: webhookEvents.dedupeKey });
      await tx.update(webhookEvents).set({ status: "processed", lockedAt: null, lockId: null,
        error: null, processedAt: new Date() }).where(eq(webhookEvents.id, id));
      return true;
    });
    return split ? { ok: true as const, processedChanges: 0, ignoredChanges: 0 }
      : { ok: false as const, reason: "lost_lock" };
  }
  const assertOwnership: AssertOwnership = async (tx) => {
    const condition = and(eq(webhookEvents.id, id), eq(webhookEvents.status, "processing"), eq(webhookEvents.lockId, lockId));
    const held = tx
      ? await tx.select({ id: webhookEvents.id }).from(webhookEvents).where(condition).for("share")
      : await db.update(webhookEvents).set({ lockedAt: new Date() }).where(condition).returning({ id: webhookEvents.id });
    if (!held.length) throw new Error("webhook lease lost");
  };
  try {
    const result = await processMetaWebhookPayload(row.payload, assertOwnership, Date.now() - row.receivedAt.getTime() < 5 * 60000);
    const completed = await db.update(webhookEvents).set({
      status: "processed",
      lockedAt: null,
      lockId: null,
      error: null,
      processedAt: new Date(),
    }).where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.lockId, lockId), eq(webhookEvents.status, "processing"))).returning({ id: webhookEvents.id });
    if (!completed.length) return { ok: false as const, reason: "lost_lock" };
    return { ok: true as const, ...result };
  } catch (error) {
    if (error instanceof Error && error.message === "webhook lease lost") return { ok: false as const, reason: "lost_lock" };
    const waitingForConnection = error instanceof Error && error.message === "webhook connection registration pending";
    const attempts = row.attempts + (waitingForConnection ? 0 : 1);
    const dead = !waitingForConnection && attempts >= 5;
    const delayMs = waitingForConnection ? 15000 : Math.min(60 * 60 * 1000, 15_000 * 2 ** Math.max(0, attempts - 1));
    const message = safeErrorMessage(error);
    const changed = await db.update(webhookEvents).set({
      status: dead ? "dead" : "retry",
      attempts,
      availableAt: dead ? new Date() : new Date(Date.now() + delayMs),
      lockedAt: null,
      lockId: null,
      error: message,
    }).where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.lockId, lockId), eq(webhookEvents.status, "processing")))
      .returning({ id: webhookEvents.id });
    if (!changed.length) return { ok: false as const, reason: "lost_lock" };
    log.warn("webhook.process_failed", { eventId: row.id, attempts, dead, message });
    return { ok: false as const, reason: dead ? "dead" : "retry" };
  }
}

export async function requeueStaleWebhookLocks(maxAgeMinutes = 10): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const rows = await db.update(webhookEvents).set({
    status: "retry",
    lockedAt: null,
    lockId: null,
    availableAt: new Date(),
    error: "stale webhook lock recovered",
  }).where(and(eq(webhookEvents.status, "processing"), lte(webhookEvents.lockedAt, cutoff))).returning({ id: webhookEvents.id });
  return rows.length;
}
