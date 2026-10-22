import { redirect } from "next/navigation";
import { and, desc, eq, getTableColumns, lt, or, sql } from "drizzle-orm";
import { alertOutbox, socialItems, webhookEvents, workerHeartbeats } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { AdminNav } from "@/app/components/AdminNav";
import { OperationsActions } from "@/app/components/OperationsActions";
import { RequeueButton } from "@/app/components/RequeueButton";

import { decodeItemCursor, encodeItemCursor } from "@/lib/cursor";
import { WORKER_JOBS } from "@/lib/worker-health";

type Params = { webhookCursor?: string; analysisCursor?: string };

export default async function OperationsPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await isAdmin())) redirect("/login");
  const p = await searchParams;
  const webhookCursor = decodeItemCursor(p.webhookCursor);
  const analysisCursor = decodeItemCursor(p.analysisCursor);
  const [webhookCounts, analysisCounts, alertCounts, webhookRows, analysisRows, heartbeats] = await Promise.all([
    db.select({ status: webhookEvents.status, count: sql<number>`count(*)::int` }).from(webhookEvents).groupBy(webhookEvents.status),
    db.select({ status: socialItems.analysisStatus, count: sql<number>`count(*)::int` }).from(socialItems).groupBy(socialItems.analysisStatus),
    db.select({ status: alertOutbox.status, count: sql<number>`count(*)::int` }).from(alertOutbox).groupBy(alertOutbox.status),
    db.select({ ...getTableColumns(webhookEvents), cursorAt: sql<string>`to_char(${webhookEvents.receivedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(webhookEvents).where(and(eq(webhookEvents.status, "dead"), webhookCursor ? or(lt(webhookEvents.receivedAt, sql`${webhookCursor.preciseAt ?? webhookCursor.at.toISOString()}::timestamptz`), and(eq(webhookEvents.receivedAt, sql`${webhookCursor.preciseAt ?? webhookCursor.at.toISOString()}::timestamptz`), lt(webhookEvents.id, webhookCursor.id))) : undefined)).orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id)).limit(51),
    db.select({ ...getTableColumns(socialItems), cursorAt: sql<string>`to_char(${socialItems.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` }).from(socialItems).where(and(eq(socialItems.analysisStatus, "dead"), analysisCursor ? or(lt(socialItems.updatedAt, sql`${analysisCursor.preciseAt ?? analysisCursor.at.toISOString()}::timestamptz`), and(eq(socialItems.updatedAt, sql`${analysisCursor.preciseAt ?? analysisCursor.at.toISOString()}::timestamptz`), lt(socialItems.id, analysisCursor.id))) : undefined)).orderBy(desc(socialItems.updatedAt), desc(socialItems.id)).limit(51),
    db.select().from(workerHeartbeats),
  ]);
  const deadWebhooks = webhookRows.slice(0, 50);
  const deadAnalyses = analysisRows.slice(0, 50);
  function pageHref(key: keyof Params, at: Date, id: string, preciseAt: string) {
    const params = new URLSearchParams();
    if (webhookCursor) params.set("webhookCursor", encodeItemCursor(webhookCursor));
    if (analysisCursor) params.set("analysisCursor", encodeItemCursor(analysisCursor));
    params.set(key, encodeItemCursor({ at, id, preciseAt }));
    return `/settings/operations?${params.toString()}`;
  }
  const wc = Object.fromEntries(webhookCounts.map((x) => [x.status, x.count]));
  const ac = Object.fromEntries(analysisCounts.map((x) => [x.status, x.count]));
  const nc = Object.fromEntries(alertCounts.map((x) => [x.status, x.count]));
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Sistem durumu</h1><p className="muted" style={{margin:"6px 0 0"}}>Yorumların alınması, AI analizi ve alarm teslimatında bekleyen veya müdahale gerektiren işleri gör.</p></div><OperationsActions /></div>
    <section className="grid-stats" aria-label="Kuyruklarda kayıtlı işler">
      <div className="stat"><div className="stat-label">Alınmayı bekleyen bildirim</div><div className="stat-value">{(wc.pending ?? 0) + (wc.retry ?? 0)}</div><span className="stat-caption">İşleniyor: {wc.processing ?? 0}</span></div>
      <div className="stat"><div className="stat-label">Analiz bekleyen yorum</div><div className="stat-value">{(ac.pending ?? 0) + (ac.retry ?? 0)}</div><span className="stat-caption">İşleniyor: {ac.processing ?? 0}</span></div>
      <div className="stat risk-stat"><div className="stat-label">Müdahale gereken iş</div><div className="stat-value">{(wc.dead ?? 0) + (ac.dead ?? 0) + (nc.dead ?? 0)}</div><span className="stat-caption">Bildirim, analiz ve alarm toplamı</span></div>
      <div className="stat"><div className="stat-label">Gönderim bekleyen alarm</div><div className="stat-value">{(nc.pending ?? 0) + (nc.retry ?? 0)}</div><span className="stat-caption">Gönderiliyor: {nc.processing ?? 0}</span></div>
    </section>
    <section className="panel" style={{marginBottom:18}}><div className="panel-head"><h2>Worker görevleri</h2></div><div className="table-wrap"><table><thead><tr><th>Görev</th><th>Durum</th><th>Son başarılı çalışma</th></tr></thead><tbody>{WORKER_JOBS.map((job) => {
      const row = heartbeats.find((heartbeat) => heartbeat.job === job);
      const stale = !row || Date.now() - row.lastAttemptAt.getTime() > row.staleAfterMs;
      const labels: Record<string, string> = { "process-events": "Yorum bildirimleri", "process-analyses": "AI analizi", "process-alerts": "Alarm teslimatı", reconcile: "Düzenli tarama", "check-connections": "Hesap sağlığı", maintenance: "Bakım" };
      return <tr key={job}><td>{labels[job]}</td><td><span className={`badge ${stale ? "danger" : row?.lastSucceeded ? "ok" : "warn"}`}>{stale ? "Heartbeat bekleniyor" : row?.lastSucceeded ? "Görev çalıştı" : "Son çalışma başarısız"}</span></td><td>{row?.lastSuccessAt?.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) || "Henüz kayıt yok"}</td></tr>;
    })}</tbody></table></div><div className="panel-body small muted">Başarılı görev çalışması, her yorumun analiz edildiğini veya her alarmın teslim edildiğini kanıtlamaz. Ayrıntılar ilgili kuyrukta görünür.</div></section>
    <p className="small muted">Bu sayılar kayıtlı kuyruk durumunu gösterir; dış bağlantıların çalıştığına dair canlı kontrol değildir. Sorunu giderdikten sonra ilgili işi yeniden kuyruğa alabilirsin.</p>
    {(nc.dead ?? 0) > 0 ? <div className="notice">{nc.dead} alarm teslimatı müdahale bekliyor. <a className="text-link" href="/settings/alerts">Alarmları incele</a></div> : null}
    <section className="panel" style={{marginBottom:18}}><div className="panel-head"><h2>Alınamayan yorum bildirimleri</h2><span className={`badge ${deadWebhooks.length ? "danger" : ""}`}>{deadWebhooks.length} kayıt</span></div>
      {deadWebhooks.length === 0 ? <div className="empty">Bu sayfada müdahale gerektiren bildirim kaydı yok.</div> : <div className="table-wrap"><table><thead><tr><th>Bildirim</th><th>Hata ayrıntısı</th><th>İşlem</th></tr></thead><tbody>{deadWebhooks.map((row) => <tr key={row.id}><td><div><strong>{row.objectType || "Meta"}</strong></div><div className="small muted code">{row.id}</div><div className="small muted">{row.receivedAt.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })} · {row.attempts} deneme</div></td><td><div className="comment-text">{row.error || "Bilinmeyen hata"}</div></td><td><RequeueButton kind="webhook" id={row.id} /></td></tr>)}</tbody></table></div>}
      {webhookRows.length > 50 ? <div className="panel-body"><a className="btn" href={pageHref("webhookCursor", deadWebhooks[49].receivedAt, deadWebhooks[49].id, deadWebhooks[49].cursorAt)}>Daha eski 50 webhook</a></div> : null}
    </section>
    <section className="panel"><div className="panel-head"><h2>Tamamlanamayan AI analizleri</h2><span className={`badge ${deadAnalyses.length ? "danger" : ""}`}>{deadAnalyses.length} kayıt</span></div>
      {deadAnalyses.length === 0 ? <div className="empty">Bu sayfada müdahale gerektiren analiz kaydı yok.</div> : <div className="table-wrap"><table><thead><tr><th>Yorum</th><th>Hata ayrıntısı</th><th>İşlem</th></tr></thead><tbody>{deadAnalyses.map((row) => <tr key={row.id}><td><div className="meta-line"><span className="badge">{row.platform === "instagram" ? "Instagram" : "Facebook"}</span><span>{row.authorName || "İsmi paylaşılmayan kullanıcı"}</span></div><div className="comment-text" dir="auto">{row.text}</div><div className="small muted">{row.analysisAttempts} deneme</div></td><td><div className="comment-text">{row.analysisError || "Bilinmeyen hata"}</div></td><td><RequeueButton kind="analysis" id={row.id} /></td></tr>)}</tbody></table></div>}
      {analysisRows.length > 50 ? <div className="panel-body"><a className="btn" href={pageHref("analysisCursor", deadAnalyses[49].updatedAt, deadAnalyses[49].id, deadAnalyses[49].cursorAt)}>Daha eski 50 analiz</a></div> : null}
    </section>
  </main></div>;
}
