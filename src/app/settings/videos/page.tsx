import { redirect } from "next/navigation";
import { asc, desc, eq, ne, sql } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { socialConnections, watchedVideos } from "@/db/schema";
import { AdminNav } from "@/app/components/AdminNav";
import { WatchedVideos } from "@/app/components/WatchedVideos";

export default async function VideosPage() {
  if (!(await isAdmin())) redirect("/login");
  const [videos, connections] = await Promise.all([
    db.select({ id: watchedVideos.id, platform: watchedVideos.platform, url: watchedVideos.url, title: watchedVideos.title,
      channelName: watchedVideos.channelName, status: watchedVideos.status, revision: watchedVideos.revision,
      provider: watchedVideos.provider, resultsLimit: watchedVideos.resultsLimit, pollMinutes: watchedVideos.pollMinutes,
      maxChargeCents: watchedVideos.maxChargeCents, lastRunId: watchedVideos.lastRunId, lastRunCount: watchedVideos.lastRunCount,
      lastError: watchedVideos.lastError, lastSyncedAt: watchedVideos.lastSyncedAt, lockedAt: watchedVideos.lockedAt,
      checkedAt: sql<number>`(extract(epoch from now()) * 1000)::float8`,
      continuing: sql<boolean>`${watchedVideos.progressEncrypted} is not null`,
      count: sql<number>`(select count(*)::int from social_items i where i.platform = ${watchedVideos.platform}
        and i.root_external_id = ${watchedVideos.externalId} and i.deleted_at is null)`,
    }).from(watchedVideos).where(ne(watchedVideos.status, "removed")).orderBy(desc(watchedVideos.createdAt)),
    db.select({ id: socialConnections.id, name: socialConnections.displayName, platform: socialConnections.platform })
      .from(socialConnections).where(eq(socialConnections.status, "active")).orderBy(asc(socialConnections.displayName)),
  ]);
  const [key] = await db.select({ id: watchedVideos.id }).from(watchedVideos)
    .where(sql`${watchedVideos.platform} = 'youtube' and ${watchedVideos.provider} = 'official' and ${watchedVideos.apiKeyEncrypted} is not null`).limit(1);
  const [apifyKey] = await db.select({ id: watchedVideos.id }).from(watchedVideos)
    .where(sql`${watchedVideos.provider} = 'apify' and ${watchedVideos.apiKeyEncrypted} is not null`).limit(1);
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>İzlenen videolar</h1><p className="muted">Başka kanallardaki video ve paylaşımların yorumlarını tek yerde takip et.</p></div></div>
    <WatchedVideos videos={videos.map((video) => ({ ...video, lastSyncedAt: video.lastSyncedAt?.toISOString() ?? null,
      lockedAt: video.lockedAt?.toISOString() ?? null }))} connections={connections} hasYouTubeKey={Boolean(key)} hasApifyKey={Boolean(apifyKey)} checkedAt={videos[0]?.checkedAt ?? 0} />
  </main></div>;
}
