import { redirect } from "next/navigation";
import { desc, sql } from "drizzle-orm";
import { alertOutbox } from "@/db/schema";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { env } from "@/lib/config";
import { AdminNav } from "@/app/components/AdminNav";
import { AlertRequeueButton } from "@/app/components/AlertRequeueButton";

function payloadView(payload: Record<string, unknown>) {
  const analysis = (payload.analysis && typeof payload.analysis === "object" ? payload.analysis : {}) as Record<string, unknown>;
  const item = (payload.item && typeof payload.item === "object" ? payload.item : {}) as Record<string, unknown>;
  return {
    reason: typeof payload.reason === "string" ? payload.reason : "—",
    severity: typeof analysis.severity === "number" ? analysis.severity : null,
    target: typeof analysis.matched_target === "string" ? analysis.matched_target : "—",
    summary: typeof analysis.summary === "string" ? analysis.summary : "—",
    platform: typeof item.platform === "string" ? item.platform : "—",
    text: typeof item.text === "string" ? item.text : "",
  };
}

export default async function AlertSettingsPage() {
  if (!(await isAdmin())) redirect("/login");
  const cfg = env();
  const [rows, counts] = await Promise.all([
    db.select().from(alertOutbox).orderBy(desc(alertOutbox.createdAt)).limit(100),
    db.select({ status: alertOutbox.status, count: sql<number>`count(*)::int` }).from(alertOutbox).groupBy(alertOutbox.status),
  ]);
  const byStatus = Object.fromEntries(counts.map((x) => [x.status, x.count]));
  let endpoint = "Kapalı";
  if (cfg.ALERT_WEBHOOK_URL) {
    const u = new URL(cfg.ALERT_WEBHOOK_URL);
    endpoint = `${u.protocol}//${u.host}${u.pathname}`;
  }

  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Kritik alarm teslimatı</h1><p className="muted" style={{margin:"6px 0 0"}}>Yüksek risk/tehdit analizlerini ayrı outbox kuyruğu ile imzalı webhook endpoint'ine güvenli biçimde iletir.</p></div></div>
    <div className="grid-stats">
      <div className="stat"><div className="stat-label">Bekleyen</div><div className="stat-value">{(byStatus.pending ?? 0) + (byStatus.retry ?? 0)}</div></div>
      <div className="stat"><div className="stat-label">Teslim</div><div className="stat-value">{byStatus.delivered ?? 0}</div></div>
      <div className="stat"><div className="stat-label">Dead-letter</div><div className="stat-value">{byStatus.dead ?? 0}</div></div>
      <div className="stat"><div className="stat-label">Eşik</div><div className="stat-value">{cfg.ALERT_SEVERITY_THRESHOLD}</div></div>
    </div>
    <section className="panel" style={{marginBottom:18}}><div className="panel-head"><h2>Yönlendirme</h2><span className={`badge ${cfg.ALERT_WEBHOOK_URL ? "ok" : "warn"}`}>{cfg.ALERT_WEBHOOK_URL ? "aktif" : "kapalı"}</span></div><div className="panel-body two-col">
      <div><div className="small muted">Endpoint</div><div className="code">{endpoint}</div></div>
      <div><div className="small muted">Kural</div><div className="small">severity ≥ {cfg.ALERT_SEVERITY_THRESHOLD}{cfg.ALERT_ON_THREAT ? " veya contains_threat=true" : ""}</div></div>
      <div><div className="small muted">İmza</div><div className="small"><span className="code">X-Sosyal-Itibar-Signature-256</span> · HMAC-SHA256</div></div>
      <div><div className="small muted">Idempotency</div><div className="small"><span className="code">Idempotency-Key</span> her alarm için sabittir.</div></div>
    </div></section>
    <section className="panel"><div className="panel-head"><h2>Son teslimatlar</h2><span className="badge">{rows.length}</span></div>
      {rows.length === 0 ? <div className="empty">Henüz alarm oluşmadı.</div> : <div className="table-wrap"><table><thead><tr><th>Alarm</th><th>Risk</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>{rows.map((row) => {
        const p = payloadView(row.payload);
        return <tr key={row.id}><td><div className="meta-line"><span className="badge">{p.platform}</span><span>{p.target}</span><span>{row.createdAt.toLocaleString("tr-TR")}</span></div><strong>{p.summary}</strong>{p.text ? <div className="summary comment-text">{p.text}</div> : null}<div className="small muted" style={{marginTop:6}}>{p.reason}</div></td><td><span className={`badge ${p.severity !== null && p.severity >= 90 ? "danger" : "warn"}`}>{p.severity ?? "—"}</span></td><td><span className={`badge ${row.status === "delivered" ? "ok" : row.status === "dead" ? "danger" : row.status === "retry" ? "warn" : ""}`}>{row.status}</span><div className="small muted" style={{marginTop:6}}>Deneme: {row.attempts}</div>{row.lastError ? <div className="small muted" style={{maxWidth:420,marginTop:6}}>{row.lastError}</div> : null}</td><td>{row.status === "dead" || row.status === "retry" ? <AlertRequeueButton id={row.id} /> : "—"}</td></tr>;
      })}</tbody></table></div>}
    </section>
    <div className="notice" style={{marginTop:18}}>Alarm webhook'u doğrudan Telegram olmak zorunda değildir. n8n/Make veya kendi notification gateway'iniz HMAC imzasını doğrulayıp Telegram, e-posta ya da başka bir kanala yönlendirebilir. Otomatik içerik silme/banlama bu alarm akışının parçası değildir.</div>
  </main></div>;
}
