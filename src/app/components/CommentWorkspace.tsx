"use client";

import { triageLabels } from "@/lib/triage-contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { socialAnalyses, socialItems } from "@/db/schema";
import { CommentCard, categoryLabels } from "@/app/components/CommentCard";
import { CommentReviewPanel } from "@/app/components/CommentReviewPanel";
import { UiIcon } from "@/app/components/UiIcon";
import { ProfileAvatar } from "@/app/components/ProfileAvatar";
import { commentDisplay } from "@/lib/comment-display";
import { CommentIntervention } from "@/app/components/CommentIntervention";
import { loadCommentPage } from "@/app/actions/comment-feed";
import type { CommentParams } from "@/lib/comment-feed";

type Row = { item: typeof socialItems.$inferSelect; analysis: typeof socialAnalyses.$inferSelect | null; connectionName: string | null; parentText: string | null };

export function CommentWorkspace({ rows: initialRows, updateCursor, nextCursor, filters, total }: {
  rows: Row[]; updateCursor: string; nextCursor: string | null; filters: CommentParams; total: number }) {
  const router = useRouter();
  const [older, setOlder] = useState<Row[]>([]);
  const [cursor, setCursor] = useState(nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const rows = useMemo(() => [...initialRows, ...older.filter((row) => !initialRows.some((initial) => initial.item.id === row.item.id))], [initialRows, older]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [advance, setAdvance] = useState(false);
  const [updates, setUpdates] = useState<{ rows: Row[]; cursor: string; count: number; changed: number } | null>(null);
  const [pollError, setPollError] = useState(false);
  const newCount = updates?.rows === rows && updates.cursor === updateCursor ? updates.count : 0;
  const changedCount = updates?.rows === rows && updates.cursor === updateCursor ? updates.changed : 0;
  const [pageVersion, setPageVersion] = useState({ updateCursor, nextCursor });
  if (pageVersion.updateCursor !== updateCursor || pageVersion.nextCursor !== nextCursor) {
    setPageVersion({ updateCursor, nextCursor });
    setOlder([]); setCursor(nextCursor); setLoadError(""); setLoading(false);
  }
  const [fullscreen, setFullscreen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const pageRequest = useRef({ version: 0 });
  const pageLoading = useRef(false);
  async function toggleFullscreen() {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    if (fullscreen) {
      if (document.fullscreenElement === workspace) await document.exitFullscreen().catch(() => {});
      else setFullscreen(false);
      return;
    }
    if (document.fullscreenEnabled && workspace.requestFullscreen) {
      try { await workspace.requestFullscreen(); return; } catch { /* Use the viewport layout when browser fullscreen is unavailable. */ }
    }
    setFullscreen(true);
  }
  useEffect(() => {
    const workspace = workspaceRef.current;
    const changed = () => setFullscreen(document.fullscreenElement === workspace);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (document.fullscreenElement === workspace) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) setFullscreen(false);
    };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", escape); };
  }, [fullscreen]);
  const active = rows.find((row) => row.item.id === selected?.item.id) ?? selected;
  useEffect(() => {
    const request = pageRequest.current;
    request.version++; pageLoading.current = false;
    return () => { request.version++; };
  }, [updateCursor, nextCursor]);
  async function loadMore(selectNext = false) {
    if (!cursor || pageLoading.current) return;
    pageLoading.current = true;
    const request = ++pageRequest.current.version;
    setLoading(true); setLoadError("");
    try {
      const page = await loadCommentPage({ ...filters, cursor });
      if (request !== pageRequest.current.version) return;
      const additions = page.rows.filter((row) => !rows.some((current) => current.item.id === row.item.id));
      setOlder((previous) => [...previous, ...additions]); setCursor(page.nextCursor);
      if (selectNext && additions[0]) setSelected(additions[0]);
    } catch { if (request === pageRequest.current.version) setLoadError("Kalan yorumlar yüklenemedi. Yeniden dene; oturumun kapandıysa tekrar giriş yap."); }
    finally { if (request === pageRequest.current.version) { pageLoading.current = false; setLoading(false); } }
  }
  useEffect(() => { detailRef.current?.scrollTo({ top: 0 }); }, [active?.item.id, active?.item.analysisRevision]);
  function move(direction: number) {
    const current = rows.findIndex((row) => row.item.id === active?.item.id);
    if (direction > 0 && current === rows.length - 1 && cursor) { void loadMore(true); return; }
    const next = rows[Math.max(0, Math.min(rows.length - 1, current + direction))];
    if (next) setSelected(next);
  }
  function reload() {
    const url = new URL(window.location.href);
    if (url.searchParams.has("cursor")) {
      url.searchParams.delete("cursor");
      router.push(`${url.pathname}${url.search}`);
    } else router.refresh();
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented
        || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input,textarea,select,button,a")))) return;
      if (["j", "k"].includes(event.key.toLowerCase())) { event.preventDefault(); move(event.key.toLowerCase() === "j" ? 1 : -1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function poll() {
      if (document.visibilityState === "visible") {
        controller = new AbortController();
        const timeout = setTimeout(() => controller?.abort(), 10000);
        try {
          let count = 0;
          let changed = 0;
          for (let offset = 0; offset < Math.max(rows.length, 1); offset += 1000) {
            const watched = rows.slice(offset, offset + 1000);
            const response = await fetch("/api/items/updates", { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ after: updateCursor, ids: watched.map((row) => row.item.id) }), cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error("updates_failed");
            const body = await response.json();
            count = Math.max(count, Number(body.count) || 0);
            const versions = new Map<string, number>((body.updates ?? []).map((update: { id: string; updatedAt: string }) => [update.id, new Date(update.updatedAt).getTime()]));
            changed += watched.filter((row) => versions.get(row.item.id) !== row.item.updatedAt.getTime()).length;
          }
          if (!stopped) {
            setPollError(false);
            setUpdates({ rows, cursor: updateCursor, count, changed });
          }
        } catch { if (!stopped) setPollError(true); }
        finally { clearTimeout(timeout); }
      }
      if (!stopped) timer = setTimeout(poll, 20000);
    }
    timer = setTimeout(poll, 20000);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [updateCursor, rows]);
  return <div ref={workspaceRef} className={`review-workspace ${selected ? "has-selection" : ""} ${rows.length ? "" : "is-empty"} ${fullscreen ? "is-fullscreen" : ""}`}>
    <div className="review-workspace-toolbar"><span className="review-sort-label"><UiIcon name="comments" size={15} />{rows.length} / {total} yorum · En yeni alınan önce</span><details className="review-options"><summary>Görünüm seçenekleri</summary><div><label><input type="checkbox" checked={advance} onChange={(event) => setAdvance(event.target.checked)} />İnceleme kaydından sonra sonraki yoruma geç</label><p>J / K: yorum değiştir</p></div></details>
      <button className={`btn ${newCount || changedCount ? "primary" : "quiet"}`} onClick={reload}>{newCount ? `${newCount} yeni yorum · Yükle` : changedCount ? `${changedCount} güncelleme · Yükle` : "Yenile"}</button>
      <button className="btn quiet review-fullscreen-button" type="button" aria-pressed={fullscreen} onClick={() => { void toggleFullscreen(); }}>{fullscreen ? "Tam ekrandan çık" : "Tam ekran"}</button>
      {pollError ? <span className="small muted" role="status">Yeni yorum kontrolü şu anda yapılamıyor; akışı elle yenileyebilirsin.</span> : newCount ? <span className="small muted" role="status">Yeni yorum sayısı tüm hesaplara aittir; mevcut filtreler korunur.</span> : null}
    </div>
    <div className="review-list" aria-label="Alınma zamanına göre yorumlar">
      {rows.map((row) => {
        const display = commentDisplay(row.item.raw);
        const platform = row.item.platform === "youtube" ? "YouTube" : row.item.platform === "instagram" ? "Instagram" : "Facebook";
        return <button type="button" className={`review-list-row ${active?.item.id === row.item.id ? "is-selected" : ""}`} key={row.item.id}
        aria-pressed={active?.item.id === row.item.id} aria-controls="selected-comment" onClick={() => setSelected(row)}>
        <span className="review-list-author"><ProfileAvatar name={row.item.authorName || "?"} src={display.author_avatar_url} /><strong>{row.item.authorName || "İsmi paylaşılmayan kullanıcı"}</strong>{row.item.reviewStatus === "new" ? <span className="review-list-unread" role="img" aria-label="Yeni yorum" title="Yeni yorum" /> : null}<time dateTime={row.item.ingestedAt.toISOString()}>{row.item.ingestedAt.toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" })}</time></span>
        <span className="review-list-source"><span className={`review-platform ${row.item.platform}`}>{platform}</span><span title={display.source_channel ?? row.connectionName ?? "Bağlantısı kaldırılmış"}>{display.source_channel ?? row.connectionName ?? "Bağlantısı kaldırılmış"}</span></span>
        <span className="review-list-text" dir="auto">{row.item.text || "Metin içermeyen yorum"}</span>
        <span className="review-list-post" title={display.source_post.text ?? row.item.rootExternalId ?? "Paylaşım bilgisi alınamadı"}>{display.source_post.text?.split("\n")[0] || display.source_post.id || row.item.rootExternalId || "Paylaşım bilgisi alınamadı"}</span>
        <span className="review-list-meta"><span className="review-list-tags"><span className={`badge ${row.analysis && (row.analysis.triageLabel === "acil_inceleme" || (row.analysis.severity ?? 0) >= 70 || row.analysis.containsThreat) ? "danger" : row.analysis?.triageLabel === "insan_incelemesi_gerekli" ? "warn" : ""}`}>{row.item.sourceUnavailableAt ? "Kaynağa erişilemiyor" : row.item.analysisExcluded ? "Geçmiş kayıt · AI yok" : row.analysis ? row.analysis.triageLabel ? triageLabels[row.analysis.triageLabel] : `${row.analysis.containsThreat ? "Tehdit" : categoryLabels[row.analysis.category ?? ""] ?? row.analysis.category} · ${row.analysis.severity}/100` : row.item.analysisStatus === "dead" ? "Analiz başarısız" : "Analiz bekliyor"}</span>
          {row.item.reviewStatus !== "new" ? <span className="small muted">{({ reviewed: "İncelendi", escalated: "Önceliklendirildi", ignored: "Dikkate alınmadı" } as Record<string, string>)[row.item.reviewStatus]}</span> : null}</span></span>
      </button>; })}
      <div className="review-list-pagination"><span className="small muted">{rows.length} yorum gösteriliyor{cursor ? ` · ${Math.max(0, total - rows.length)} yorum daha var` : ""}</span>
        {cursor ? <button className="btn" disabled={loading} onClick={() => { void loadMore(); }}>{loading ? "Yükleniyor…" : "Kalan yorumları yükle"}</button> : null}
        {loadError ? <p className="notice small" role="alert">{loadError}</p> : null}</div>
    </div>
    <div className="review-selected" ref={detailRef} id="selected-comment" role="region" aria-label="Seçilen yorumun incelemesi">
      <div className="review-selection-nav"><button className="btn quiet" onClick={() => setSelected(null)}>Kapat</button><span className="review-selection-title">Yorum ayrıntısı</span><div className="btn-row"><button className="btn quiet" disabled={!rows.length || rows[0]?.item.id === active?.item.id} onClick={() => move(-1)}>Önceki</button><button className="btn quiet" disabled={loading || !rows.length || (!cursor && rows.at(-1)?.item.id === active?.item.id)} onClick={() => move(1)}>Sonraki</button></div></div>
      {active ? <div key={`${active.item.id}:${active.item.analysisRevision}`} className="review-selected-content">
        {selected && !rows.some((row) => row.item.id === selected.item.id) ? <p className="notice">Bu yorum artık mevcut listede değil. Ayrıntıdaki yorum ve AI sonucu son görüntüden korunuyor. <button className="btn quiet" onClick={() => setSelected(null)}>Listedeki güncel yoruma geç</button></p> : null}
        <CommentCard {...active} showActions={false} />
        <CommentIntervention item={active.item} />
        <details className="review-secondary"><summary>Analiz, çeviri ve inceleme geçmişi</summary><CommentReviewPanel item={active.item} analysis={active.analysis} onReviewed={() => { if (advance) move(1); else setSelected(active); }} /></details>
      </div> : <p className="empty">İncelemek için bir yorum seç.</p>}
    </div>
  </div>;
}
