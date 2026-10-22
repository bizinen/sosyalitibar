import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, getTableColumns, lt, or, sql } from "drizzle-orm";
import { alertOutbox } from "@/db/schema";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { getAlertSettings } from "@/lib/alert-settings";
import { AlertSettingsForm } from "@/app/components/AlertSettingsForm";
import { AdminNav } from "@/app/components/AdminNav";
import { AlertRequeueButton } from "@/app/components/AlertRequeueButton";
import { decodeItemCursor, encodeItemCursor } from "@/lib/cursor";

const statusLabels: Record<string, string> = { pending: "Gönderim bekliyor", retry: "Tekrar denenecek", processing: "Gönderiliyor", delivered: "Teslim edildi", dead: "Müdahale gerekiyor", cancelled: "Geçersiz karar nedeniyle iptal" };

function payloadView(payload: Record<string, unknown>) {
  const analysis = (payload.analysis && typeof payload.analysis === "object" ? payload.analysis : {}) as Record<string, unknown>;
  const item = (payload.item && typeof payload.item === "object" ? payload.item : {}) as Record<string, unknown>;
  return {
    reason: payload.reason === "acil_inceleme" ? "Acil insan incelemesi gerekiyor" : payload.reason === "threat" ? "Tehdit işaretlendi" : typeof payload.reason === "string" && /^severity_gte_\d+$/.test(payload.reason) ? `Öncelik puanı ${payload.reason.slice(13)} eşiğine ulaştı` : "Alarm kuralı eşleşti",
    severity: typeof analysis.severity === "number" ? analysis.severity : null,
    target: typeof analysis.matched_target === "string" ? analysis.matched_target : "—",
    label: analysis.label === "acil_inceleme" ? "Acil inceleme" : null,
    summary: analysis.label === "acil_inceleme" ? "AI yorumu acil incelemeye ayırdı" : typeof analysis.summary === "string" ? analysis.summary : "—",
    platform: typeof item.platform === "string" ? item.platform : "—",
    text: typeof item.text === "string" ? item.text : "",
  };
}

export default async function AlertSettingsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  if (!(await isAdmin())) redirect("/login");
  const cursor = decodeItemCursor((await searchParams).cursor);
  const cfg = await getAlertSettings();
  const [pageRows, counts] = await Promise.all([
    db.select({ ...getTableColumns(alertOutbox), cursorAt: sql<string>`to_char(${alertOutbox.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(alertOutbox).where(cursor ? or(lt(alertOutbox.createdAt, sql`${cursor.preciseAt ?? cursor.at.toISOString()}::timestamptz`), and(eq(alertOutbox.createdAt, sql`${cursor.preciseAt ?? cursor.at.toISOString()}::timestamptz`), lt(alertOutbox.id, cursor.id))) : undefined).orderBy(desc(alertOutbox.createdAt), desc(alertOutbox.id)).limit(101),
    db.select({ status: alertOutbox.status, count: sql<number>`count(*)::int` }).from(alertOutbox).groupBy(alertOutbox.status),
  ]);
  const rows = pageRows.slice(0, 100);
  const last = rows.at(-1);
  const nextCursor = pageRows.length > 100 && last ? encodeItemCursor({ at: last.createdAt, id: last.id, preciseAt: last.cursorAt }) : null;
  const byStatus = Object.fromEntries(counts.map((x) => [x.status, x.count]));
  let endpoint = "Kapalı";
  if (cfg.ALERT_WEBHOOK_URL) {
    const u = new URL(cfg.ALERT_WEBHOOK_URL);
    endpoint = `${u.protocol}//${u.host}${u.pathname}`;
  }

  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Alarmlar</h1><p className="muted" style={{margin:"6px 0 0"}}>Hangi yorumun alarm oluşturduğunu ve bildirimin teslim edilip edilmediğini gör.</p></div></div>
    {!cfg.ALERT_WEBHOOK_URL ? <div className="notice" role="alert">Alarm teslimatı yapılandırılmamış. Kritik analiz kararları outbox kuyruğunda saklanır; endpoint ve imza anahtarı ayarlanana kadar gönderilmez.</div> : null}
    <div className="grid-stats">
      <div className="stat"><div className="stat-label">Bekleyen</div><div className="stat-value">{(byStatus.pending ?? 0) + (byStatus.retry ?? 0)}</div></div>
      <div className="stat"><div className="stat-label">Teslim</div><div className="stat-value">{byStatus.delivered ?? 0}</div></div>
      <div className="stat risk-stat"><div className="stat-label">Müdahale gereken</div><div className="stat-value">{byStatus.dead ?? 0}</div></div>
      <div className="stat"><div className="stat-label">Gönderiliyor</div><div className="stat-value">{byStatus.processing ?? 0}</div></div>
    </div>
    <section className="connect-panel"><div><h2>Ne zaman alarm oluşur?</h2><p>İzlenen kişi veya kurumla eşleşen bir yorumda öncelik puanı {cfg.ALERT_SEVERITY_THRESHOLD} veya üzerindeyse{cfg.ALERT_ON_THREAT ? ", ya da tehdit işaretlenmişse" : ""} alarm oluşturulur. Teslimat durumu aşağıdaki kayıtlarda görünür.</p></div><span className={`badge ${cfg.ALERT_WEBHOOK_URL ? "blue" : "warn"}`}>{cfg.ALERT_WEBHOOK_URL ? "Bildirim adresi kayıtlı" : "Bildirim kurulumu gerekli"}</span></section>
    <details className="settings-disclosure" style={{marginBottom:24}}><summary>Bildirim bağlantısı ve güvenlik ayrıntıları</summary><div className="two-col">
      <div><div className="small muted">Endpoint</div><div className="code">{endpoint}</div></div>
      <div><div className="small muted">Kural</div><div className="small">Öncelik ≥ {cfg.ALERT_SEVERITY_THRESHOLD}{cfg.ALERT_ON_THREAT ? " veya tehdit işaretlendi" : ""}; kişi/kurum eşleşmesi gerekir.</div></div>
      <div><div className="small muted">İmza</div><div className="small"><span className="code">X-Sosyal-Itibar-Signature-256</span> · HMAC-SHA256</div></div>
      <div><div className="small muted">Idempotency</div><div className="small"><span className="code">Idempotency-Key</span> her alarm için sabittir.</div></div>
    </div><p className="small muted">Kayıtlı adres, teslimatın başarılı olduğunu göstermez. Alıcı imzayı doğrulayıp bildirimi e-posta, Telegram veya kullandığın başka bir kanala yönlendirebilir.</p></details>
    <AlertSettingsForm enabled={cfg.alertEnabled} endpoint={cfg.alertEndpoint} hasSecret={cfg.alertHasSecret} threshold={cfg.ALERT_SEVERITY_THRESHOLD} onThreat={cfg.ALERT_ON_THREAT} revision={cfg.alertSettingsRevision} />
    <section className="panel"><div className="panel-head"><h2>Son teslimatlar</h2><span className="badge">{rows.length}</span></div>
      {rows.length === 0 ? <div className="empty empty-feature"><h2>Henüz alarm kaydı yok.</h2><p>Alarm kuralına uyan yorumlar burada nedeni ve teslimat durumuyla görünür.</p><Link className="btn" href="/">Yorum akışına dön</Link></div> : <div className="table-wrap"><table><thead><tr><th>Yorum ve alarm nedeni</th><th>Öncelik</th><th>Teslimat</th><th>İşlem</th></tr></thead><tbody>{rows.map((row) => {
        const p = payloadView(row.payload);
        return <tr key={row.id}><td><div className="meta-line"><span className="badge">{p.platform === "instagram" ? "Instagram" : p.platform === "facebook" ? "Facebook" : p.platform}</span><span>{p.target}</span><span>{row.createdAt.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}</span></div><strong>{p.summary}</strong>{p.text ? <div className="summary comment-text" dir="auto">{p.text}</div> : null}<div className="small muted" style={{marginTop:6}}>{p.reason}</div></td><td><span className={`badge ${p.label || (p.severity !== null && p.severity >= 70) ? "danger" : "warn"}`}>{p.label ?? p.severity ?? "—"}</span></td><td><span className={`badge ${row.status === "delivered" ? "ok" : row.status === "dead" ? "danger" : row.status === "retry" ? "warn" : ""}`}>{statusLabels[row.status] || row.status}</span><div className="small muted" style={{marginTop:6}}>Deneme: {row.attempts}</div>{row.lastError ? <details className="analysis-detail"><summary>Hata ayrıntısı</summary><p style={{maxWidth:420,overflowWrap:"anywhere"}}>{row.lastError}</p></details> : null}</td><td>{row.status === "dead" || row.status === "retry" ? <AlertRequeueButton id={row.id} /> : "—"}</td></tr>;
      })}</tbody></table></div>}
      {nextCursor ? <div className="panel-body"><a className="btn" href={`/settings/alerts?cursor=${encodeURIComponent(nextCursor)}`}>Daha eski 100 alarm</a></div> : null}
    </section>
    <p className="small muted" style={{marginTop:18}}>Alarm, incelemen için bir bildirimdir. Yorum değerlendirmesi ve bildirimin teslimat durumu ayrı ayrı gösterilir.</p>
  </main></div>;
}
