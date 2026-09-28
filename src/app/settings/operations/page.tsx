import { redirect } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { alertOutbox, socialItems, webhookEvents } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { AdminNav } from "@/app/components/AdminNav";
import { OperationsActions } from "@/app/components/OperationsActions";
import { RequeueButton } from "@/app/components/RequeueButton";

export default async function OperationsPage() {
  if (!(await isAdmin())) redirect("/login");
  const [webhookCounts, analysisCounts, alertCounts, deadWebhooks, deadAnalyses] = await Promise.all([
    db.select({ status: webhookEvents.status, count: sql<number>`count(*)::int` }).from(webhookEvents).groupBy(webhookEvents.status),
    db.select({ status: socialItems.analysisStatus, count: sql<number>`count(*)::int` }).from(socialItems).groupBy(socialItems.analysisStatus),
    db.select({ status: alertOutbox.status, count: sql<number>`count(*)::int` }).from(alertOutbox).groupBy(alertOutbox.status),
    db.select().from(webhookEvents).where(eq(webhookEvents.status, "dead")).orderBy(desc(webhookEvents.receivedAt)).limit(50),
    db.select().from(socialItems).where(eq(socialItems.analysisStatus, "dead")).orderBy(desc(socialItems.updatedAt)).limit(50),
  ]);
  const wc = Object.fromEntries(webhookCounts.map((x) => [x.status, x.count]));
  const ac = Object.fromEntries(analysisCounts.map((x) => [x.status, x.count]));
  const nc = Object.fromEntries(alertCounts.map((x) => [x.status, x.count]));
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Operasyon merkezi</h1><p className="muted" style={{margin:"6px 0 0"}}>Webhook, LLM ve alarm kuyruklarının sağlık/dead-letter görünümü.</p></div><OperationsActions /></div>
    <section className="grid-stats">
      <div className="stat"><div className="stat-label">Webhook bekleyen</div><div className="stat-value">{(wc.pending ?? 0) + (wc.retry ?? 0)}</div></div>
      <div className="stat"><div className="stat-label">LLM bekleyen</div><div className="stat-value">{(ac.pending ?? 0) + (ac.retry ?? 0)}</div></div>
      <div className="stat"><div className="stat-label">Dead-letter</div><div className="stat-value">{(wc.dead ?? 0) + (ac.dead ?? 0)}</div></div>
      <div className="stat"><div className="stat-label">Alarm bekleyen</div><div className="stat-value">{(nc.pending ?? 0) + (nc.retry ?? 0)}</div></div>
    </section>
    <section className="panel" style={{marginBottom:18}}><div className="panel-head"><h2>Dead webhook eventleri</h2><span className={`badge ${deadWebhooks.length ? "danger" : "ok"}`}>{deadWebhooks.length}</span></div>
      {deadWebhooks.length === 0 ? <div className="empty">Dead webhook yok.</div> : <div className="table-wrap"><table><thead><tr><th>Event</th><th>Hata</th><th>İşlem</th></tr></thead><tbody>{deadWebhooks.map((row) => <tr key={row.id}><td><div><strong>{row.objectType || "Meta"}</strong></div><div className="small muted code">{row.id}</div><div className="small muted">{row.receivedAt.toLocaleString("tr-TR")} · {row.attempts} deneme</div></td><td><div className="comment-text">{row.error || "Bilinmeyen hata"}</div></td><td><RequeueButton kind="webhook" id={row.id} /></td></tr>)}</tbody></table></div>}
    </section>
    <section className="panel"><div className="panel-head"><h2>Dead LLM analizleri</h2><span className={`badge ${deadAnalyses.length ? "danger" : "ok"}`}>{deadAnalyses.length}</span></div>
      {deadAnalyses.length === 0 ? <div className="empty">Dead analiz yok.</div> : <div className="table-wrap"><table><thead><tr><th>Yorum</th><th>Hata</th><th>İşlem</th></tr></thead><tbody>{deadAnalyses.map((row) => <tr key={row.id}><td><div className="meta-line"><span className="badge">{row.platform}</span><span>{row.authorName || "Bilinmeyen"}</span></div><div className="comment-text">{row.text}</div><div className="small muted">{row.analysisAttempts} deneme</div></td><td><div className="comment-text">{row.analysisError || "Bilinmeyen hata"}</div></td><td><RequeueButton kind="analysis" id={row.id} /></td></tr>)}</tbody></table></div>}
    </section>
  </main></div>;
}
