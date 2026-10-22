import Link from "next/link";
import { CommentSource } from "@/app/components/CommentSource";
import { commentSources } from "@/lib/comment-sources";
import type { CommentParams } from "@/lib/comment-feed";

export async function SourceBrowser({ params, connections, selected = false }: {
  params: CommentParams; connections: { id: string; displayName: string }[]; selected?: boolean;
}) {
  const page = await commentSources(params, selected);
  function href(values: Record<string, string | undefined>) {
    const next = new URLSearchParams();
    for (const key of ["platform", "connection", "sourceQ", "sourceAfter"] as const) if (params[key]) next.set(key, params[key]!);
    for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key); }
    return `/?${next}`;
  }
  function commentHref(key: string, view?: string) { return href({ mode: "comments", source: key, view }); }
  if (selected) {
    const row = page.rows[0];
    return <section className="selected-source" aria-label="İncelenen paylaşım">
      <div className="selected-source-nav"><Link className="text-link" href={href({ mode: "sources" })}>Paylaşım listesine dön</Link><span className="small muted">{row?.source_id === null ? "Kaynağı belirlenemeyen yorumlar" : row?.channel || "Seçilen paylaşım"}</span></div>
      {row ? <><CommentSource raw={row.source_id === null ? { source_post: { text: "Paylaşımı belirlenemeyen yorumlar" } } : row.raw} platform={row.platform} rootId={row.source_id} />
        <div className="source-counts"><span>{row.comments.toLocaleString("tr-TR")} alınan yorum</span><span>{row.pending.toLocaleString("tr-TR")} incelenmemiş</span><span>{row.risk.toLocaleString("tr-TR")} yüksek öncelik</span></div></>
        : <p className="notice">Bu paylaşım mevcut hesap filtresinde bulunamadı. Paylaşım listesine dönerek yeniden seçebilirsin.</p>}
    </section>;
  }
  return <section className="source-browser" aria-label="Paylaşım kütüphanesi">
    <div className="feed-head"><div><h2>Hangi paylaşımı inceleyeceksin?</h2><p className="section-description">Hesaplardan yorum alınan paylaşımlar ve izlemeye eklediğin videolar.</p></div></div>
    <form className="source-search" method="get">
      <input type="hidden" name="mode" value="sources" />
      <label>Paylaşım veya kanal ara<input className="input" name="sourceQ" defaultValue={params.sourceQ ?? ""} maxLength={120} placeholder="Başlık, kanal adı, bağlantı veya paylaşım kimliği" /></label>
      <label>Platform<select className="select" name="platform" defaultValue={params.platform ?? ""}><option value="">Tüm platformlar</option><option value="youtube">YouTube</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select></label>
      <label>Bağlı hesap<select className="select" name="connection" defaultValue={params.connection ?? ""}><option value="">Tüm kaynaklar</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName}</option>)}</select></label>
      <button className="btn primary" type="submit">Paylaşım bul</button>
    </form>
    <div className="source-results-head"><span>{page.total.toLocaleString("tr-TR")} paylaşım grubu · Son yorum alınan önce</span><Link className="text-link" href="/?mode=sources">Filtreleri temizle</Link></div>
    {!page.rows.length ? <div className="empty"><h3>Bu görünümde paylaşım yok.</h3><p>{params.sourceAfter ? "Liste değişmiş olabilir. İlk sayfaya dönüp yeniden ara." : "Aramayı veya hesap filtresini değiştir. Henüz kaynak eklemediysen izleme listesinden video ekleyebilirsin."}</p><Link className="btn" href={params.sourceAfter ? href({ mode: "sources", sourceAfter: undefined }) : "/settings/videos"}>{params.sourceAfter ? "İlk sayfaya dön" : "Video izleme listesi"}</Link></div> : null}
    <div className="source-grid">{page.rows.map((row) => {
      const platform = row.platform === "youtube" ? "YouTube" : row.platform === "instagram" ? "Instagram" : "Facebook";
      return <article className="source-tile" key={row.key}>
        <div className="source-tile-account"><span className={`review-platform ${row.platform}`}>{platform}</span><strong>{row.source_id === null ? "Kaynağı belirlenemeyen yorumlar" : row.channel || "Kanal bilgisi alınamadı"}</strong></div>
        <CommentSource raw={row.source_id === null ? { source_post: { text: "Paylaşımı belirlenemeyen yorumlar" } } : row.raw} platform={row.platform} rootId={row.source_id} titleHref={commentHref(row.key)} />
        <div className="source-tile-body"><div className="source-counts"><Link href={commentHref(row.key)} prefetch={false}><strong>{row.comments.toLocaleString("tr-TR")}</strong> alınan yorum</Link>
          <Link href={commentHref(row.key, "pending")} prefetch={false}><strong>{row.pending.toLocaleString("tr-TR")}</strong> incelenmemiş</Link>
          <Link className={row.risk > 0 ? "source-risk" : undefined} href={commentHref(row.key, "risk")} prefetch={false}><strong>{row.risk.toLocaleString("tr-TR")}</strong> yüksek öncelik</Link></div>
          <p className="source-date small muted">{row.comments ? "Son yorum alımı" : "İzlemeye eklendi"}: {new Date(row.latest_at).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
          <p className="source-scan-note small muted" aria-hidden={row.comments > 0 || undefined}>{!row.comments ? <>Henüz yorum alınmadı. Tarama durumunu <Link href="/settings/videos" className="text-link">izleme listesinde</Link> görebilirsin.</> : null}</p>
          <p className="source-identity">{row.source_id ? `Paylaşım kimliği: ${row.source_id}` : "Kaynak paylaşımı bulunamayan yorumlar burada birlikte gösterilir."}</p>
          <Link className="btn" href={commentHref(row.key)} prefetch={false}>Yorumları incele</Link>
        </div>
      </article>;
    })}</div>
    <nav className="source-pagination" aria-label="Paylaşım sayfaları">{params.sourceAfter ? <Link className="btn" href={href({ mode: "sources", sourceAfter: undefined })}>İlk sayfa</Link> : null}
      {page.next ? <Link className="btn primary" href={href({ mode: "sources", sourceAfter: page.next })} prefetch={false}>Sonraki 24 paylaşım</Link> : null}</nav>
  </section>;
}
