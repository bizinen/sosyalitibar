"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UiIcon } from "@/app/components/UiIcon";
import type { SourceWatch } from "@/lib/comment-sources";

export function SourceCardActions({ title, commentsHref, permalink, settingsHref, watch, sourceKey, commentsCount }: {
  title: string; commentsHref: string; permalink: string | null; settingsHref: string; watch: SourceWatch | null; sourceKey?: string; commentsCount?: number;
}) {
  const router = useRouter();
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"remove" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deleted, setDeleted] = useState(false);
  function closeMenu() { if (menu.current) menu.current.open = false; }
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (event.target instanceof Node && !menu.current?.contains(event.target)) closeMenu(); }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); trigger.current?.focus(); }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { if (confirm) cancel.current?.focus(); }, [confirm]);
  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length]?.focus();
  }
  async function action(value: "pause" | "resume" | "collect" | "remove" | "delete") {
    if (busy || (value === "delete" ? !sourceKey : !watch)) return;
    closeMenu(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(value === "delete" ? `/api/sources/${sourceKey}` : `/api/videos/${watch!.id}`, { method: value === "delete" ? "DELETE" : "PATCH", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(30000), body: JSON.stringify(value === "delete" ? { confirm: "delete_source", revision: watch?.revision ?? null } : { action: value, revision: watch!.revision }) });
      const body = await response.json();
      if (!response.ok) {
        if ([404, 409].includes(response.status)) router.refresh();
        throw new Error(body.error === "source_busy" ? "Tarama şu an sürüyor. Daha sonra tekrar dene."
          : response.status === 409 ? "Takip kaydı değişti. Güncel karttan tekrar dene." : "İşlem tamamlanamadı. Tekrar dene.");
      }
      setConfirm(null);
      if (value === "delete") setDeleted(true);
      setMessage(body.warning === "apify_abort_unconfirmed" ? "İşlem tamamlandı; Apify çalışmasının iptali doğrulanamadı. Apify panelinden çalışma durumunu kontrol et."
        : value === "delete" ? "Paylaşım ve ilişkili verileri silindi. İstersen paylaşımı yeniden ekleyebilirsin."
        : value === "remove" ? "Takip kaldırıldı. Alınan yorumlar ve incelemeler korundu." : value === "collect" ? "Yorum taraması sıraya alındı."
          : value === "pause" ? "Yeni yorum alımı duraklatıldı." : "Yorum takibi devam edecek.");
      if (value !== "delete" || !body.warning) router.refresh();
      trigger.current?.focus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "İşlem tamamlanamadı."); }
    finally { setBusy(false); }
  }
  async function copyLink() {
    if (!permalink) return;
    closeMenu();
    try { await navigator.clipboard.writeText(permalink); setError(""); setMessage("Paylaşım bağlantısı kopyalandı."); }
    catch { setError("Bağlantı kopyalanamadı. Paylaşımı aç düğmesini kullanabilirsin."); }
    trigger.current?.focus();
  }
  if (deleted) return <div className="source-action-feedback" role="status"><p>{message}</p><button className="btn" onClick={() => router.refresh()}>Listeyi yenile</button></div>;
  return <div className="source-card-controls" aria-busy={busy}>
    <details className="action-menu source-card-menu" ref={menu} onToggle={event => setOpen(event.currentTarget.open)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
    }}>
      <summary ref={trigger} aria-label={`${title}: diğer işlemler`} aria-haspopup="menu" onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (menu.current) menu.current.open = true;
          const items = menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
          items?.[event.key === "ArrowUp" ? items.length - 1 : 0]?.focus(); }
      }}><UiIcon name="more" size={18} /></summary>
      <div className="action-menu-content" role="menu" aria-label="Paylaşım işlemleri" onKeyDown={menuKey}>
        {permalink ? <button role="menuitem" disabled={busy} onClick={copyLink}><UiIcon name="external" size={16} />Bağlantıyı kopyala</button> : null}
        {watch ? <>
          {watch.provider !== "apify" && watch.status === "active" ? <button role="menuitem" disabled={busy || watch.running || watch.channelPaused} onClick={() => action("collect")}><UiIcon name="refresh" size={16} />Yorumları şimdi kontrol et</button> : null}
          {watch.status === "removed" ? <Link role="menuitem" href="/settings/videos"><UiIcon name="play" size={16} />Paylaşımı yeniden ekle</Link> : watch.status === "active" ? <button role="menuitem" disabled={busy} onClick={() => action("pause")}><UiIcon name="pause" size={16} />Yorum alımını duraklat</button>
            : watch.provider === "apify" ? <Link role="menuitem" href={settingsHref}><UiIcon name="play" size={16} />Taramayı ayarlardan yönet</Link>
              : <button role="menuitem" disabled={busy || watch.channelPaused} onClick={() => action("resume")}><UiIcon name="play" size={16} />{watch.status === "blocked" ? "Taramayı yeniden dene" : "Yorum alımına devam et"}</button>}
          {watch.channelPaused ? <p className="source-menu-note">Önce Hesaplarım sayfasından kanal takibini devam ettir.</p> : null}
          {watch.status !== "removed" ? <button className="source-menu-remove" role="menuitem" disabled={busy} onClick={() => { closeMenu(); setError(""); setConfirm("remove"); }}><UiIcon name="trash" size={16} />Takipten çıkar…</button> : null}
        </> : <Link role="menuitem" href={settingsHref}><UiIcon name="settings" size={16} />Takip ayarlarını yönet</Link>}
        {sourceKey ? <button className="source-menu-remove" role="menuitem" disabled={busy} onClick={() => { closeMenu(); setError(""); setConfirm("delete"); }}><UiIcon name="trash" size={16} />Yorumlarıyla birlikte sil…</button> : null}
      </div>
    </details>
    <div className="source-card-footer">
      <Link className="btn source-action-review" href={commentsHref} prefetch={false}><UiIcon name="comments" size={15} /><span>Yorumları incele</span></Link>
      {permalink ? <a className="btn source-action-open" href={permalink} target="_blank" rel="noopener noreferrer"><UiIcon name="external" size={15} /><span>Paylaşımı aç</span></a>
        : <span className="btn" aria-disabled="true" title="Bu paylaşımın kaynak bağlantısı bulunamadı"><UiIcon name="external" size={15} /><span>Bağlantı yok</span></span>}
      <Link className="btn source-action-settings" href={settingsHref} prefetch={false}><UiIcon name="settings" size={15} /><span>Ayarlar</span></Link>
    </div>
    {confirm ? <div className="source-remove-confirm" role="group" aria-label={confirm === "delete" ? "Paylaşımı ve verilerini sil" : "Paylaşım takibini kaldır"} onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); setConfirm(null); trigger.current?.focus(); }
    }}>
      <strong>{confirm === "delete" ? "Paylaşım ve tüm verileri silinsin mi?" : "Bu paylaşım takipten çıkarılsın mı?"}</strong>
      {confirm === "delete" ? <><p>Bu görünümde {commentsCount?.toLocaleString("tr-TR") ?? "—"} yorum var. Paylaşımın tüm yorumları, yanıtları, analizleri, çevirileri, inceleme geçmişi ve alarm kayıtları kalıcı olarak silinir. Filtre dışında kalan yorumlar da dahildir.</p>
        <p>Bu işlem geri alınamaz. İstersen paylaşımı yeniden ekleyebilirsin. Sosyal medyadaki paylaşım ve yorumlar değişmez; önceden gönderilmiş bildirimler geri alınmaz.</p></>
        : <p>Yeni yorum alımı durur. Alınan yorumlar ve inceleme geçmişi korunur. Paylaşım sosyal medya platformundan silinmez.</p>}
      <div className="btn-row"><button className="btn" ref={cancel} disabled={busy} onClick={() => { setConfirm(null); setError(""); trigger.current?.focus(); }}>Vazgeç</button>
        <button className="btn danger" disabled={busy} onClick={() => action(confirm === "delete" ? "delete" : "remove")}>{busy ? "İşleniyor…" : confirm === "delete" ? "Evet, tüm verileri sil" : "Evet, takibi kaldır"}</button></div>
    </div> : null}
    {error ? <p className="source-action-feedback account-action-error" role="alert">{error}</p> : null}
    {message ? <p className="source-action-feedback muted" role="status">{message}</p> : null}
  </div>;
}
