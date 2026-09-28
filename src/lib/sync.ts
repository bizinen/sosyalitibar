import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { socialConnections } from "@/db/schema";
import { decryptSecret, encryptSecret, secretNeedsRotation } from "@/lib/crypto";
import { env } from "@/lib/config";
import {
  type GraphList,
  getFacebookComments,
  getFacebookPosts,
  getFacebookReplies,
  getInstagramComments,
  getInstagramMedia,
  getInstagramReplies,
  graphGetAbsolute,
  MetaApiError,
} from "@/lib/meta";
import { upsertSocialItem } from "@/lib/ingest";
import { log } from "@/lib/log";
import { mapLimit } from "@/lib/concurrency";
import crypto from "node:crypto";

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function collectPages<T>(first: GraphList<T>, maxItems: number, heartbeat?: () => Promise<void>): Promise<T[]> {
  const out: T[] = [...first.data];
  let next = first.paging?.next;
  while (next && out.length < maxItems) {
    const page = await graphGetAbsolute<GraphList<T>>(next);
    out.push(...page.data);
    next = page.paging?.next;
    await heartbeat?.();
  }
  return out.slice(0, maxItems);
}

async function maybeRotateConnectionToken(connection: typeof socialConnections.$inferSelect, token: string) {
  if (!secretNeedsRotation(connection.encryptedAccessToken)) return;
  await db.update(socialConnections).set({ encryptedAccessToken: encryptSecret(token), updatedAt: new Date() }).where(eq(socialConnections.id, connection.id));
}

async function syncFacebook(connection: typeof socialConnections.$inferSelect, token: string, heartbeat?: () => Promise<void>) {
  const cfg = env();
  const cutoff = Date.now() - cfg.SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const firstPosts = await getFacebookPosts(connection.externalAccountId, token, Math.min(100, cfg.SYNC_MAX_POSTS_PER_CONNECTION));
  const posts = await collectPages(firstPosts, cfg.SYNC_MAX_POSTS_PER_CONNECTION, heartbeat);
  let items = 0;
  let parents = 0;

  for (const post of posts) {
    const postDate = parseDate(post.created_time);
    if (postDate && postDate.getTime() < cutoff) continue;
    parents++;
    if (heartbeat && parents % 10 === 0) await heartbeat();
    const firstComments = await getFacebookComments(post.id, token, 100);
    const comments = await collectPages(firstComments, cfg.SYNC_MAX_COMMENTS_PER_PARENT, heartbeat);
    for (const comment of comments) {
      await upsertSocialItem({
        connectionId: connection.id,
        platform: "facebook",
        externalId: comment.id,
        parentExternalId: post.id,
        rootExternalId: post.id,
        itemType: "comment",
        authorId: comment.from?.id ?? null,
        authorName: comment.from?.name ?? null,
        text: comment.message ?? "",
        permalink: comment.permalink_url ?? post.permalink_url ?? null,
        sourceCreatedAt: parseDate(comment.created_time),
        raw: comment,
      });
      items++;
      if (heartbeat && items % 100 === 0) await heartbeat();

      // Reconciliation also checks replies; webhooks remain the primary realtime path.
      const firstReplies = await getFacebookReplies(comment.id, token, 100).catch(() => ({ data: [] } as GraphList<never>));
      const replies = await collectPages(firstReplies, cfg.SYNC_MAX_COMMENTS_PER_PARENT, heartbeat);
      for (const reply of replies) {
        if (reply.id === comment.id) continue;
        await upsertSocialItem({
          connectionId: connection.id,
          platform: "facebook",
          externalId: reply.id,
          parentExternalId: comment.id,
          rootExternalId: post.id,
          itemType: "reply",
          authorId: reply.from?.id ?? null,
          authorName: reply.from?.name ?? null,
          text: reply.message ?? "",
          permalink: reply.permalink_url ?? post.permalink_url ?? null,
          sourceCreatedAt: parseDate(reply.created_time),
          raw: reply,
        });
        items++;
        if (heartbeat && items % 100 === 0) await heartbeat();
      }
    }
  }
  return { items, parents };
}

async function syncInstagram(connection: typeof socialConnections.$inferSelect, token: string, heartbeat?: () => Promise<void>) {
  const cfg = env();
  const cutoff = Date.now() - cfg.SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const firstMedia = await getInstagramMedia(connection.externalAccountId, token, Math.min(100, cfg.SYNC_MAX_POSTS_PER_CONNECTION));
  const media = await collectPages(firstMedia, cfg.SYNC_MAX_POSTS_PER_CONNECTION, heartbeat);
  let items = 0;
  let parents = 0;

  for (const item of media) {
    const mediaDate = parseDate(item.timestamp);
    if (mediaDate && mediaDate.getTime() < cutoff) continue;
    parents++;
    if (heartbeat && parents % 10 === 0) await heartbeat();
    const firstComments = await getInstagramComments(item.id, token, 100);
    const comments = await collectPages(firstComments, cfg.SYNC_MAX_COMMENTS_PER_PARENT, heartbeat);
    for (const comment of comments) {
      await upsertSocialItem({
        connectionId: connection.id,
        platform: "instagram",
        externalId: comment.id,
        parentExternalId: item.id,
        rootExternalId: item.id,
        itemType: "comment",
        authorName: comment.username ?? null,
        text: comment.text ?? "",
        permalink: item.permalink ?? null,
        sourceCreatedAt: parseDate(comment.timestamp),
        raw: comment,
      });
      items++;
      if (heartbeat && items % 100 === 0) await heartbeat();

      let replies = comment.replies?.data ?? [];
      let next = comment.replies?.paging?.next;
      while (next && replies.length < cfg.SYNC_MAX_COMMENTS_PER_PARENT) {
        const page = await graphGetAbsolute<GraphList<typeof replies[number]>>(next);
        replies.push(...page.data);
        next = page.paging?.next;
        await heartbeat?.();
      }
      if (!comment.replies && cfg.SYNC_MAX_COMMENTS_PER_PARENT > 0) {
        const firstReplies = await getInstagramReplies(comment.id, token, 100).catch(() => ({ data: [] } as GraphList<never>));
        replies = await collectPages(firstReplies, cfg.SYNC_MAX_COMMENTS_PER_PARENT, heartbeat);
      }
      for (const reply of replies.slice(0, cfg.SYNC_MAX_COMMENTS_PER_PARENT)) {
        await upsertSocialItem({
          connectionId: connection.id,
          platform: "instagram",
          externalId: reply.id,
          parentExternalId: comment.id,
          rootExternalId: item.id,
          itemType: "reply",
          authorName: reply.username ?? null,
          text: reply.text ?? "",
          permalink: item.permalink ?? null,
          sourceCreatedAt: parseDate(reply.timestamp),
          raw: reply,
        });
        items++;
        if (heartbeat && items % 100 === 0) await heartbeat();
      }
    }
  }
  return { items, parents };
}

export async function syncConnection(connection: typeof socialConnections.$inferSelect, leaseId?: string) {
  if (connection.status === "disabled" || connection.status === "revoked") return { skipped: true, items: 0, parents: 0 };
  const token = decryptSecret(connection.encryptedAccessToken);
  await maybeRotateConnectionToken(connection, token);
  const ownedRow = leaseId
    ? and(eq(socialConnections.id, connection.id), eq(socialConnections.syncLockId, leaseId))
    : eq(socialConnections.id, connection.id);
  const heartbeat = leaseId ? async () => {
    const held = await db.update(socialConnections).set({ syncLockedAt: new Date(), updatedAt: new Date() })
      .where(ownedRow)
      .returning({ id: socialConnections.id });
    if (!held.length) throw new Error("sync lease lost");
  } : undefined;
  try {
    await heartbeat?.();
    const result = connection.platform === "instagram"
      ? await syncInstagram(connection, token, heartbeat)
      : await syncFacebook(connection, token, heartbeat);
    await db.update(socialConnections).set({
      status: "active",
      lastError: null,
      lastSyncedAt: new Date(),
      syncAttemptedAt: new Date(),
      updatedAt: new Date(),
    }).where(ownedRow);
    return { skipped: false, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1200) : String(error).slice(0, 1200);
    const revoked = error instanceof MetaApiError && error.code === 190;
    await db.update(socialConnections).set({
      status: revoked ? "revoked" : "degraded",
      lastError: message,
      syncAttemptedAt: new Date(),
      updatedAt: new Date(),
    }).where(ownedRow);
    log.warn("sync.connection_failed", { connectionId: connection.id, platform: connection.platform, revoked, message });
    throw error;
  } finally {
    if (leaseId) {
      // Only the worker that owns the lease may release it. A stale worker must not clear a newer lease.
      await db.update(socialConnections).set({ syncLockedAt: null, syncLockId: null })
        .where(and(eq(socialConnections.id, connection.id), eq(socialConnections.syncLockId, leaseId)))
        .catch((error) => log.warn("sync.lease_release_failed", { connectionId: connection.id, message: error instanceof Error ? error.message : String(error) }));
    }
  }
}

async function claimConnections(connectionId?: string) {
  const cfg = env();
  const leaseId = crypto.randomUUID();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - cfg.SYNC_LEASE_MS);
  const limit = connectionId ? 1 : cfg.SYNC_CONNECTION_BATCH_SIZE;
  const idFilter = connectionId ? sql`and id = ${connectionId}` : sql``;

  // One SQL statement performs selection + row lock + lease update atomically.
  // This is intentionally raw SQL: FOR UPDATE SKIP LOCKED is the concurrency boundary
  // and must remain obvious/auditable across Drizzle upgrades.
  const claimedResult = await db.execute(sql`
    with candidates as (
      select id
      from social_connections
      where status in ('active', 'degraded')
        and (sync_locked_at is null or sync_locked_at < ${staleBefore})
        ${idFilter}
      order by sync_attempted_at asc nulls first, id
      for update skip locked
      limit ${limit}
    )
    update social_connections as sc
    set sync_locked_at = ${now},
        sync_lock_id = ${leaseId},
        sync_attempted_at = ${now},
        updated_at = ${now}
    from candidates
    where sc.id = candidates.id
    returning sc.id
  `);

  const claimedIds = Array.from(claimedResult as unknown as Iterable<{ id: string }>).map((row) => row.id);
  if (!claimedIds.length) return { leaseId, rows: [] as Array<typeof socialConnections.$inferSelect> };
  const rows = await db.select().from(socialConnections).where(inArray(socialConnections.id, claimedIds));
  return { leaseId, rows };
}

export async function syncAllConnections(connectionId?: string) {
  const cfg = env();
  const { leaseId, rows } = await claimConnections(connectionId);

  return mapLimit(rows, cfg.SYNC_CONCURRENCY, async (connection) => {
    try {
      const result = await syncConnection(connection, leaseId);
      return { connectionId: connection.id, ok: true as const, items: result.items, parents: result.parents };
    } catch (error) {
      return { connectionId: connection.id, ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
