import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import { socialConnections, socialItems } from "@/db/schema";
import { decryptSecret, encryptSecret, secretNeedsRotation } from "@/lib/crypto";
import { env } from "@/lib/config";
import {
  type GraphList,
  getFacebookComments,
  getFacebookComment,
  getFacebookPosts,
  getFacebookReplies,
  getInstagramComments,
  getInstagramComment,
  getInstagramMedia,
  getInstagramReplies,
  graphGetAbsolute,
  MetaApiError,
} from "@/lib/meta";
import { beginSourceRead, markSourceUnavailable, upsertSocialItem } from "@/lib/ingest";
import { log, safeErrorMessage } from "@/lib/log";
import { mapLimit } from "@/lib/concurrency";
import crypto from "node:crypto";
import { z } from "zod";

const syncRecordSchema = z.object({
  id: z.string().min(1).refine((value) => value.trim().length > 0),
  message: z.string().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  username: z.string().optional(),
  created_time: z.string().optional(),
  timestamp: z.string().optional(),
  permalink: z.string().optional(),
  permalink_url: z.string().optional(),
  parent: z.object({ id: z.string().min(1).optional() }).nullish(),
  from: z.object({ id: z.string().optional(), name: z.string().optional() }).nullish(),
}).passthrough();
const syncPagingSchema = z.object({ next: z.string().min(1).optional() }).passthrough();
const syncListSchema = z.object({
  data: z.array(syncRecordSchema),
  paging: syncPagingSchema.nullish(),
}).passthrough();

type SyncRecord = z.infer<typeof syncRecordSchema>;
type SyncPageTask = { kind: "posts" | "comments" | "replies" | "verify"; page: GraphList<SyncRecord>; root?: SyncRecord; parent?: SyncRecord; sourceReadVersion: number; attempts?: number; availableAt?: number; error?: string; seen?: string[]; fetchPending?: boolean };
type SyncProgress = { tasks: SyncPageTask[]; deadTasks: SyncPageTask[]; sourceReadVersion: number };
const syncTaskSchema = z.object({
  kind: z.enum(["posts", "comments", "replies", "verify"]), page: syncListSchema,
  root: syncRecordSchema.optional(), parent: syncRecordSchema.optional(),
  sourceReadVersion: z.number().int().positive().safe(),
  attempts: z.number().int().min(0).max(10).optional(),
  availableAt: z.number().int().nonnegative().optional(),
  error: z.string().max(1000).optional(),
  seen: z.array(z.string()).max(10000).optional(),
  fetchPending: z.boolean().optional(),
}).superRefine((task, ctx) => {
  if (task.kind !== "posts" && task.kind !== "verify" && !task.root) ctx.addIssue({ code: "custom", message: "sync continuation root missing" });
  if (task.kind === "replies" && !task.parent) ctx.addIssue({ code: "custom", message: "sync continuation parent missing" });
  if (task.fetchPending && task.kind !== "replies") ctx.addIssue({ code: "custom", message: "sync continuation fetch kind invalid" });
});
const syncProgressSchema = z.object({ tasks: z.array(syncTaskSchema), deadTasks: z.array(syncTaskSchema).default([]) });

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}


async function maybeRotateConnectionToken(connection: typeof socialConnections.$inferSelect, token: string) {
  if (!secretNeedsRotation(connection.encryptedAccessToken)) return;
  const encrypted = encryptSecret(token);
  const changed = await db.update(socialConnections).set({ encryptedAccessToken: encrypted, updatedAt: new Date() })
    .where(and(eq(socialConnections.id, connection.id), eq(socialConnections.encryptedAccessToken, connection.encryptedAccessToken))).returning({ id: socialConnections.id });
  if (!changed.length) throw new Error("sync lease lost");
  connection.encryptedAccessToken = encrypted;
}

async function processSyncTasks(connection: typeof socialConnections.$inferSelect, token: string, progress: SyncProgress,
  checkpoint: () => Promise<void>, heartbeat: (() => Promise<void>) | undefined, assertOwnership: (tx: Transaction) => Promise<void>, deadline: number) {
  const cfg = env();
  const cutoff = Date.now() - cfg.SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const facebook = connection.platform === "facebook";
  const pageLimit = Math.min(100, cfg.SYNC_MAX_COMMENTS_PER_PARENT);
  let items = 0;
  let parents = 0;
  let outsideLookbackParents = 0;
  let steps = 0;
  while (progress.tasks.length && steps < cfg.SYNC_RUN_MAX_STEPS && Date.now() < deadline) {
    const probe = steps % 5 === 0 ? progress.tasks.findIndex((task) => task.kind === "verify" && (!task.availableAt || task.availableAt <= Date.now())) : -1;
    const runnable = probe >= 0 ? probe : progress.tasks.findIndex((task) => !task.availableAt || task.availableAt <= Date.now());
    if (runnable < 0) break;
    const [task] = progress.tasks.splice(runnable, 1);
    progress.tasks.unshift(task!);
    await heartbeat?.();
    steps++;
    let sourceFailure = false;
    const readPage = async (request: Promise<unknown>) => {
      try { return syncListSchema.parse(await request); }
      catch (error) { sourceFailure = true; throw error; }
    };
    try {
      if (task!.fetchPending) {
        if (progress.deadTasks.some((dead) => dead.kind === task!.kind && dead.parent?.id === task!.parent?.id && dead.fetchPending)) {
          progress.tasks.shift();
          continue;
        }
        task!.page = await readPage(facebook ? getFacebookReplies(task!.parent!.id, token, pageLimit) : getInstagramReplies(task!.parent!.id, token, pageLimit));
        task!.fetchPending = false;
        task!.attempts = 0;
        task!.availableAt = undefined;
        task!.error = undefined;
        if (!task!.page.data.length && !task!.page.paging?.next) progress.tasks.shift();
        await checkpoint();
        continue;
      }
      if (!task!.page.data.length) {
        const next = task!.page.paging?.next;
        if (!next) { progress.tasks.shift(); continue; }
        if (progress.deadTasks.some((dead) => dead.kind === task!.kind && dead.root?.id === task!.root?.id
          && dead.parent?.id === task!.parent?.id && !dead.page.data.length && dead.page.paging?.next === next)) {
          progress.tasks.shift();
          continue;
        }
        const seen = task!.seen ?? [];
        if (seen.includes(next) || seen.length >= 10000) { sourceFailure = true; throw new Error("Meta pagination did not advance"); }
        const page = await readPage(graphGetAbsolute<GraphList<SyncRecord>>(next));
        task!.page = page;
        task!.seen = [...seen, next];
        task!.attempts = 0;
        task!.availableAt = undefined;
        task!.error = undefined;
        await checkpoint();
        continue;
      }
      const record = task!.page.data[0]!;
      if (progress.deadTasks.some((dead) => dead.kind === task!.kind && dead.root?.id === task!.root?.id
        && dead.parent?.id === task!.parent?.id && dead.page.data[0]?.id === record.id)) {
        task!.page.data.shift();
        if (steps % 25 === 0) await checkpoint();
        continue;
      }
      if (task!.kind === "verify") {
        const existing = await db.query.socialItems.findFirst({ where: and(eq(socialItems.id, record.id),
          eq(socialItems.connectionId, connection.id), isNull(socialItems.deletedAt)) });
        if (existing) {
          let detail: Awaited<ReturnType<typeof getFacebookComment>> | Awaited<ReturnType<typeof getInstagramComment>> | undefined;
          try { detail = facebook ? await getFacebookComment(existing.externalId, token) : await getInstagramComment(existing.externalId, token); }
          catch (error) {
            if (error instanceof MetaApiError && error.code === 100 && error.subcode === 33 && !error.transient) {
              await markSourceUnavailable(existing.id, task!.sourceReadVersion, assertOwnership);
            } else { sourceFailure = true; throw error; }
          }
          if (detail) {
            if (detail.id !== existing.externalId) { sourceFailure = true; throw new Error("Meta source verification identity mismatch"); }
            await upsertSocialItem({ connectionId: connection.id, platform: facebook ? "facebook" : "instagram", externalId: existing.externalId,
              parentExternalId: existing.parentExternalId, rootExternalId: existing.rootExternalId,
              itemType: existing.itemType === "reply" ? "reply" : existing.itemType === "mention" ? "mention" : "comment",
              text: facebook ? (detail as Awaited<ReturnType<typeof getFacebookComment>>).message ?? existing.text : (detail as Awaited<ReturnType<typeof getInstagramComment>>).text ?? existing.text,
              sourceReadVersion: task!.sourceReadVersion, raw: existing.raw,
            }, assertOwnership);
          }
        }
        task!.page.data.shift();
        if (!task!.page.data.length) progress.tasks.shift();
        await checkpoint();
        continue;
      }
      let child: SyncPageTask | undefined;
      if (task!.kind === "posts") {
        const postDate = parseDate(facebook ? record.created_time : record.timestamp);
        if (postDate && postDate.getTime() < cutoff) outsideLookbackParents++;
        const page = await readPage(facebook
          ? getFacebookComments(record.id, token, pageLimit) : getInstagramComments(record.id, token, pageLimit));
        child = { kind: "comments", page, root: record, sourceReadVersion: task!.sourceReadVersion };
        parents++;
      } else {
        const root = task!.root!;
        const parentId = task!.kind === "replies" ? task!.parent!.id : root.id;
        if (record.id !== parentId) {
          if (facebook && record.parent?.id === record.id) { sourceFailure = true; throw new Error("Meta comment cannot be its own parent"); }
          await upsertSocialItem({
            connectionId: connection.id, platform: facebook ? "facebook" : "instagram", externalId: record.id,
            parentExternalId: facebook ? record.parent?.id ?? parentId : parentId, rootExternalId: root.id,
            itemType: task!.kind === "replies" || (facebook && record.parent?.id && record.parent.id !== root.id) ? "reply" : "comment",
            authorId: record.from?.id ?? null, authorName: facebook ? record.from?.name ?? null : record.username ?? null,
            text: facebook ? record.message ?? "" : record.text ?? "",
            permalink: record.permalink_url ?? root.permalink_url ?? root.permalink ?? null,
            sourceCreatedAt: parseDate(facebook ? record.created_time : record.timestamp),
            sourceReadVersion: task!.sourceReadVersion,
            raw: { ...record, replies: undefined, context_incomplete: false, source_post: { id: root.id, text: facebook ? root.message ?? null : root.caption ?? null, permalink: root.permalink_url ?? root.permalink ?? null } },
          }, assertOwnership);
          items++;
        }
        if (task!.kind === "comments") {
          const embedded = !facebook && record.replies;
          const page = embedded ? await readPage(Promise.resolve(embedded)) : { data: [] };
          child = { kind: "replies", page, root, parent: record, sourceReadVersion: task!.sourceReadVersion, fetchPending: !embedded };
        }
      }
      task!.page.data.shift();
      task!.attempts = 0;
      task!.availableAt = undefined;
      task!.error = undefined;
      if (!task!.page.data.length && !task!.page.paging?.next) progress.tasks.shift();
      if (child && (child.fetchPending || child.page.data.length || child.page.paging?.next)) progress.tasks.unshift(child);
      if (child || steps % 25 === 0) await checkpoint();
    } catch (error) {
      if ((error instanceof Error && error.message === "sync lease lost") || (error instanceof MetaApiError && error.code === 190)) throw error;
      if (!sourceFailure) throw error;
      const failed: SyncPageTask = { ...task!, page: task!.page.data.length
        ? { data: [task!.page.data[0]!] } : task!.page,
        attempts: (task!.attempts ?? 0) + 1, error: safeErrorMessage(error, 1000) };
      if (task!.page.data.length) {
        task!.page.data.shift();
        if (!task!.page.data.length && !task!.page.paging?.next) progress.tasks.shift();
      } else progress.tasks.shift();
      if (failed.attempts! >= cfg.SYNC_MAX_RETRIES) progress.deadTasks.push(failed);
      else {
        failed.availableAt = Date.now() + Math.min(3600000, 30000 * 2 ** (failed.attempts! - 1));
        progress.tasks.push(failed);
      }
      await checkpoint();
      log.warn("sync.task_failed", { connectionId: connection.id, kind: failed.kind, attempts: failed.attempts, message: failed.error });
    }
  }
  await checkpoint();
  return { items, parents, outsideLookbackParents, coverageLimited: Boolean(progress.tasks.length || progress.deadTasks.length),
    failedTasks: progress.deadTasks.length, retryTasks: progress.tasks.filter((task) => task.attempts).length };
}

export async function syncConnection(connection: typeof socialConnections.$inferSelect, leaseId?: string, retryFailed = false) {
  if (connection.status === "disabled" || connection.status === "revoked") return { skipped: true, items: 0, parents: 0 };
  const deadline = Date.now() + env().SYNC_RUN_BUDGET_MS;
  const ownedRow = () => leaseId
    ? and(eq(socialConnections.id, connection.id), eq(socialConnections.syncLockId, leaseId), inArray(socialConnections.status, ["active", "degraded"]), eq(socialConnections.encryptedAccessToken, connection.encryptedAccessToken))
    : and(eq(socialConnections.id, connection.id), inArray(socialConnections.status, ["active", "degraded"]), eq(socialConnections.encryptedAccessToken, connection.encryptedAccessToken));
  const heartbeat = leaseId ? async () => {
    const held = await db.update(socialConnections).set({ syncLockedAt: new Date(), updatedAt: new Date() })
      .where(ownedRow())
      .returning({ id: socialConnections.id });
    if (!held.length) throw new Error("sync lease lost");
  } : undefined;
  const assertOwnership = async (tx: Transaction) => {
    const held = await tx.select({ id: socialConnections.id }).from(socialConnections).where(ownedRow()).for("share");
    if (!held.length) throw new Error("sync lease lost");
  };
  try {
    const token = decryptSecret(connection.encryptedAccessToken);
    await heartbeat?.();
    await maybeRotateConnectionToken(connection, token);
    const savedProgress = connection.syncState.continuation;
    const saved = typeof savedProgress === "string" ? syncProgressSchema.parse(JSON.parse(decryptSecret(savedProgress))) : { tasks: [], deadTasks: [] };
    const progress: SyncProgress = { ...saved, sourceReadVersion: await beginSourceRead() };
    if (retryFailed) {
      progress.tasks.push(...progress.deadTasks.map((task) => ({ ...task, attempts: 0, availableAt: undefined, error: undefined })));
      progress.deadTasks = [];
    }
    const checkpoint = async () => {
      const runnable = progress.tasks.some((task) => !task.availableAt || task.availableAt <= Date.now());
      const retryAt = !runnable && progress.tasks.length ? Math.min(...progress.tasks.map((task) => task.availableAt ?? 0)) : null;
      const held = await db.update(socialConnections).set({
        syncState: sql`${socialConnections.syncState} || jsonb_build_object('continuation', ${progress.tasks.length || progress.deadTasks.length ? encryptSecret(JSON.stringify({ tasks: progress.tasks, deadTasks: progress.deadTasks })) : null}::text, 'syncPending', ${progress.tasks.length}::int, 'syncDead', ${progress.deadTasks.length}::int, 'syncRetryAt', ${retryAt}::bigint)`,
        updatedAt: new Date(),
      }).where(ownedRow()).returning({ id: socialConnections.id });
      if (!held.length) throw new Error("sync lease lost");
    };
    if (!progress.tasks.length) {
      const page = syncListSchema.parse(connection.platform === "instagram"
        ? await getInstagramMedia(connection.externalAccountId, token, Math.min(100, env().SYNC_MAX_POSTS_PER_CONNECTION))
        : await getFacebookPosts(connection.externalAccountId, token, Math.min(100, env().SYNC_MAX_POSTS_PER_CONNECTION)));
      progress.tasks.push({ kind: "posts", page, sourceReadVersion: progress.sourceReadVersion });
      await checkpoint();
    }
    const scheduledChecks = [...progress.tasks, ...progress.deadTasks].filter((task) => task.kind === "verify").flatMap((task) => task.page.data.map((record) => record.id));
    const checks = await db.select({ id: socialItems.id }).from(socialItems).where(and(
      eq(socialItems.connectionId, connection.id), isNull(socialItems.deletedAt),
      scheduledChecks.length ? notInArray(socialItems.id, scheduledChecks) : undefined,
      or(isNull(socialItems.sourceCheckedAt), lt(socialItems.sourceCheckedAt, new Date(Date.now() - 3600000))),
    )).orderBy(sql`${socialItems.sourceCheckedAt} asc nulls first`, asc(socialItems.id)).limit(25);
    if (checks.length) {
      progress.tasks.push({ kind: "verify", page: { data: checks }, sourceReadVersion: progress.sourceReadVersion });
      await checkpoint();
    }
    const result = await processSyncTasks(connection, token, progress, checkpoint, heartbeat, assertOwnership, deadline);
    const failedTask = progress.deadTasks[0] ?? progress.tasks.find((task) => task.error);
    const taskErrors = result.failedTasks || result.retryTasks ? `sync_error:${result.failedTasks} exhausted tasks; ${result.retryTasks} retry tasks; ${failedTask?.kind ?? "unknown"}: ${failedTask?.error ?? "source unavailable"}` : null;
    const completed = await db.update(socialConnections).set({
      syncState: sql`${socialConnections.syncState} || jsonb_build_object('syncError', ${taskErrors}::text)`,
      lastError: sql`nullif(concat_ws('; ', ${taskErrors}::text, ${socialConnections.syncState}->>'healthError'), '')`,
      ...(taskErrors ? { status: "degraded" } : {}),
      ...(!progress.tasks.length && !progress.deadTasks.length ? { lastSyncedAt: new Date() } : {}),
      syncAttemptedAt: new Date(),
      updatedAt: new Date(),
    }).where(ownedRow()).returning({ id: socialConnections.id });
    if (!completed.length) throw new Error("sync lease lost");
    return { skipped: false, ...result };
  } catch (error) {
    if (error instanceof Error && error.message === "sync lease lost") throw error;
    const message = safeErrorMessage(error);
    const revoked = error instanceof MetaApiError && error.code === 190;
    const failed = await db.update(socialConnections).set({
      status: revoked ? "revoked" : "degraded",
      lastError: sql`concat_ws('; ', ${`sync_error:${message}`}::text, ${socialConnections.syncState}->>'healthError')`,
      syncState: sql`${socialConnections.syncState} || jsonb_build_object('syncError', ${`sync_error:${message}`}::text)`,
      syncAttemptedAt: new Date(),
      updatedAt: new Date(),
    }).where(ownedRow()).returning({ id: socialConnections.id });
    if (!failed.length) throw new Error("sync lease lost");
    log.warn("sync.connection_failed", { connectionId: connection.id, platform: connection.platform, revoked, message });
    throw error;
  } finally {
    if (leaseId) {
      // Only the worker that owns the lease may release it. A stale worker must not clear a newer lease.
      await db.update(socialConnections).set({ syncLockedAt: null, syncLockId: null })
        .where(and(eq(socialConnections.id, connection.id), eq(socialConnections.syncLockId, leaseId)))
        .catch((error) => log.warn("sync.lease_release_failed", { connectionId: connection.id, message: safeErrorMessage(error) }));
    }
  }
}

async function claimConnections(connectionId?: string, dueOnly = false) {
  const cfg = env();
  const leaseId = crypto.randomUUID();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - cfg.SYNC_LEASE_MS);
  const limit = connectionId ? 1 : Math.min(cfg.SYNC_CONNECTION_BATCH_SIZE, cfg.SYNC_CONCURRENCY);
  const idFilter = connectionId ? sql`and id = ${connectionId}` : sql``;
  const dueBefore = new Date(now.getTime() - cfg.RECONCILE_INTERVAL_MS);
  const dueFilter = dueOnly ? sql`and (sync_attempted_at is null or sync_attempted_at <= ${dueBefore.toISOString()}
    or (sync_state->>'continuation' is not null and (sync_state->>'syncPending' is null or (sync_state->>'syncPending')::int > 0)
      and (sync_state->>'syncRetryAt' is null or (sync_state->>'syncRetryAt')::bigint <= ${now.getTime()}))
    or (sync_locked_at is not null and sync_locked_at < ${staleBefore.toISOString()}))` : sql``;

  // One SQL statement performs selection + row lock + lease update atomically.
  // This is intentionally raw SQL: FOR UPDATE SKIP LOCKED is the concurrency boundary
  // and must remain obvious/auditable across Drizzle upgrades.
  const claimedResult = await db.execute(sql`
    with candidates as (
      select id
      from social_connections
      where status in ('active', 'degraded')
        and (sync_locked_at is null or sync_locked_at < ${staleBefore.toISOString()})
        ${idFilter}
        ${dueFilter}
      order by sync_attempted_at asc nulls first, id
      for update skip locked
      limit ${limit}
    )
    update social_connections as sc
    set sync_locked_at = ${now.toISOString()},
        sync_lock_id = ${leaseId},
        sync_attempted_at = ${now.toISOString()},
        updated_at = ${now.toISOString()}
    from candidates
    where sc.id = candidates.id
    returning sc.id
  `);

  const claimedIds = Array.from(claimedResult as unknown as Iterable<{ id: string }>).map((row) => row.id);
  if (!claimedIds.length) return { leaseId, rows: [] as Array<typeof socialConnections.$inferSelect> };
  const rows = await db.select().from(socialConnections).where(inArray(socialConnections.id, claimedIds));
  return { leaseId, rows };
}

export async function syncAllConnections(connectionId?: string, dueOnly = false, retryFailed = false) {
  const cfg = env();
  const { leaseId, rows } = await claimConnections(connectionId, dueOnly);

  return mapLimit(rows, cfg.SYNC_CONCURRENCY, async (connection) => {
    try {
      const result = await syncConnection(connection, leaseId, retryFailed);
      return { connectionId: connection.id, ok: true as const, items: result.items, parents: result.parents,
        skipped: result.skipped, coverageLimited: "coverageLimited" in result ? result.coverageLimited : false,
        failedTasks: "failedTasks" in result ? result.failedTasks : 0, retryTasks: "retryTasks" in result ? result.retryTasks : 0,
        outsideLookbackParents: "outsideLookbackParents" in result ? result.outsideLookbackParents : 0 };
    } catch (error) {
      return { connectionId: connection.id, ok: false as const, error: safeErrorMessage(error) };
    }
  });
}
