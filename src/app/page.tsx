import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { monitoringTargets, socialAnalyses, socialConnections, socialItems, watchedVideos } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { AdminNav } from "@/app/components/AdminNav";
import { CommentWorkspace } from "@/app/components/CommentWorkspace";
import { UiIcon } from "@/app/components/UiIcon";
import { encodeItemCursor } from "@/lib/cursor";
import { commentDisplay } from "@/lib/comment-display";
import { SourceBrowser } from "@/app/components/SourceBrowser";

import { commentConditions, commentRows, sourceKey, type CommentParams as Params } from "@/lib/comment-feed";

export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await isAdmin())) redirect("/login");
  const p = Object.fromEntries(Object.entries(await searchParams).filter(([, value]) => typeof value === "string")) as Params;
  if (p.video && !p.source && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.video)) {
    const [video] = await db.select({ platform: watchedVideos.platform, externalId: watchedVideos.externalId }).from(watchedVideos).where(eq(watchedVideos.id, p.video)).limit(1);
    if (video) p.source = sourceKey(video.platform, video.externalId);
  }
  const showSources = p.mode === "sources" || !(p.mode === "comments" || p.source || p.video || p.view || p.q || p.cursor || p.review || p.needsReview || p.sentiment || p.category || p.minSeverity || p.target || p.analysis || p.from || p.to);
  const minSeverity = Math.max(0, Math.min(100, Number(p.minSeverity || 0) || 0));
  const [filtered] = showSources ? [] : await db.select({ total: sql<number>`count(*)::int` }).from(socialItems)
    .leftJoin(socialAnalyses, eq(socialAnalyses.itemId, socialItems.id)).where(and(...commentConditions({ ...p, cursor: undefined })));
  const [statsRow] = await db.select({
    total: sql<number>`count(*)::int`,
    normal: sql<number>`count(*) filter (where ${socialAnalyses.triageLabel} = 'inceleme_gerekmiyor')::int`,
    critical: sql<number>`count(*) filter (where coalesce(${socialAnalyses.severity}, 0) >= 70 or ${socialAnalyses.triageLabel} = 'acil_inceleme')::int`,
    needsReview: sql<number>`count(*) filter (where ${socialAnalyses.needsReview} is true and ${socialItems.reviewStatus} = 'new')::int`,
  }).from(socialItems).leftJoin(socialAnalyses, eq(socialAnalyses.itemId, socialItems.id)).where(isNull(socialItems.deletedAt));

  const metaConnections = await db.select().from(socialConnections);
  const youtubeChannels = await db.select({ id: watchedVideos.id, title: watchedVideos.title }).from(watchedVideos)
    .where(and(eq(watchedVideos.sourceKind, "channel"), sql`${watchedVideos.status} <> 'removed'`));
  const connections = [...metaConnections, ...youtubeChannels.map(channel => ({ id: `youtube:${channel.id}`, displayName: `YouTube · ${channel.title || "Kanal"}` }))];
  const targets = showSources ? [] : await db.select({ id: monitoringTargets.id, name: monitoringTargets.name }).from(monitoringTargets);
  const updatesStartedAt = new Date();
  const [newest] = showSources ? [] : await db.select({ id: socialItems.id, at: socialItems.ingestedAt,
    preciseAt: sql<string>`to_char(${socialItems.ingestedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(socialItems).orderBy(desc(socialItems.ingestedAt), desc(socialItems.id)).limit(1);
  const rows = showSources ? [] : await commentRows(p);
  const hasMore = rows.length > 100;
  const updateCursor = encodeItemCursor(newest ?? { at: updatesStartedAt, id: "00000000-0000-4000-8000-000000000000" });
  const visibleRows = hasMore ? rows.slice(0, 100) : rows;
  const last = visibleRows.at(-1);
  const nextCursor = hasMore && last ? encodeItemCursor({ at: last.item.ingestedAt, id: last.item.id, preciseAt: last.cursorAt }) : null;

  const connectedCount = /^\d{1,4}$/.test(p.connected || "") ? Number(p.connected) : null;
  const callbackError = p.meta_error === "oauth_denied" ? "Meta bağlantısına izin verilmedi." : p.meta_error === "no_pages" ? "Meta erişilebilir sayfa döndürmedi. Facebook hesabının sayfa erişimini, pages_show_list iznini ve Meta izin ekranındaki hesap seçimini kontrol et." : p.meta_error === "connect_failed" ? "Meta bağlantısı tamamlanamadı. Bağlantı ayarlarından tekrar deneyin." : null;
  const stats = statsRow || { total: 0, normal: 0, critical: 0, needsReview: 0 };
  const advancedFilters = Boolean(p.sentiment || p.category || p.review || p.needsReview || p.target || p.analysis || p.from || p.to || minSeverity);
  const views = [["", "Tüm yorumlar"], ["pending", "İnceleme bekleyen"], ["urgent", "Acil inceleme"], ["normal", "İnceleme gerekmeyen"], ["risk", "Yüksek öncelik"], ["threats", "Eski analiz: tehdit"], ["confirmed", "İnsan onaylı saldırılar"], ["history", "Geçmiş arşivi · AI yok"], ["failed", "Analizi başarısız"], ["unavailable", "Kaynağa erişilemiyor"], ["human", "İnsan değerlendirmesi olan"]];
  function viewHref(view: string) {
    const params = new URLSearchParams({ mode: "comments" });
    for (const key of ["source", "sourceQ", "sourceAfter", "video", "q", "platform", "connection", "target", "from", "to"] as const) if (p[key]) params.set(key, p[key]!);
    if (view) params.set("view", view);
    return `/?${params}`;
  }
  return <div className="shell">
    <AdminNav />
    <main className="container comments-workspace">
      {callbackError ? <div className="notice" role="alert">{callbackError}</div> : connectedCount !== null ? <div className="notice" role="status">Meta bağlantısı tamamlandı: {connectedCount} kaynak.</div> : null}
      <section className="grid-stats" aria-label="Tüm yorumların özeti">
        <Link href="/?mode=comments" className="stat"><div className="stat-label"><UiIcon name="comments" size={16} />Toplam yorum</div><div className="stat-value">{stats.total.toLocaleString("tr-TR")}</div><span className="stat-caption">Tüm hesapların</span></Link>
        <Link href="/?review=new&needsReview=true" className="stat"><div className="stat-label"><UiIcon name="target" size={16} />İnceleme bekleyen</div><div className="stat-value">{stats.needsReview.toLocaleString("tr-TR")}</div><span className="stat-caption">AI insan incelemesi istiyor</span></Link>
        <Link href="/?view=risk" className="stat risk-stat"><div className="stat-label"><UiIcon name="bell" size={16} />Yüksek öncelik</div><div className="stat-value">{stats.critical.toLocaleString("tr-TR")}</div><span className="stat-caption">Acil etiket veya eski analizde 70+</span></Link>
        <Link href="/?view=normal" className="stat"><div className="stat-label"><UiIcon name="comments" size={16} />İnceleme gerekmeyen</div><div className="stat-value">{stats.normal.toLocaleString("tr-TR")}</div><span className="stat-caption">AI ön eleme sonucu</span></Link>
      </section>

      <nav className="source-mode-nav" aria-label="İnceleme düzeni"><Link href="/?mode=sources" aria-current={showSources ? "page" : undefined}>Paylaşımlar</Link><Link href="/?mode=comments" aria-current={!showSources ? "page" : undefined}>Tüm yorumlar</Link></nav>
      {showSources ? <SourceBrowser params={p} connections={connections} /> : <>
      {p.source ? <SourceBrowser params={p} connections={connections} selected /> : null}
      <section className="panel" style={{marginBottom:18}}>
        <div className="panel-body">
          <form className="comment-filters" method="get">
            <input type="hidden" name="mode" value="comments" />
            {["source", "sourceQ", "sourceAfter", "video"].map((key) => p[key as keyof Params] ? <input key={key} type="hidden" name={key} value={p[key as keyof Params]} /> : null)}
            {p.view ? <input type="hidden" name="view" value={p.view} /> : null}
            <div className="filter-bar">
            <input className="input search-input" name="q" aria-label="Yorum içinde ara" defaultValue={p.q || ""} placeholder="Bir kelime, isim veya ifade ara…" />
            <select className="select" name="platform" aria-label="Platform" defaultValue={p.platform || ""}><option value="">Tüm platformlar</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option><option value="youtube">YouTube</option></select>
            <select className="select" name="connection" aria-label="Hesap" defaultValue={p.connection || ""}><option value="">Tüm hesaplar</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}</select>
            <button className="btn primary" type="submit">Göster</button>
            </div>
            <details className="advanced-filters" open={advancedFilters}><summary>Detaylı filtreler{advancedFilters ? <span className="badge blue">Filtre seçili</span> : null}</summary><div className="filters">
            <select className="select" name="sentiment" aria-label="Yorumun tonu" defaultValue={p.sentiment || ""}><option value="">Eski analiz: tüm tonlar</option><option value="negative">Olumsuz</option><option value="neutral">Nötr</option><option value="positive">Olumlu</option></select>
            <select className="select" name="category" aria-label="Yorum kategorisi" defaultValue={p.category || ""}><option value="">Eski analiz: tüm kategoriler</option><option value="criticism">Eleştiri</option><option value="insult">Hakaret</option><option value="accusation">İddia</option><option value="threat">Tehdit</option><option value="mockery">Alay</option><option value="spam">Spam</option><option value="support">Destek</option><option value="other">Diğer</option></select>
            <select className="select" name="review" aria-label="İnceleme durumu" defaultValue={p.review || ""}><option value="">Tüm inceleme durumları</option><option value="new">Yeni</option><option value="reviewed">İncelendi</option><option value="escalated">Önceliklendirildi</option><option value="ignored">Dikkate alınmadı</option></select>
            <select className="select" name="needsReview" aria-label="LLM inceleme gereksinimi" defaultValue={p.needsReview || ""}><option value="">Tüm inceleme kararları</option><option value="true">LLM insan incelemesi istiyor</option></select>
            <select className="select" name="target" aria-label="Kişi veya kurum bağlamı" defaultValue={p.target || ""}><option value="">Tüm kişi / kurum bağlamları</option>{targets.map((target) => <option key={target.id} value={target.name}>{target.name}</option>)}</select>
            <select className="select" name="analysis" aria-label="Analiz durumu" defaultValue={p.analysis || ""}><option value="">Tüm analiz durumları</option><option value="pending">Analiz bekliyor</option><option value="processing">Analiz ediliyor</option><option value="retry">Tekrar denenecek</option><option value="complete">Analiz tamamlandı</option><option value="dead">Analiz tamamlanamadı</option></select>
            <label className="small muted">Alınma başlangıcı (UTC)<input className="input" name="from" type="date" defaultValue={p.from || ""} /></label>
            <label className="small muted">Alınma bitişi (UTC)<input className="input" name="to" type="date" defaultValue={p.to || ""} /></label>
            <input className="input" name="minSeverity" aria-label="En düşük öncelik puanı" type="number" min="0" max="100" defaultValue={minSeverity || ""} placeholder="Eski analiz: en düşük puan" />
            </div><p className="small muted">Kişi / kurum filtresi insan değerlendirmesini, yoksa eski AI eşleşmesini veya yeni etiketlerde hesabın kişi / kurum bağlamını kullanır. Hesap bağlamı yorumun hedefini doğrulamaz; harici yayınlarda hesap eşleştirmesi kullanılmaz.</p></details><div className="filter-footer"><span>Son alınan yorumlar önce gösterilir.</span><Link className="text-link" href={p.source ? `/?mode=comments&source=${encodeURIComponent(p.source)}` : "/?mode=comments"}>Yorum filtrelerini temizle</Link></div>
          </form>
        </div>
      </section>

      <section className="comment-feed">
        <div className="feed-head"><div><h2>{p.source ? "Bu paylaşımın yorumları" : "Tüm yorumlar"}</h2><p className="section-description">{p.source ? "Seçilen paylaşıma ait yorumlar ve yanıtlar." : "Bütün kaynaklardan alınan yorumlar."}</p></div><span className="badge">{filtered?.total ?? 0} yorum</span></div>
        <nav className="review-views" aria-label="Hazır inceleme görünümleri">{views.map(([value, label]) => <Link key={value} href={viewHref(value)} className={value === (p.view ?? "") ? "is-active" : ""} aria-current={value === (p.view ?? "") ? "page" : undefined}>{label}</Link>)}</nav>
        {visibleRows.length === 0 ? <div className="empty empty-feature"><span className="empty-symbol"><UiIcon name="comments" size={30} /></span><h2>{p.source || p.video ? "Bu paylaşım için yorum bulunamadı." : "Bu görünümde yorum bulunamadı."}</h2><p>Seçili filtreler alınan yorumları gizleyebilir. Henüz yorum alınmadıysa izleme listesindeki tarama durumunu kontrol edebilirsin.</p><div className="btn-row"><Link className="btn primary" href={p.source ? `/?mode=comments&source=${encodeURIComponent(p.source)}` : "/?mode=comments"}>Yorum filtrelerini temizle</Link><Link className="btn" href="/settings/videos">İzleme listesi</Link></div></div> : null}
        <CommentWorkspace key={JSON.stringify([p.source, p.video, p.view, p.q, p.platform, p.connection, p.target, p.from, p.to, p.cursor, p.review, p.category, p.analysis, p.needsReview, p.minSeverity, p.sentiment])} rows={visibleRows.map(({ item, analysis, connectionName, parentText }) => ({ item: { ...item,
          raw: commentDisplay(item.raw) },
          analysis: analysis ? { ...analysis, raw: null } : null, connectionName, parentText }))} updateCursor={updateCursor}
          nextCursor={nextCursor} filters={Object.fromEntries(Object.entries(p).filter(([, value]) => typeof value === "string"))} total={filtered?.total ?? 0} />
      </section>
      </>}
    </main>
  </div>;
}
