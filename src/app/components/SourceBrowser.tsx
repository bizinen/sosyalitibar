import Link from "next/link";
import { CommentSource } from "@/app/components/CommentSource";
import { commentSources, sourceSortOptions, sourceFilterOptions } from "@/lib/comment-sources";
import type { CommentParams } from "@/lib/comment-feed";
import { sourceScanStatus } from "@/lib/source-scan";
import { SourceCardActions } from "@/app/components/SourceCardActions";
import { UiIcon } from "@/app/components/UiIcon";

export async function SourceBrowser({ params, connections, selected = false }: {
  params: CommentParams; connections: { id: string; displayName: string }[]; selected?: boolean;
}) {
  const page = await commentSources(params, selected);
  function href(values: Record<string, string | undefined>) {
    const next = new URLSearchParams();
    for (const key of ["platform", "connection", "sourceQ", "sourceSort", "sourceFilter", "sourceAfter"] as const) if (params[key]) next.set(key, params[key]!);
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    return `/?${next}`;
  }
  function commentHref(key: string, view?: string) { return href({ mode: "comments", source: key, view }); }
  if (selected) {
    const row = page.rows[0];
    const scan = row?.scan ? sourceScanStatus(row.scan) : null;
    return <section className="selected-source" aria-label="İncelenen paylaşım">
      <div className="selected-source-nav"><Link className="text-link" href={href({ mode: "sources" })}>Paylaşım listesine dön</Link><span className="small muted">{row?.source_id === null ? "Kaynağı belirlenemeyen yorumlar" : row?.channel || "Seçilen paylaşım"}</span></div>
      {row ? <><CommentSource raw={row.source_id === null ? { source_post: { text: "Paylaşımı belirlenemeyen yorumlar" } } : row.raw} platform={row.platform} rootId={row.source_id} />
        {scan ? <p className={scan.warning ? "notice small" : "small muted"}>{scan.label} · {scan.note}{row.scan?.lastSyncedAt ? ` Son tarama: ${new Date(row.scan.lastSyncedAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}.` : ""}</p> : null}
        <div className="source-counts"><span>{row.comments.toLocaleString("tr-TR")} alınan yorum</span><span>{row.pending.toLocaleString("tr-TR")} inceleme bekleyen</span><span>{row.risk.toLocaleString("tr-TR")} yüksek öncelik</span></div></>
        : <p className="notice">Bu paylaşım mevcut hesap filtresinde bulunamadı. Paylaşım listesine dönerek yeniden seçebilirsin.</p>}
    </section>;
  }
  return <section className="source-browser" aria-label="Paylaşım kütüphanesi">
    <div className="feed-head"><div><h2>Hangi paylaşımı inceleyeceksin?</h2><p className="section-description">Hesaplardan yorum alınan paylaşımlar ve izlemeye eklediğin videolar.</p></div></div>
    <form className="source-search" method="get" action="/" aria-label="Paylaşım filtreleri">
      <input type="hidden" name="mode" value="sources" />
      <div className="source-search-main"><label>Paylaşım veya kanal ara<div className="source-search-input"><UiIcon name="search" size={17} /><input className="input" name="sourceQ" defaultValue={params.sourceQ ?? ""} maxLength={120} placeholder="Başlık, kanal veya paylaşım bağlantısı" /></div></label>
        <button className="btn source-search-submit" type="submit"><UiIcon name="search" size={16} />Paylaşımları bul</button></div>
      <div className="source-search-filters">
        <label><span><UiIcon name="target" size={14} />Platform</span><select className="select" name="platform" defaultValue={params.platform ?? ""}><option value="">Tüm platformlar</option><option value="youtube">YouTube</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select></label>
        <label><span><UiIcon name="accounts" size={14} />Bağlı hesap</span><select className="select" name="connection" defaultValue={params.connection ?? ""}><option value="">Tüm kaynaklar</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}</select></label>
        <label><span><UiIcon name="sort" size={14} />Sıralama</span><select className="select" name="sourceSort" defaultValue={page.sort}>{sourceSortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label><span><UiIcon name="filter" size={14} />Yorum durumu</span><select className="select" name="sourceFilter" defaultValue={page.filter}>{sourceFilterOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
    </form>
    <div className="source-results-head"><span><strong>{page.total.toLocaleString("tr-TR")} paylaşım</strong><span className="source-sort-description">{sourceSortOptions.find(option => option.value === page.sort)!.label}</span></span><Link className="text-link" href="/?mode=sources"><UiIcon name="refresh" size={14} />Filtreleri temizle</Link></div>
    {!page.rows.length ? <div className="empty"><h3>Bu görünümde paylaşım yok.</h3><p>{params.sourceAfter ? "Liste değişmiş olabilir. İlk sayfaya dönüp yeniden ara." : "Aramayı veya hesap filtresini değiştir. Henüz kaynak eklemediysen izleme listesinden video ekleyebilirsin."}</p><Link className="btn" href={params.sourceAfter ? href({ mode: "sources", sourceAfter: undefined }) : "/settings/videos"}>{params.sourceAfter ? "İlk sayfaya dön" : "Video izleme listesi"}</Link></div> : null}
    <div className="source-grid">{page.rows.map((row) => {
      const platform = row.platform === "youtube" ? "YouTube" : row.platform === "instagram" ? "Instagram" : "Facebook";
      return <article className="source-tile" key={row.key}>
        <div className="source-tile-account"><span className={`review-platform ${row.platform}`}>{platform}</span><strong>{row.source_id === null ? "Kaynağı belirlenemeyen yorumlar" : row.channel || "Kanal bilgisi alınamadı"}</strong></div>
        <CommentSource raw={row.source_id === null ? { source_post: { text: "Paylaşımı belirlenemeyen yorumlar" } } : row.raw} platform={row.platform} rootId={row.source_id} titleHref={commentHref(row.key)} showPermalink={false} />
        <div className="source-tile-body"><div className="source-counts"><Link href={commentHref(row.key)} prefetch={false}><strong>{row.comments.toLocaleString("tr-TR")}</strong> alınan yorum</Link>
          <Link href={commentHref(row.key, "pending")} prefetch={false}><strong>{row.pending.toLocaleString("tr-TR")}</strong> inceleme bekleyen</Link>
          <Link className={row.risk > 0 ? "source-risk" : undefined} href={commentHref(row.key, "risk")} prefetch={false}><strong>{row.risk.toLocaleString("tr-TR")}</strong> yüksek öncelik</Link></div>
          <p className="source-date small muted">{row.comments ? "Son yorum alımı" : "İzlemeye eklendi"}: {new Date(row.latest_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
          <SourceCardActions title={row.title?.split("\n")[0]?.slice(0, 500) || "Bu paylaşım"} commentsHref={commentHref(row.key)} permalink={row.raw.source_post.permalink} watch={row.watch}
            settingsHref={row.watch ? `/settings/videos?video=${row.watch.id}#video-${row.watch.id}` : row.connection_id ? "/settings/meta" : "/settings/videos"} />
        </div>
      </article>;
    })}</div>
    <nav className="source-pagination" aria-label="Paylaşım sayfaları">{params.sourceAfter ? <Link className="btn" href={href({ mode: "sources", sourceAfter: undefined })}>İlk sayfa</Link> : null}
      {page.next ? <Link className="btn primary" href={href({ mode: "sources", sourceAfter: page.next })} prefetch={false}>Sonraki 24 paylaşım</Link> : null}</nav>
  </section>;
}
