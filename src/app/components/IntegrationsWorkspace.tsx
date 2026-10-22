"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import Link from "next/link";
import { MetaSettingsForm } from "@/app/components/MetaSettingsForm";
import { YouTubeSettingsForm } from "@/app/components/YouTubeSettingsForm";
import { UiIcon } from "@/app/components/UiIcon";

export function IntegrationsWorkspace({ meta, youtube }: {
  meta: ComponentProps<typeof MetaSettingsForm>; youtube: ComponentProps<typeof YouTubeSettingsForm>;
}) {
  const [provider, setProvider] = useState<"youtube" | "meta" | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const metaReady = Boolean(meta.appId && meta.hasSecret && meta.hasVerifyToken && meta.publicOrigin.startsWith("https://"));
  const providers = [
    { id: "youtube" as const, name: "YouTube", description: "Kanal ve video yorumları", ready: youtube.hasKey, status: "API anahtarı kayıtlı", icon: "play" as const, detail: "Tek API anahtarı, eklediğin tüm YouTube kanallarında kullanılır." },
    { id: "meta" as const, name: "Facebook ve Instagram", description: "Meta ile ortak kurulum", ready: metaReady, status: "Uygulama bilgileri kayıtlı", icon: "accounts" as const, detail: "Yönettiğin Facebook sayfaları ve onlara bağlı profesyonel Instagram hesapları için." },
  ];
  function open(id: "youtube" | "meta", button?: HTMLElement) {
    trigger.current = button ?? document.activeElement as HTMLElement;
    setDirty(false); setBusy(false); setConfirmClose(false); setProvider(id);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
  }
  function close() {
    setProvider(null); setDirty(false); setConfirmClose(false);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  function requestClose() { if (!busy) { if (dirty) setConfirmClose(true); else close(); } }
  useEffect(() => {
    const fromHash = () => {
      if (dialog.current?.open) return;
      const id = window.location.hash.slice(1);
      if (id === "youtube" || id === "meta") { trigger.current = document.getElementById(`configure-${id}`); setProvider(id); }
    };
    fromHash(); window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  useEffect(() => {
    if (!provider) { dialog.current?.close(); trigger.current?.focus(); return; }
    const overflow = document.body.style.overflow;
    dialog.current?.showModal(); document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, [provider]);
  useEffect(() => {
    if (confirmClose) dialog.current?.querySelector<HTMLElement>("[data-keep-editing]")?.focus();
  }, [confirmClose]);
  const selected = providers.find(item => item.id === provider);
  return <div className="integrations-workspace">
    <section className="integration-list" aria-label="Platform kurulumları">
      {providers.map(item => <article className="integration-row" key={item.id}>
        <span className="integration-symbol"><UiIcon name={item.icon} size={24} /></span>
        <div className="integration-identity"><h2>{item.name}</h2><p className="small muted">{item.description}</p><p className="integration-detail">{item.detail}</p></div>
        <div className="integration-controls"><span className="integration-status"><UiIcon name={item.ready ? "check" : "settings"} size={15} />{item.ready ? item.status : "Kurulum gerekli"}</span><button id={`configure-${item.id}`} className="btn" aria-haspopup="dialog" onClick={event => open(item.id, event.currentTarget)}><UiIcon name="settings" size={17} />{item.ready ? "Ayarları düzenle" : "Kurulumu tamamla"}</button></div>
      </article>)}
    </section>
    <div className="integration-next"><UiIcon name="accounts" size={20} /><div><strong>Hesaplarını tek yerden yönet.</strong><p className="small muted">Kurulumdan sonra hesap ekleme, takip ve bağlantı durumları için Hesaplarım’a geç.</p></div><Link className="btn" href="/settings/meta">Hesaplarım<UiIcon name="arrow" size={16} /></Link></div>
    <p className="small muted integration-footnote"><UiIcon name="shield" size={15} />Kayıt durumu gösterilir. Platform erişimi, hesap veya kanal eklerken doğrulanır.</p>
    <dialog ref={dialog} className="account-add integration-dialog" aria-labelledby="integration-title" aria-describedby="integration-description" onCancel={event => { event.preventDefault(); requestClose(); }} onClick={event => { if (event.target === event.currentTarget) requestClose(); }}>
      {selected ? <div className="account-add-body">
        <div className="account-add-heading"><div><h2 id="integration-title">{selected.name} ayarları</h2><p id="integration-description" className="small muted">{provider === "youtube" ? "Bir kez kaydet, tüm kanallarında kullan." : "Facebook ve Instagram için tek uygulama kurulumu."}</p></div><button className="account-add-close" aria-label="Ayarları kapat" autoFocus disabled={busy} onClick={requestClose}>×</button></div>
        {confirmClose ? <div className="integration-discard" role="alert"><strong>Değişikliklerin henüz kaydedilmedi.</strong><p className="small muted">Kapatırsan bu düzenlemeler silinir; kayıtlı ayarlar korunur.</p><div className="btn-row"><button className="btn" data-keep-editing onClick={() => { setConfirmClose(false); dialog.current?.querySelector<HTMLElement>(".account-add-close")?.focus(); }}>Düzenlemeye dön</button><button className="btn danger" onClick={close}>Kaydetmeden kapat</button></div></div> : null}
        <div hidden={confirmClose}>{provider === "youtube" ? <YouTubeSettingsForm {...youtube} onBusyChange={setBusy} onDirtyChange={setDirty} /> : <MetaSettingsForm {...meta} onBusyChange={setBusy} onDirtyChange={setDirty} />}</div>
      </div> : null}
    </dialog>
  </div>;
}
