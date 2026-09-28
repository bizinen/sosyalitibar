import crypto from "node:crypto";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertOutbox, socialAnalyses, socialConnections, socialItems, webhookEvents } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { getFacebookComment, getInstagramComment, MetaApiError } from "@/lib/meta";
import { upsertSocialItem } from "@/lib/ingest";
import { log } from "@/lib/log";

type JsonObject = Record<string, unknown>;

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

async function connectionFor(platform: "facebook" | "instagram", externalAccountId: string) {
  return db.query.socialConnections.findFirst({
    where: and(eq(socialConnections.platform, platform), eq(socialConnections.externalAccountId, externalAccountId)),
  });
}

async function markDeleted(platform: "facebook" | "instagram", externalId: string) {
  await db.transaction(async (tx) => {
    const [item] = await tx.update(socialItems).set({
      deletedAt: new Date(),
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
    }).where(and(eq(alertOutbox.itemId, item.id), inArray(alertOutbox.status, ["pending", "retry"])));
  });
}

async function processFacebookChange(entryId: string, change: JsonObject): Promise<number> {
  if (str(change.field) !== "feed") return 0;
  const value = obj(change.value);
  if (!value) return 0;
  const item = str(value.item);
  const commentId = str(value.comment_id) || (item === "comment" ? str(value.id) : null);
  if (!commentId) return 0;
  const connection = await connectionFor("facebook", entryId);
  if (!connection || connection.status === "disabled") return 0;

  const verb = str(value.verb)?.toLowerCase();
  if (verb === "remove" || verb === "delete") {
    await markDeleted("facebook", commentId);
    return 1;
  }

  const token = decryptSecret(connection.encryptedAccessToken);
  try {
    const detail = await getFacebookComment(commentId, token);
    const postId = str(value.post_id) || str(value.post) || null;
    const parentId = detail.parent?.id || str(value.parent_id) || postId;
    const isReply = Boolean(postId && parentId && parentId !== postId);
    await upsertSocialItem({
      connectionId: connection.id,
      platform: "facebook",
      externalId: detail.id,
      parentExternalId: parentId,
      rootExternalId: postId,
      itemType: isReply ? "reply" : "comment",
      authorId: detail.from?.id ?? str(obj(value.from)?.id) ?? null,
      authorName: detail.from?.name ?? str(obj(value.from)?.name) ?? null,
      text: detail.message ?? str(value.message) ?? "",
      permalink: detail.permalink_url ?? null,
      sourceCreatedAt: dateFrom(detail.created_time) ?? dateFrom(value.created_time),
      raw: { webhook: value, detail },
    });
    return 1;
  } catch (error) {
    // Deleted comments can race with delivery. Meta commonly returns an object/permission error.
    if (error instanceof MetaApiError && [100, 803].includes(error.code ?? -1)) {
      await markDeleted("facebook", commentId);
      return 1;
    }
    throw error;
  }
}

async function processInstagramChange(entryId: string, change: JsonObject): Promise<number> {
  const field = str(change.field);
  if (field !== "comments" && field !== "live_comments") return 0;
  const value = obj(change.value);
  if (!value) return 0;
  const commentId = str(value.id) || str(value.comment_id);
  if (!commentId) return 0;
  const connection = await connectionFor("instagram", entryId);
  if (!connection || connection.status === "disabled") return 0;

  const verb = str(value.verb)?.toLowerCase();
  if (verb === "remove" || verb === "delete") {
    await markDeleted("instagram", commentId);
    return 1;
  }

  const token = decryptSecret(connection.encryptedAccessToken);
  try {
    const detail = await getInstagramComment(commentId, token);
    const valueMedia = obj(value.media);
    const mediaId = detail.media?.id || str(valueMedia?.id) || str(value.media_id);
    const parentId = detail.parent_id || str(value.parent_id) || mediaId;
    await upsertSocialItem({
      connectionId: connection.id,
      platform: "instagram",
      externalId: detail.id,
      parentExternalId: parentId,
      rootExternalId: mediaId,
      itemType: parentId && mediaId && parentId !== mediaId ? "reply" : "comment",
      authorId: str(obj(value.from)?.id),
      authorName: detail.username ?? str(obj(value.from)?.username) ?? null,
      text: detail.text ?? str(value.text) ?? "",
      permalink: detail.media?.permalink ?? null,
      sourceCreatedAt: dateFrom(detail.timestamp) ?? dateFrom(value.timestamp),
      raw: { webhook: value, detail },
    });
    return 1;
  } catch (error) {
    if (error instanceof MetaApiError && [100, 803].includes(error.code ?? -1)) {
      await markDeleted("instagram", commentId);
      return 1;
    }
    throw error;
  }
}

export async function processMetaWebhookPayload(payload: unknown): Promise<{ processedChanges: number; ignoredChanges: number }> {
  const root = obj(payload);
  if (!root) throw new Error("Webhook payload nesne değil");
  const objectType = str(root.object);
  const entries = Array.isArray(root.entry) ? root.entry : [];
  let processedChanges = 0;
  let ignoredChanges = 0;

  for (const rawEntry of entries) {
    const entry = obj(rawEntry);
    const entryId = str(entry?.id);
    const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
    if (!entryId) {
      ignoredChanges += changes.length || 1;
      continue;
    }
    for (const rawChange of changes) {
      const change = obj(rawChange);
      if (!change) {
        ignoredChanges++;
        continue;
      }
      let count = 0;
      if (objectType === "page") count = await processFacebookChange(entryId, change);
      else if (objectType === "instagram") count = await processInstagramChange(entryId, change);
      if (count) processedChanges += count;
      else ignoredChanges++;
    }
  }
  return { processedChanges, ignoredChanges };
}

export async function claimWebhookJobs(limit = 25): Promise<Array<{ id: string; lockId: string }>> {
  const now = new Date();
  const candidates = await db.select({ id: webhookEvents.id }).from(webhookEvents).where(and(
    inArray(webhookEvents.status, ["pending", "retry"]),
    lte(webhookEvents.availableAt, now),
  )).orderBy(asc(webhookEvents.availableAt), asc(webhookEvents.receivedAt)).limit(Math.max(1, Math.min(limit * 2, 200)));

  const claimed: Array<{ id: string; lockId: string }> = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    const lockId = crypto.randomUUID();
    const [row] = await db.update(webhookEvents).set({
      status: "processing",
      lockedAt: now,
      lockId,
    }).where(and(
      eq(webhookEvents.id, candidate.id),
      inArray(webhookEvents.status, ["pending", "retry"]),
      lte(webhookEvents.availableAt, now),
    )).returning({ id: webhookEvents.id });
    if (row) claimed.push({ id: row.id, lockId });
  }
  return claimed;
}

export async function processClaimedWebhook(id: string, lockId: string) {
  const row = await db.query.webhookEvents.findFirst({
    where: and(eq(webhookEvents.id, id), eq(webhookEvents.status, "processing"), eq(webhookEvents.lockId, lockId)),
  });
  if (!row) return { ok: false as const, reason: "lost_lock" };
  try {
    const result = await processMetaWebhookPayload(row.payload);
    await db.update(webhookEvents).set({
      status: "processed",
      lockedAt: null,
      lockId: null,
      error: null,
      processedAt: new Date(),
    }).where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.lockId, lockId)));
    return { ok: true as const, ...result };
  } catch (error) {
    const attempts = row.attempts + 1;
    const dead = attempts >= 5;
    const delayMs = Math.min(60 * 60 * 1000, 15_000 * 2 ** Math.max(0, attempts - 1));
    const message = error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200);
    await db.update(webhookEvents).set({
      status: dead ? "dead" : "retry",
      attempts,
      availableAt: dead ? new Date() : new Date(Date.now() + delayMs),
      lockedAt: null,
      lockId: null,
      error: message,
    }).where(and(eq(webhookEvents.id, row.id), eq(webhookEvents.lockId, lockId)));
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
