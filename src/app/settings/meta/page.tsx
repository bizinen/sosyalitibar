import { redirect } from "next/navigation";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { connectionTargets, monitoringTargets, socialConnections, watchedVideos } from "@/db/schema";
import { AccountsWorkspace } from "@/app/components/AccountsWorkspace";
import { metaConfigured, llmConfigured } from "@/lib/config";
import { getMetaSettings } from "@/lib/meta-settings";
import { getYouTubeSettings } from "@/lib/youtube-settings";
import { getLlmSettings } from "@/lib/llm-settings";
import { AdminNav } from "@/app/components/AdminNav";
import Link from "next/link";

export default async function MetaSettingsPage() {
  if (!(await isAdmin())) redirect("/login");
  const [connections, targets, mappings] = await Promise.all([
    db.select().from(socialConnections).orderBy(asc(socialConnections.platform), asc(socialConnections.displayName)),
    db.select({ id: monitoringTargets.id, name: monitoringTargets.name, enabled: monitoringTargets.enabled }).from(monitoringTargets).orderBy(asc(monitoringTargets.name)),
    db.select({ connectionId: connectionTargets.connectionId, targetId: connectionTargets.targetId }).from(connectionTargets),
  ]);
  const mappingByConnection = new Map<string, string[]>();
  for (const row of mappings) mappingByConnection.set(row.connectionId, [...(mappingByConnection.get(row.connectionId) ?? []), row.targetId]);
  const cfg = await getLlmSettings();
  const channels = await db.select({ id: watchedVideos.id, title: watchedVideos.title, url: watchedVideos.url, status: watchedVideos.status,
    revision: watchedVideos.revision, analysisAfter: watchedVideos.analysisAfter, lastSyncedAt: watchedVideos.lastSyncedAt, lastError: watchedVideos.lastError,
    profileImageUrl: watchedVideos.profileImageUrl,
    continuing: sql<boolean>`${watchedVideos.progressEncrypted} is not null`,
    count: sql<number>`(select count(*)::int from watched_videos child where child.channel_id = watched_videos.id and child.status <> 'removed')`,
    scannedCount: sql<number>`(select count(*)::int from watched_videos child where child.channel_id = watched_videos.id and child.status <> 'removed' and child.last_synced_at is not null)`,
    blockedCount: sql<number>`(select count(*)::int from watched_videos child where child.channel_id = watched_videos.id and child.status = 'blocked')`,
    lastCommentScan: sql<number | null>`(select (extract(epoch from max(child.last_synced_at)) * 1000)::float8 from watched_videos child where child.channel_id = watched_videos.id and child.status <> 'removed')`,
  }).from(watchedVideos).where(and(eq(watchedVideos.sourceKind, "channel"), ne(watchedVideos.status, "removed"))).orderBy(desc(watchedVideos.createdAt));
  const youtubeKey = await getYouTubeSettings();
  const metaCfg = await getMetaSettings();
  const metaReady = metaConfigured(metaCfg) && metaCfg.metaPublicOrigin.startsWith("https://");
  const [clock] = await db.execute(sql`select (extract(epoch from now()) * 1000)::float8 as at`);
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Hesaplarım</h1><p className="muted" style={{margin:"6px 0 0"}}>Hesaplarını bağla, takip durumunu gör ve yorumlarına ulaş.</p></div><Link className="btn" href="/settings/integrations">Bağlantı ayarları</Link></div>
    {!metaReady ? <div className="notice" role="alert">Meta bağlantısı henüz hazırlanmadı. <Link className="text-link" href="/settings/integrations#meta">Bağlantı ayarlarından kurulumu tamamla</Link></div> : null}
    {!llmConfigured(cfg) ? <div className="notice" role="alert">AI modeli henüz ayarlanmadı. Yorumlar korunur ve analiz için bekler. <Link className="text-link" href="/settings/llm">AI ayarlarını gör</Link></div> : null}
    <AccountsWorkspace accounts={connections.map((c) => ({ id: c.id, platform: c.platform, displayName: c.displayName, username: c.username, status: c.status, lastError: c.lastError, externalAccountId: c.externalAccountId, grantedScopes: c.grantedScopes, webhookSubscribed: c.webhookSubscribed, lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null, healthCheckedAt: c.healthCheckedAt?.toISOString() ?? null, tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null, targetIds: mappingByConnection.get(c.id) ?? [] }))} targets={targets} channels={channels.map(channel => ({ ...channel, analysisAfter: channel.analysisAfter?.toISOString() ?? null, lastSyncedAt: channel.lastSyncedAt?.toISOString() ?? null }))} hasYouTubeKey={Boolean(youtubeKey)} metaConnectUrl={metaReady ? new URL("/api/meta/connect", metaCfg.metaPublicOrigin).toString() : null} checkedAt={Number(clock!.at)} />
    <p className="small muted">Birden fazla dilde kullandığın hesapları aynı kişi veya kurumla eşleştirebilirsin. <Link className="text-link" href="/settings/targets">Kişileri ve kurumları yönet</Link> · <Link className="text-link" href="/settings/llm">AI ayarlarını gör</Link></p>
  </main></div>;
}
