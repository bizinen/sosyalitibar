import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, socialItems, watchedVideos } from "@/db/schema";
import { lockAnalysisContext } from "@/lib/analysis-state";
import { decryptSecret } from "@/lib/crypto";
import { apifyProgressSchema } from "@/lib/apify-videos";
import { removeSourceSyncState } from "@/lib/sync";

export async function deleteSource(platform: string, sourceId: string, revision: number | null) {
  return db.transaction(async (tx) => {
    // Match ingestion lock order; revoke the watch lease before deleting its items.
    await lockAnalysisContext(tx, true);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_videos'))`);
    const [watch] = await tx.select().from(watchedVideos).where(and(eq(watchedVideos.platform, platform), eq(watchedVideos.externalId, sourceId))).for("update");
    if (watch?.sourceKind === "channel") return { error: "invalid_source" } as const;
    if ((watch?.revision ?? null) !== revision) return { error: "conflict" } as const;
    const condition = and(eq(socialItems.platform, platform), eq(socialItems.rootExternalId, sourceId))!;
    const [count] = await tx.select({ count: sql<number>`count(*)::int` }).from(socialItems).where(condition);
    if (!watch && !count?.count) return { error: "not_found" } as const;
    let abort: { runId: string; key: string } | undefined;
    let abortUnconfirmed = false;
    if (watch?.provider === "apify" && watch.progressEncrypted && watch.apiKeyEncrypted) {
      try {
        const progress = apifyProgressSchema.safeParse(JSON.parse(decryptSecret(watch.progressEncrypted)));
        if (progress.success && progress.data.phase === "running" && progress.data.verified && progress.data.runId) abort = { runId: progress.data.runId, key: watch.apiKeyEncrypted };
        else if (!progress.success || progress.data.phase !== "dataset") abortUnconfirmed = true;
      } catch { abortUnconfirmed = true; }
    }
    const fields = { status: "removed", purgedAt: new Date(), revision: (watch?.revision ?? 0) + 1,
      url: "", channelId: null, title: null, sourceText: null, channelName: null, profileImageUrl: null, metadataCheckedAt: null,
      apiKeyEncrypted: null, credentialConnectionId: null, progressEncrypted: null, lastRunId: null, lastRunCount: null,
      lockId: null, lockedAt: null, attempts: 0, lastError: null, lastSyncedAt: null, updatedAt: new Date() };
    const [marker] = watch ? await tx.update(watchedVideos).set(fields).where(eq(watchedVideos.id, watch.id)).returning({ id: watchedVideos.id })
      : await tx.insert(watchedVideos).values({ platform, externalId: sourceId, ...fields }).returning({ id: watchedVideos.id });
    if (platform !== "youtube") {
      const items = await tx.select({ id: socialItems.id, externalId: socialItems.externalId }).from(socialItems).where(condition);
      await removeSourceSyncState(tx, platform, sourceId, new Set(items.flatMap(item => [item.id, item.externalId])));
    }
    // Remove only matching webhook changes, preserving other posts in shared payloads.
    await tx.execute(sql`
      with cleaned as (
        select w.id, w.payload, bool_or(changes.removed) as matched,
          coalesce(jsonb_agg(case when changes.removed then e.value || jsonb_build_object('changes', changes.kept) else e.value end order by e.ordinality)
          filter (where not changes.removed or jsonb_array_length(changes.kept) > 0), '[]'::jsonb) as entries
        from webhook_events w cross join lateral jsonb_array_elements(
          case when jsonb_typeof(w.payload->'entry') = 'array' then w.payload->'entry' else '[]'::jsonb end) with ordinality e(value, ordinality)
        cross join lateral (
          select coalesce(jsonb_agg(c.value order by c.ordinality) filter (where not (
            coalesce(c.value->'value'->>'post_id', c.value->'value'->>'post', c.value->'value'->>'media_id', c.value->'value'->'media'->>'id', '') = ${sourceId}
            or coalesce(c.value->'value'->>'comment_id', c.value->'value'->>'id', '') in (select external_id from social_items where ${condition})
          )), '[]'::jsonb) as kept,
          coalesce(bool_or(coalesce(c.value->'value'->>'post_id', c.value->'value'->>'post', c.value->'value'->>'media_id', c.value->'value'->'media'->>'id', '') = ${sourceId}
            or coalesce(c.value->'value'->>'comment_id', c.value->'value'->>'id', '') in (select external_id from social_items where ${condition})), false) as removed
          from jsonb_array_elements(case when jsonb_typeof(e.value->'changes') = 'array' then e.value->'changes' else '[]'::jsonb end) with ordinality c(value, ordinality)
        ) changes
        where coalesce(w.object_type, w.payload->>'object') = ${platform === "facebook" ? "page" : platform}
        group by w.id
      ), changed as (
        select * from cleaned where matched
      )
      update webhook_events w set payload = jsonb_set(changed.payload, '{entry}', changed.entries),
        status = case when jsonb_array_length(changed.entries) = 0 then 'processed' when w.status = 'processing' then 'pending' else w.status end,
        lock_id = null, locked_at = null, error = null, attempts = case when w.status = 'processing' then 0 else w.attempts end,
        processed_at = case when jsonb_array_length(changed.entries) = 0 then now() else w.processed_at end
      from changed where w.id = changed.id
    `);
    const items = tx.select({ id: sql<string>`${socialItems.id}::text` }).from(socialItems).where(condition);
    await tx.delete(auditLogs).where(and(eq(auditLogs.entityType, "social_item"), inArray(auditLogs.entityId, items)));
    // FK cascades delete analyses, alerts, translations and review history atomically.
    const deleted = await tx.execute(sql`with removed as (delete from social_items where ${condition} returning id) select count(*)::int as count from removed`);
    await tx.delete(auditLogs).where(and(eq(auditLogs.entityType, "watched_video"), eq(auditLogs.entityId, marker!.id)));
    await tx.insert(auditLogs).values({ actor: "admin", action: "source.purged", entityType: "watched_video", entityId: marker!.id,
      metadata: { commentsDeleted: Number(deleted[0]?.count ?? 0) } });
    return { deleted: true, commentsDeleted: Number(deleted[0]?.count ?? 0), abort, abortUnconfirmed } as const;
  });
}
