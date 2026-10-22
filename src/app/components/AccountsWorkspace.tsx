"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SetupLink } from "@/app/components/SetupLink";
import { AccountList, type Account } from "@/app/components/AccountList";
import { YouTubeChannels, type Channel } from "@/app/components/YouTubeChannels";
import { UiIcon } from "@/app/components/UiIcon";
import { accountAttention } from "@/lib/account-status";

const platforms = [{ id: "", label: "Tüm platformlar" }, { id: "instagram", label: "Instagram" }, { id: "facebook", label: "Facebook" }, { id: "youtube", label: "YouTube" }];

export function AccountsWorkspace({ accounts, channels, targets, metaConnectUrl, hasYouTubeKey, checkedAt }: {
  accounts: Account[]; channels: Channel[]; targets: { id: string; name: string; enabled: boolean }[];
  metaConnectUrl: string | null; hasYouTubeKey: boolean; checkedAt: number;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const [view, setView] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addPlatform, setAddPlatform] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  function closeAdd() { if (!addBusy) { setAddOpen(false); setAddPlatform(""); } }
  const enabled = new Set(targets.filter(target => target.enabled).map(target => target.id));
  const attention = (account: Account) => Boolean(accountAttention(account, enabled, checkedAt));
  const channelAttention = (channel: Channel) => channel.status !== "paused" && (channel.status === "blocked" || Boolean(channel.lastError));
  const counts = { all: accounts.length + channels.length,
    active: accounts.filter(account => account.status === "active").length + channels.filter(channel => channel.status === "active").length,
    attention: accounts.filter(attention).length + channels.filter(channelAttention).length,
    paused: accounts.filter(account => account.status === "disabled").length + channels.filter(channel => channel.status === "paused").length };
  const query = search.trim().toLocaleLowerCase("tr-TR");
  const matches = (text: string, status: string, needsAttention: boolean) => text.toLocaleLowerCase("tr-TR").includes(query)
    && (!view || (view === "attention" ? needsAttention : view === "paused" ? ["disabled", "paused"].includes(status) : status === "active"));
  const visibleAccounts = accounts.filter(account => (!platform || account.platform === platform)
    && matches(`${account.displayName} ${account.username ?? ""} ${account.externalAccountId}`, account.status, attention(account)));
  const visibleChannels = channels.filter(channel => (!platform || platform === "youtube") && matches(`${channel.title ?? ""} ${channel.url}`, channel.status, channelAttention(channel)));
  const visible = visibleAccounts.length + visibleChannels.length;
  useEffect(() => {
    const openFromLink = () => { if (["#connect", "#youtube-channels"].includes(window.location.hash)) { setAddOpen(true); if (window.location.hash === "#youtube-channels") setAddPlatform("youtube"); } };
    const openFromClick = (event: MouseEvent) => { if (event.target instanceof Element && event.target.closest('a[href="/settings/meta#connect"]')) { setAddPlatform(""); setAddOpen(true); } };
    openFromLink(); window.addEventListener("hashchange", openFromLink);
    document.addEventListener("click", openFromClick);
    const timer = setInterval(() => { if (!document.hidden) router.refresh(); }, 30000);
    return () => { window.removeEventListener("hashchange", openFromLink); document.removeEventListener("click", openFromClick); clearInterval(timer); };
  }, [router]);
  useEffect(() => {
    if (!addOpen) { dialog.current?.close(); return; }
    const previousOverflow = document.body.style.overflow;
    dialog.current?.showModal(); document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [addOpen]);
  useEffect(() => {
    if (addOpen) dialog.current?.querySelector<HTMLElement>(addPlatform ? '.account-channel-add input, .account-connect-choice a' : '.account-platform-picker button')?.focus();
  }, [addOpen, addPlatform]);
  return <div className="accounts-workspace">
    <div className="accounts-command"><p>Hangi hesap takipte, hangisi müdahale bekliyor: tüm bağlantıların burada.</p><div className="btn-row"><button className="btn" onClick={() => router.refresh()}>Listeyi yenile</button><button className="btn primary" aria-haspopup="dialog" onClick={() => { setAddPlatform(""); setAddOpen(true); }}><UiIcon name="plus" size={17} />Hesap / kanal ekle</button></div></div>
    <dialog ref={dialog} className="account-add" aria-labelledby="account-add-title" aria-describedby="account-add-description" onCancel={event => { event.preventDefault(); closeAdd(); }} onClose={() => setAddOpen(false)} onClick={event => { if (event.target === event.currentTarget) closeAdd(); }}>
      {addOpen ? <div className="account-add-body"><div className="account-add-heading"><div><p className="small muted">{addPlatform ? "2 / 2 · Hesabı bağla" : "1 / 2 · Platform seç"}</p><h2 id="account-add-title">{addPlatform ? addPlatform === "youtube" ? "YouTube kanalı ekle" : addPlatform === "instagram" ? "Instagram hesabını bağla" : "Facebook sayfanı bağla" : "Hangi platformu eklemek istiyorsun?"}</h2></div><button className="account-add-close" aria-label="Hesap eklemeyi kapat" disabled={addBusy} onClick={closeAdd}>×</button></div>
      <p id="account-add-description" className="small muted">{addPlatform ? "Yalnız seçtiğin platform için gereken adımı tamamla." : "Hesaplarını bağla veya herkese açık bir YouTube kanalını takibe al."}</p>
      {!addPlatform ? <div className="account-platform-picker" role="group" aria-label="Eklenecek platform">{platforms.slice(1).map(item => <button key={item.id} onClick={() => setAddPlatform(item.id)}><span className="account-platform-title">{item.label}<UiIcon name="arrow" size={17} /></span><small>{item.id === "youtube" ? "Herkese açık bir kanalı takip et" : item.id === "instagram" ? "Profesyonel hesabını bağla" : "Yönettiğin sayfaları bağla"}</small><span className="account-platform-readiness">{(item.id === "youtube" ? hasYouTubeKey : Boolean(metaConnectUrl)) ? "Kurulum hazır" : "Önce kurulum gerekli"}</span></button>)}</div> : <>
      <button className="account-add-back" disabled={addBusy} onClick={() => setAddPlatform("")}>‹ Platform seçimine dön</button>
      {addPlatform === "youtube" ? <YouTubeChannels channels={channels} hasKey={hasYouTubeKey} mode="add" onBusyChange={setAddBusy} onAdded={() => { setAddOpen(false); setAddPlatform(""); setSearch(""); setPlatform("youtube"); setView(""); setFeedback("YouTube kanalı eklendi. Video keşfi sıraya alındı; geçmiş yorumlar yalnız saklanacak."); }} onExisting={channel => { setAddOpen(false); setAddPlatform(""); setSearch(channel.title ?? ""); setPlatform("youtube"); setView(""); }} /> : <div className="account-connect-choice"><p>{addPlatform === "instagram" ? "Facebook sayfana bağlı Business veya Creator Instagram hesabını Meta üzerinden seçip izin ver." : "Meta üzerinden giriş yapıp erişimin olan Facebook sayfalarını seç."} Birden fazla hesap aynı bağlantı akışında eklenebilir.</p><p className="small muted">Bağlantı tamamlandığında hesapların listede görünür. API anahtarı veya sosyal medya şifresi bu forma girilmez.</p>{metaConnectUrl ? <a className="btn primary" href={metaConnectUrl}>Meta ile bağlamaya devam et</a> : <SetupLink />}</div>}</>}
      </div> : null}
    </dialog>
    {feedback ? <p className="notice" role="status">{feedback}</p> : null}
    {counts.all ? <><div className="account-view-tabs" role="group" aria-label="Hesap durumu">{[{ id: "", label: "Tümü", count: counts.all }, { id: "active", label: "Takipte", count: counts.active }, { id: "attention", label: "Kontrol gereken", count: counts.attention }, { id: "paused", label: "Duraklatılan", count: counts.paused }].map(tab => <button key={tab.id} aria-pressed={view === tab.id} onClick={() => setView(tab.id)}>{tab.label}<span>{tab.count}</span></button>)}</div>
    <div className="account-tools"><label className="account-search"><span className="small muted">Hesap ara</span><input className="input" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Hesap adı, kullanıcı adı veya kanal bağlantısı" /></label><label><span className="small muted">Platform</span><select className="input" value={platform} onChange={event => setPlatform(event.target.value)}>{platforms.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
    <div className="account-results" role="status">{visible} / {counts.all} hesap gösteriliyor{counts.attention ? <span> · {counts.attention} hesap için kontrol gerekiyor</span> : null}</div></> : null}
    {!visible ? <section className="panel empty"><UiIcon name="accounts" size={30} /><h2>{counts.all ? "Bu filtrelerle eşleşen hesap yok." : "İlk hesabını bağla."}</h2><p>{counts.all ? "Aramayı temizle veya farklı bir platform ve durum seç." : "Facebook ve Instagram hesaplarını bağla ya da herkese açık bir YouTube kanalını izlemeye al."}</p><button className="btn" onClick={() => { if (counts.all) { setSearch(""); setPlatform(""); setView(""); } else { setAddPlatform(""); setAddOpen(true); } }}>{counts.all ? "Filtreleri temizle" : "Hesap ekle"}</button></section> : <>
      {visibleAccounts.length ? <AccountList accounts={visibleAccounts} targets={targets} reconnectUrl={metaConnectUrl} checkedAt={checkedAt} /> : null}
      {visibleChannels.length ? <YouTubeChannels channels={visibleChannels} hasKey={hasYouTubeKey} mode="list" /> : null}
    </>}
    <p className="small muted account-lifecycle-note">Duraklatma geçicidir; devam ettirebilirsin. Bağlantıyı kaldırmak yeni veri alımını durdurur, geçmiş yorumları ve incelemeleri korur.</p>
  </div>;
}
