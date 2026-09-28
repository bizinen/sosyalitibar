import { redirect } from "next/navigation";
import { and, desc, eq, gte, ilike, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { socialAnalyses, socialConnections, socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { AdminNav } from "@/app/components/AdminNav";
import { ReviewActions } from "@/app/components/ReviewActions";
import { decodeItemCursor, encodeItemCursor } from "@/lib/cursor";

type Params = { platform?: string; sentiment?: string; category?: string; minSeverity?: string; review?: string; q?: string; cursor?: string };

function riskClass(severity: number) {
  if (severity >= 70) return "danger";
  if (severity >= 50) return "warn";
  if (severity >= 20) return "blue";
  return "";
}

export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await isAdmin())) redirect("/login");
  const p = await searchParams;
  const conditions: SQL[] = [isNull(socialItems.deletedAt)];
  if (p.platform === "facebook" || p.platform === "instagram") conditions.push(eq(socialItems.platform, p.platform));
  if (["positive", "neutral", "negative"].includes(p.sentiment || "")) conditions.push(eq(socialAnalyses.sentiment, p.sentiment!));
  if (["criticism", "insult", "accusation", "threat", "mockery", "spam", "support", "other"].includes(p.category || "")) conditions.push(eq(socialAnalyses.category, p.category!));
  const minSeverity = Math.max(0, Math.min(100, Number(p.minSeverity || 0) || 0));
  if (minSeverity > 0) conditions.push(gte(socialAnalyses.severity, minSeverity));
  if (["new", "reviewed", "ignored", "escalated"].includes(p.review || "")) conditions.push(eq(socialItems.reviewStatus, p.review!));
  if (p.q?.trim()) conditions.push(ilike(socialItems.text, `%${p.q.trim().slice(0, 120)}%`));
  const cursor = decodeItemCursor(p.cursor);
  if (cursor) {
    const cursorCondition = or(
      lt(socialItems.ingestedAt, cursor.at),
      and(eq(socialItems.ingestedAt, cursor.at), lt(socialItems.id, cursor.id)),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const [statsRow] = await db.select({
    total: sql<number>`count(*)::int`,
    negative: sql<number>`count(*) filter (where ${socialAnalyses.sentiment} = 'negative')::int`,
    critical: sql<number>`count(*) filter (where coalesce(${socialAnalyses.severity}, 0) >= 70)::int`,
    needsReview: sql<number>`count(*) filter (where ${socialAnalyses.needsReview} is true and ${socialItems.reviewStatus} = 'new')::int`,
  }).from(socialItems).leftJoin(socialAnalyses, eq(socialAnalyses.itemId, socialItems.id)).where(isNull(socialItems.deletedAt));

  const connections = await db.select().from(socialConnections);
  const rows = await db.select({ item: socialItems, analysis: socialAnalyses, connectionName: socialConnections.displayName })
    .from(socialItems)
    .leftJoin(socialAnalyses, eq(socialAnalyses.itemId, socialItems.id))
    .leftJoin(socialConnections, eq(socialConnections.id, socialItems.connectionId))
    .where(and(...conditions))
    .orderBy(desc(socialItems.ingestedAt), desc(socialItems.id))
    .limit(101);
  const hasMore = rows.length > 100;
  const visibleRows = hasMore ? rows.slice(0, 100) : rows;
  const last = visibleRows.at(-1);
  const nextCursor = hasMore && last ? encodeItemCursor({ at: last.item.ingestedAt, id: last.item.id }) : null;
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(p)) {
    if (key !== "cursor" && typeof value === "string" && value) nextParams.set(key, value);
  }
  if (nextCursor) nextParams.set("cursor", nextCursor);
  const nextHref = nextCursor ? `/?${nextParams.toString()}` : null;

  const stats = statsRow || { total: 0, negative: 0, critical: 0, needsReview: 0 };
  return <div className="shell">
    <AdminNav />
    <main className="container">
      <div className="page-head">
        <div><h1>İtibar inceleme kuyruğu</h1><p className="muted" style={{margin:"6px 0 0"}}>Facebook ve Instagram yorumları; LLM sınıflandırması yalnız operasyonel öncelik içindir, otomatik yaptırım uygulanmaz.</p></div>
        <div className="btn-row"><a className="btn" href="/settings/targets">Hedefleri düzenle</a><a className="btn primary" href="/settings/meta">Meta bağlantıları</a></div>
      </div>

      <section className="grid-stats">
        <div className="stat"><div className="stat-label">Toplam yorum</div><div className="stat-value">{stats.total}</div></div>
        <div className="stat"><div className="stat-label">Negatif</div><div className="stat-value">{stats.negative}</div></div>
        <div className="stat"><div className="stat-label">70+ risk</div><div className="stat-value">{stats.critical}</div></div>
        <div className="stat"><div className="stat-label">İnceleme bekleyen</div><div className="stat-value">{stats.needsReview}</div></div>
      </section>

      <section className="panel" style={{marginBottom:18}}>
        <div className="panel-head"><h2>Filtreler</h2><span className="badge">{connections.length} bağlı kaynak</span></div>
        <div className="panel-body">
          <form className="filters" method="get">
            <input className="input" name="q" defaultValue={p.q || ""} placeholder="Yorum içinde ara" />
            <select className="select" name="platform" defaultValue={p.platform || ""}><option value="">Tüm platformlar</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select>
            <select className="select" name="sentiment" defaultValue={p.sentiment || ""}><option value="">Tüm duygular</option><option value="negative">Negatif</option><option value="neutral">Nötr</option><option value="positive">Pozitif</option></select>
            <select className="select" name="category" defaultValue={p.category || ""}><option value="">Tüm kategoriler</option><option value="criticism">Eleştiri</option><option value="insult">Hakaret</option><option value="accusation">İddia</option><option value="threat">Tehdit</option><option value="mockery">Alay</option><option value="spam">Spam</option><option value="support">Destek</option><option value="other">Diğer</option></select>
            <select className="select" name="review" defaultValue={p.review || ""}><option value="">Tüm durumlar</option><option value="new">Yeni</option><option value="reviewed">İncelendi</option><option value="escalated">Yükseltildi</option><option value="ignored">Yok sayıldı</option></select>
            <input className="input" name="minSeverity" type="number" min="0" max="100" defaultValue={minSeverity || ""} placeholder="Min. risk" />
            <button className="btn primary" type="submit">Uygula</button><a className="btn" href="/">Temizle</a>
          </form>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Son kayıtlar</h2><span className="badge">{visibleRows.length} kayıt</span></div>
        {visibleRows.length === 0 ? <div className="empty">Filtreye uygun kayıt yok.</div> : <div className="table-wrap"><table>
          <thead><tr><th>Kaynak / yazar</th><th>Yorum</th><th>LLM değerlendirme</th><th>İnceleme</th></tr></thead>
          <tbody>{visibleRows.map(({ item, analysis, connectionName }) => <tr key={item.id}>
            <td style={{minWidth:180}}><div><strong>{connectionName || item.platform}</strong></div><div className="small muted">{item.authorName || "Bilinmeyen kullanıcı"}</div><div className="small muted">{item.sourceCreatedAt?.toLocaleString("tr-TR") || item.ingestedAt.toLocaleString("tr-TR")}</div></td>
            <td><div className="meta-line"><span className="badge blue">{item.platform}</span><span className="badge">{item.itemType}</span><span className="badge">{item.reviewStatus}</span></div><div className="comment-text">{item.text || <em>Metin yok</em>}</div>{item.permalink ? <div style={{marginTop:8}}><a className="small" href={item.permalink} target="_blank" rel="noreferrer">Kaynağı aç ↗</a></div> : null}</td>
            <td style={{minWidth:260}}>{analysis ? <><div className="meta-line"><span className={`badge ${riskClass(analysis.severity)}`}>risk {analysis.severity}</span><span className={`badge ${analysis.sentiment === "negative" ? "danger" : analysis.sentiment === "positive" ? "ok" : ""}`}>{analysis.sentiment}</span><span className="badge">{analysis.category}</span></div>{analysis.matchedTarget ? <div className="small"><strong>Hedef:</strong> {analysis.matchedTarget}</div> : null}<div className="summary">{analysis.summary}</div>{analysis.containsClaim && analysis.claimText ? <div className="summary"><strong>İddia:</strong> {analysis.claimText}</div> : null}</> : <span className={`badge ${item.analysisStatus === "dead" ? "danger" : "warn"}`}>{item.analysisStatus}</span>}</td>
            <td style={{minWidth:220}}><ReviewActions itemId={item.id} current={item.reviewStatus} /></td>
          </tr>)}</tbody>
        </table></div>}
        {nextHref ? <div className="panel-body" style={{display:"flex",justifyContent:"center",borderTop:"1px solid var(--line)"}}><a className="btn" href={nextHref}>Daha eski 100 kaydı göster</a></div> : null}
      </section>
    </main>
  </div>;
}
