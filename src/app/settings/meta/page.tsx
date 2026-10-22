import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { connectionTargets, monitoringTargets, socialConnections } from "@/db/schema";
import { metaConfigured, llmConfigured } from "@/lib/config";
import { getMetaSettings } from "@/lib/meta-settings";
import { MetaSettingsForm } from "@/app/components/MetaSettingsForm";
import { getLlmSettings } from "@/lib/llm-settings";
import { SetupLink } from "@/app/components/SetupLink";
import { AdminNav } from "@/app/components/AdminNav";
import { OperationsActions } from "@/app/components/OperationsActions";
import { AccountList } from "@/app/components/AccountList";
import { UiIcon } from "@/app/components/UiIcon";
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
  const metaCfg = await getMetaSettings();
  const metaReady = metaConfigured(metaCfg) && metaCfg.metaPublicOrigin.startsWith("https://");
  const enabledTargetIds = new Set(targets.filter((target) => target.enabled).map((target) => target.id));
  const unmapped = connections.filter((connection) => connection.status !== "disabled"
    && !(mappingByConnection.get(connection.id) ?? []).some((targetId) => enabledTargetIds.has(targetId)));
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Hesaplarım</h1><p className="muted" style={{margin:"6px 0 0"}}>Bağlantıları ve hesap sahipliğini yönet.</p></div><OperationsActions /></div>
    {!metaReady ? <div className="notice" role="alert">Meta bağlantısı henüz yapılandırılmadı. Gerçek App ID ve App Secret ayarlandıktan sonra hesap bağlanabilir.</div> : null}
    {!llmConfigured(cfg) ? <div className="notice" role="alert">AI modeli henüz ayarlanmadı. Yorumlar korunur ve analiz için bekler. <Link className="text-link" href="/settings/llm">AI ayarlarını gör</Link></div> : null}
    {unmapped.length ? <div className="notice" role="alert">{unmapped.length} hesabın sahibi henüz belirtilmedi. “Sen/siz” gibi isim içermeyen yorumların kime yöneldiğini anlayabilmek için hesap kartından kişi veya kurum seç.</div> : null}
    <section className="connect-panel" id="connect"><div><h2>Hesap ekle</h2><p>Facebook sayfalarını ve bağlı Instagram Professional hesaplarını Meta üzerinden bağla.</p></div>{metaReady ? <a className="btn primary" href={new URL("/api/meta/connect", metaCfg.metaPublicOrigin).toString()}><UiIcon name="plus" size={17} />Meta ile hesap bağla</a> : <SetupLink />}</section>
    <AccountList accounts={connections.map((c) => ({ id: c.id, platform: c.platform, displayName: c.displayName, username: c.username, status: c.status, lastError: c.lastError, externalAccountId: c.externalAccountId, grantedScopes: c.grantedScopes, webhookSubscribed: c.webhookSubscribed, lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null, healthCheckedAt: c.healthCheckedAt?.toISOString() ?? null, tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null, targetIds: mappingByConnection.get(c.id) ?? [] }))} targets={targets} />
    <details className="settings-disclosure" id="connection-setup" open={!metaReady}><summary>Meta uygulaması ve bağlantı kurulumu</summary><MetaSettingsForm loginConfigId={metaCfg.metaLoginConfigId} appId={/^\d+$/.test(metaCfg.META_APP_ID) ? metaCfg.META_APP_ID : ""} publicOrigin={metaCfg.metaPublicOrigin} graphVersion={metaCfg.META_GRAPH_VERSION} hasSecret={metaCfg.META_APP_SECRET !== "local-not-configured" && metaCfg.META_APP_SECRET.length >= 16} hasVerifyToken={metaCfg.META_WEBHOOK_VERIFY_TOKEN.length >= 16} revision={metaCfg.metaSettingsRevision} scopes={metaCfg.META_SCOPES.split(",")} /></details>
    <p className="small muted">Birden fazla dilde kullandığın hesapları aynı kişi veya kurumla eşleştirebilirsin. <Link className="text-link" href="/settings/targets">Kişileri ve kurumları yönet</Link> · <Link className="text-link" href="/settings/llm">AI ayarlarını gör</Link></p>
  </main></div>;
}
