"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UiIcon } from "@/app/components/UiIcon";
import type { SourceWatch } from "@/lib/comment-sources";

export function SourceCardActions({ title, commentsHref, permalink, settingsHref, watch }: {
  title: string; commentsHref: string; permalink: string | null; settingsHref: string; watch: SourceWatch | null;
}) {
  const router = useRouter();
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
  async function action(value: "pause" | "resume" | "collect" | "remove") {
    if (!watch || busy) return;
    closeMenu(); setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/videos/${watch.id}`, { method: "PATCH", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(30000), body: JSON.stringify({ action: value, revision: watch.revision }) });
      const body = await response.json();
      if (!response.ok) {
        if ([404, 409].includes(response.status)) router.refresh();
        throw new Error(body.error === "source_busy" ? "Tarama şu an sürüyor. Daha sonra tekrar dene."
          : response.status === 409 ? "Takip kaydı değişti. Güncel karttan tekrar dene." : "İşlem tamamlanamadı. Tekrar dene.");
      }
      setConfirm(false);
      setMessage(body.warning === "apify_abort_unconfirmed" ? "Takip durduruldu; Apify çalışmasının iptali doğrulanamadı. Ayarlardan çalışma durumunu kontrol et."
        : value === "remove" ? "Takip kaldırıldı. Alınan yorumlar ve incelemeler korundu." : value === "collect" ? "Yorum taraması sıraya alındı."
          : value === "pause" ? "Yeni yorum alımı duraklatıldı." : "Yorum takibi devam edecek.");
      router.refresh(); trigger.current?.focus();
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
          {watch.status === "active" ? <button role="menuitem" disabled={busy} onClick={() => action("pause")}><UiIcon name="pause" size={16} />Yorum alımını duraklat</button>
            : watch.provider === "apify" ? <Link role="menuitem" href={settingsHref}><UiIcon name="play" size={16} />Taramayı ayarlardan yönet</Link>
              : <button role="menuitem" disabled={busy || watch.channelPaused} onClick={() => action("resume")}><UiIcon name="play" size={16} />{watch.status === "blocked" ? "Taramayı yeniden dene" : "Yorum alımına devam et"}</button>}
          {watch.channelPaused ? <p className="source-menu-note">Önce Hesaplarım sayfasından kanal takibini devam ettir.</p> : null}
          <button className="source-menu-remove" role="menuitem" disabled={busy} onClick={() => { closeMenu(); setError(""); setConfirm(true); }}><UiIcon name="trash" size={16} />Takipten çıkar…</button>
        </> : <Link role="menuitem" href={settingsHref}><UiIcon name="settings" size={16} />Takip ayarlarını yönet</Link>}
      </div>
    </details>
    <div className="source-card-footer">
      <Link className="btn source-action-review" href={commentsHref} prefetch={false}><UiIcon name="comments" size={15} /><span>Yorumları incele</span></Link>
      {permalink ? <a className="btn source-action-open" href={permalink} target="_blank" rel="noopener noreferrer"><UiIcon name="external" size={15} /><span>Paylaşımı aç</span></a>
        : <span className="btn" aria-disabled="true" title="Bu paylaşımın kaynak bağlantısı bulunamadı"><UiIcon name="external" size={15} /><span>Bağlantı yok</span></span>}
      <Link className="btn source-action-settings" href={settingsHref} prefetch={false}><UiIcon name="settings" size={15} /><span>Ayarlar</span></Link>
    </div>
    {confirm ? <div className="source-remove-confirm" role="group" aria-label="Paylaşım takibini kaldır">
      <strong>Bu paylaşım takipten çıkarılsın mı?</strong><p>Yeni yorum alımı durur. Alınan yorumlar ve inceleme geçmişi korunur. Paylaşım sosyal medya platformundan silinmez.</p>
      <div className="btn-row"><button className="btn" ref={cancel} disabled={busy} onClick={() => { setConfirm(false); setError(""); trigger.current?.focus(); }}>Vazgeç</button>
        <button className="btn danger" disabled={busy} onClick={() => action("remove")}>{busy ? "Kaldırılıyor…" : "Evet, takibi kaldır"}</button></div>
    </div> : null}
    {error ? <p className="source-action-feedback account-action-error" role="alert">{error}</p> : null}
    {message ? <p className="source-action-feedback muted" role="status">{message}</p> : null}
  </div>;
}
