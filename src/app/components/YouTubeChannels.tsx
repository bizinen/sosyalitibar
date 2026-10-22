"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { youtubeChannelReference, youtubeProfileImage } from "@/lib/video-source";

export type Channel = { id: string; title: string | null; url: string; status: string; revision: number; count: number;
  profileImageUrl?: string | null; scannedCount?: number; blockedCount?: number; lastCommentScan?: number | null;
  analysisAfter: string | null; lastSyncedAt: string | null; continuing: boolean; lastError: string | null };
const errors: Record<string, string> = { invalid_channel_url: "YouTube @kanal, /channel/UC… veya /user/… bağlantısını gir.",
  youtube_key_required: "Önce bağlantı ayarlarında YouTube kurulumunu tamamla.", channel_exists: "Bu kanal zaten takip ediliyor.",
  youtube_quota_exceeded: "YouTube kotası doldu; daha sonra tekrar dene.", channel_unavailable: "Kanal API üzerinden bulunamadı." };

function ChannelAvatar({ channel }: { channel: Channel }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = youtubeProfileImage({ medium: { url: channel.profileImageUrl ?? "" } });
  const initials = (channel.title || "YouTube").trim().split(/\s+/).filter(word => !/^(dr\.?|prof\.?)$/i.test(word)).slice(0, 2).map(word => word[0]).join("").toLocaleUpperCase("tr-TR");
  return <span className="channel-avatar" aria-hidden="true">{image && image !== failedImage
    // eslint-disable-next-line @next/next/no-img-element -- Official cached channel image with a local fallback.
    ? <img src={image} alt="" width={72} height={72} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImage(image)} />
    : <span>{initials || "YT"}</span>}<span className="channel-platform">▶</span></span>;
}

export function YouTubeChannels({ channels, hasKey, mode = "add", onAdded, onBusyChange, onExisting }: { channels: Channel[]; hasKey: boolean; mode?: "add" | "list"; onAdded?: () => void; onBusyChange?: (busy: boolean) => void; onExisting?: (channel: Channel) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const removeButton = useRef<HTMLButtonElement | null>(null);
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  let reference: ReturnType<typeof youtubeChannelReference> | null = null;
  try { reference = youtubeChannelReference(url.trim()); } catch { /* The incomplete URL stays in the form until corrected. */ }
  const existing = reference?.id ? channels.find(channel => channel.url.endsWith(`/${reference!.id}`)) : undefined;
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setTouched(true);
    if (!reference || !hasKey || existing) return;
    setBusy(true); onBusyChange?.(true); setMessage("");
    try {
      const response = await fetch("/api/youtube/channels", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ url: url.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(errors[body.error] ?? "Kanal eklenemedi. Kanal bağlantısını ve bağlantı ayarlarındaki YouTube durumunu kontrol et.");
      setUrl(""); setTouched(false); setMessage("Kanal eklendi. Videolar sırayla keşfedilecek; geçmiş yorumlar analiz edilmeden saklanacak."); router.refresh(); onAdded?.();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Kanal eklenemedi."); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  async function action(channel: Channel, action: "pause" | "resume" | "remove") {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/videos/${channel.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, revision: channel.revision }) });
      if (!response.ok) {
        if (response.status === 409 || response.status === 404) router.refresh();
        throw new Error(response.status === 409 ? "Kanal başka bir işlemde değişti. Güncel listeyi kontrol edip tekrar dene." : "Kanal güncellenemedi. Listeyi yenileyip tekrar dene.");
      }
      setConfirmRemove(null);
      setMessage(`${channel.title || "Kanal"}: ${action === "remove" ? "takip kaldırıldı; geçmiş yorumlar korundu." : action === "pause" ? "video keşfi ve yorum alımı duraklatıldı." : "kanal takibi devam edecek."}`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "İşlem başarısız."); }
    finally { setBusy(false); }
  }
  return <section className={mode === "list" ? "accounts-section" : "account-channel-add"} id={mode === "add" ? "youtube-channels" : "youtube-channel-list"}><div className="feed-head"><h2>{mode === "list" ? "YouTube kanalları" : "YouTube kanalı ekle"}</h2>{mode === "list" ? <span className="badge">{channels.length} kanal</span> : null}</div>
    {mode === "add" ? <form onSubmit={add} autoComplete="off"><fieldset className="llm-fields" disabled={busy}>
      <label>Kanal bağlantısı<input className="input" name="youtubeChannelUrl" type="url" autoComplete="off" placeholder="https://www.youtube.com/@kanal" maxLength={2048} value={url} onChange={event => { setUrl(event.target.value); setMessage(""); }} onBlur={() => setTouched(true)} aria-invalid={touched && Boolean(url.trim()) && !reference} aria-describedby="youtube-channel-help" required /></label>
      <p id="youtube-channel-help" className="small muted">YouTube kanalının adresini yapıştır. @kanal, /channel/UC… ve /user/… bağlantıları desteklenir; video bağlantısı kullanma.</p>
      {touched && url.trim() && !reference ? <p className="account-action-error small" role="alert">Bu bir YouTube kanal bağlantısı değil. Kanalın ana sayfa adresini gir.</p> : null}
      {existing ? <p className="account-existing" role="status">{existing.title || "Bu kanal"} zaten listende. {onExisting ? <button className="btn" type="button" onClick={() => onExisting(existing)}>Listedeki kanala git</button> : null}</p> : null}
      {!hasKey ? <p className="notice">YouTube bağlantısı henüz hazırlanmadı. <Link className="text-link" href="/settings/integrations#youtube">Bağlantı ayarlarından kurulumu tamamla</Link></p> : null}
      <div className="account-history-policy"><strong>Geçmiş saklanır, yeni yorumlar analiz edilir.</strong><p>Videolar ve erişilebilir yorumlar sırayla alınır. Takip başlangıcından önceki yorumlar için AI çalıştırılmaz. Yeni yorumların analizi kullanımına eklenir.</p></div>
      <button className="btn primary" type="submit" disabled={!hasKey || !reference || Boolean(existing)}>{busy ? "Kanal doğrulanıyor…" : "YouTube kanalını takibe al"}</button>
    </fieldset></form> : null}
    {message ? <p className="notice" role="status">{message}</p> : null}
    {mode === "list" ? <div className="account-grid">{channels.map(channel => <article className="account-card channel-card" key={channel.id}>
      <div className="account-heading"><ChannelAvatar channel={channel} /><div><p className="channel-eyebrow">YouTube kanalı</p><h3><a href={channel.url} target="_blank" rel="noopener noreferrer">{channel.title || "YouTube kanalı"}<span aria-hidden="true"> ↗</span></a></h3><span className={`badge ${channel.status === "blocked" ? "danger" : channel.status === "paused" ? "" : channel.lastError || channel.blockedCount ? "warn" : "ok"}`}>{channel.status === "paused" ? "Duraklatıldı" : channel.status === "blocked" ? "Kontrol gerekiyor" : channel.lastError ? "Yeniden denenecek" : channel.continuing ? "Videolar keşfediliyor" : channel.lastSyncedAt ? "Takipte" : "İlk keşif bekleniyor"}</span></div></div>
      <div className="channel-stats"><div><strong>{channel.count.toLocaleString("tr-TR")}</strong><span>İzlenen video</span></div><div><strong>{channel.scannedCount?.toLocaleString("tr-TR") ?? "—"}</strong><span>İlk taraması tamamlanan</span></div></div>
      {channel.scannedCount !== undefined && channel.count > 0 ? <div className="channel-coverage"><progress value={channel.scannedCount} max={channel.count} aria-label="İzlenen videoların ilk yorum taraması" /><span>{Math.floor(channel.scannedCount / channel.count * 100)}% · izlenen videoların ilk yorum taraması</span></div> : null}
      {channel.blockedCount ? <p className="channel-attention">{channel.blockedCount} videonun yorumları alınamadı. Videolar ve yorumlar ekranından ayrıntıları incele.</p> : null}
      <p className="small muted">{channel.status === "paused" ? "Video keşfi ve yorum alımı duraklatıldı. Geçmiş yorumlar korunuyor." : channel.status === "blocked" ? "Kanal takibi durmuş. Hata bilgisini ve bağlantı ayarlarını kontrol edip yeniden dene." : channel.continuing ? "Kanalın video arşivi sırayla alınıyor. Yeni yorumların takibi de devam eder." : "Kanalın yeni videoları ve yorumları otomatik takip edilir."}</p>
      <div className="channel-last-scan"><span>Son yorum taraması</span><strong>{channel.lastCommentScan ? new Date(channel.lastCommentScan).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Henüz tamamlanmadı"}</strong></div>
      <details className="connection-details"><summary>Takip ayrıntıları</summary><dl><div><dt>Son video keşfi</dt><dd>{channel.lastSyncedAt ? new Date(channel.lastSyncedAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "Henüz tamamlanmadı"}</dd></div><div><dt>Analiz başlangıcı</dt><dd>{channel.analysisAfter ? new Date(channel.analysisAfter).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "Belirlenmedi"}</dd></div><div><dt>Geçmiş yorumlar</dt><dd>Yalnız arşivlenir; otomatik AI analizi yapılmaz. İlk taramanın tamamlanması, erişilebilir yorum sayfalarının alındığını belirtir; yeni yorumların kontrolü devam eder.</dd></div></dl></details>
      {channel.lastError ? <p className="notice">{errors[channel.lastError] ?? "Video keşfi tamamlanamadı. Kaynak/kota kontrolünden sonra tekrar deneyebilirsin."}</p> : null}
      <div className="account-card-actions"><Link className="btn primary" href={`/?mode=sources&connection=youtube:${channel.id}`}>Videolar ve yorumlar</Link><div className="btn-row"><button className="btn" disabled={busy} onClick={() => action(channel, channel.status === "active" ? "pause" : "resume")}>{channel.status === "active" ? "Duraklat" : channel.status === "blocked" ? "Yeniden dene" : "Takibe devam et"}</button><details className="account-more"><summary>Diğer işlemler</summary><button className="btn danger" disabled={busy} onClick={event => { removeButton.current = event.currentTarget; setConfirmRemove(channel.id); }}>Kanal takibini kaldır…</button></details></div></div>
      {confirmRemove === channel.id ? <div className="account-remove-confirm" role="group" aria-label={`${channel.title || "Kanal"} takibini kaldır`}><strong>{channel.title || "Kanal"} takipten çıkarılsın mı?</strong><p>Bu kanalın video keşfi ve yorum alımı durur. Alınan videolar, yorumlar ve incelemeler korunur. Kanalı tekrar eklersen ilk analiz başlangıç tarihi korunur.</p><div className="btn-row"><button className="btn" disabled={busy} onClick={() => { setConfirmRemove(null); removeButton.current?.focus(); }}>Vazgeç</button><button className="btn danger" disabled={busy} onClick={() => action(channel, "remove")}>Evet, takibi kaldır</button></div></div> : null}
    </article>)}</div> : null}
  </section>;
}
