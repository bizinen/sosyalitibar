import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { connectionTargets, monitoringTargets, socialConnections } from "@/db/schema";
import { env } from "@/lib/config";
import { AdminNav } from "@/app/components/AdminNav";
import { OperationsActions } from "@/app/components/OperationsActions";
import { ConnectionTargetManager } from "@/app/components/ConnectionTargetManager";
import { ConnectionActions } from "@/app/components/ConnectionActions";

export default async function MetaSettingsPage() {
  if (!(await isAdmin())) redirect("/login");
  const [connections, targets, mappings] = await Promise.all([
    db.select().from(socialConnections).orderBy(asc(socialConnections.platform), asc(socialConnections.displayName)),
    db.select({ id: monitoringTargets.id, name: monitoringTargets.name, enabled: monitoringTargets.enabled }).from(monitoringTargets).orderBy(asc(monitoringTargets.name)),
    db.select({ connectionId: connectionTargets.connectionId, targetId: connectionTargets.targetId }).from(connectionTargets),
  ]);
  const mappingByConnection = new Map<string, string[]>();
  for (const row of mappings) mappingByConnection.set(row.connectionId, [...(mappingByConnection.get(row.connectionId) ?? []), row.targetId]);
  const cfg = env();
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Meta bağlantıları</h1><p className="muted" style={{margin:"6px 0 0"}}>Facebook Page ve bağlı Instagram Professional hesaplarının token, scope, webhook ve reconciliation durumu.</p></div><OperationsActions /></div>
    <section className="panel" style={{marginBottom:18}}><div className="panel-head"><h2>Uygulama yapılandırması</h2></div><div className="panel-body two-col">
      <div><div className="small muted">Meta App ID</div><div className="code">••••{cfg.META_APP_ID.slice(-6)}</div></div>
      <div><div className="small muted">Graph sürümü</div><div className="code">{cfg.META_GRAPH_VERSION}</div></div>
      <div><div className="small muted">Webhook callback</div><div className="code">{new URL("/api/webhooks/meta", cfg.APP_URL).toString()}</div></div>
      <div><div className="small muted">İstenen scope'lar</div><div className="small">{cfg.META_SCOPES.split(",").join(" · ")}</div></div>
    </div></section>
    <section className="panel"><div className="panel-head"><h2>Bağlı kaynaklar</h2><span className="badge">{connections.length}</span></div>
      {connections.length === 0 ? <div className="empty">Henüz kaynak bağlı değil. “Meta hesabı bağla” ile başlayın.</div> : <div className="table-wrap"><table><thead><tr><th>Kaynak</th><th>Sağlık</th><th>Scope</th><th>Webhook / Sync</th><th>İşlem</th></tr></thead><tbody>
        {connections.map((c) => <tr key={c.id}><td><strong>{c.displayName}</strong><div className="small muted">{c.platform}{c.username ? ` · @${c.username}` : ""}</div><div className="small muted code">{c.externalAccountId}</div></td><td><span className={`badge ${c.status === "active" ? "ok" : c.status === "revoked" ? "danger" : "warn"}`}>{c.status}</span>{c.lastError ? <div className="small muted" style={{marginTop:6,maxWidth:360}}>{c.lastError}</div> : null}<div className="small muted">Kontrol: {c.healthCheckedAt?.toLocaleString("tr-TR") || "—"}</div>{c.tokenExpiresAt ? <div className="small muted">Token: {c.tokenExpiresAt.toLocaleString("tr-TR")}</div> : null}</td><td><div className="small" style={{maxWidth:420}}>{c.grantedScopes.length ? c.grantedScopes.join(" · ") : "Scope henüz doğrulanmadı"}</div></td><td><div><span className={`badge ${c.platform === "facebook" && c.webhookSubscribed ? "ok" : ""}`}>{c.platform === "facebook" ? (c.webhookSubscribed ? "Page webhook bağlı" : "Page webhook kontrol et") : "IG webhook App Dashboard"}</span></div><div className="small muted" style={{marginTop:6}}>Son sync: {c.lastSyncedAt?.toLocaleString("tr-TR") || "—"}</div><div className="small muted">Son deneme: {c.syncAttemptedAt?.toLocaleString("tr-TR") || "—"}</div></td><td><ConnectionActions id={c.id} status={c.status} displayName={c.displayName} /></td></tr>)}
      </tbody></table></div>}
    </section>
    <ConnectionTargetManager
      connections={connections.map((c) => ({ id: c.id, platform: c.platform, displayName: c.displayName, username: c.username, targetIds: mappingByConnection.get(c.id) ?? [] }))}
      targets={targets}
    />
    <div className="notice" style={{marginTop:18}}>Instagram yorum webhook alanını Meta Developer Dashboard → Webhooks → Instagram altında <strong>comments</strong> için bu callback'e bağlayın. Facebook Page tarafında uygulama <span className="code">feed</span> alanına programatik olarak abone olmaya çalışır. Reconciliation senkronu webhook kaçırmalarına karşı güvenlik ağıdır.</div>
  </main></div>;
}
