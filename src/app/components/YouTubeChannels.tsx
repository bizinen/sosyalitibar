"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Channel = { id: string; title: string | null; url: string; status: string; revision: number; count: number;
  analysisAfter: string | null; lastSyncedAt: string | null; continuing: boolean; lastError: string | null };
const errors: Record<string, string> = { invalid_channel_url: "YouTube @kanal, /channel/UC… veya /user/… bağlantısını gir.",
  youtube_key_required: "Önce bağlantı ayarlarında YouTube kurulumunu tamamla.", channel_exists: "Bu kanal zaten takip ediliyor.",
  youtube_quota_exceeded: "YouTube kotası doldu; daha sonra tekrar dene.", channel_unavailable: "Kanal API üzerinden bulunamadı." };

export function YouTubeChannels({ channels, hasKey }: { channels: Channel[]; hasKey: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!channels.length) return;
    const timer = setInterval(() => { if (!document.hidden) router.refresh(); }, 30000);
    return () => clearInterval(timer);
  }, [channels.length, router]);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/youtube/channels", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: String(values.get("youtubeChannelUrl") ?? "").trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(errors[body.error] ?? "Kanal eklenemedi. Kanal bağlantısını ve bağlantı ayarlarındaki YouTube durumunu kontrol et.");
      form.reset(); setMessage("Kanal eklendi. Videolar sırayla keşfedilecek; geçmiş yorumlar analiz edilmeden saklanacak."); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Kanal eklenemedi."); }
    finally { setBusy(false); }
  }
  async function action(channel: Channel, action: "pause" | "resume" | "remove") {
    if (action === "remove" && !window.confirm("Kanal takibi duracak; alınan videolar ve yorumlar korunacak. Devam edilsin mi?")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/videos/${channel.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, revision: channel.revision }) });
      if (!response.ok) throw new Error("Kanal güncellenemedi. Sayfayı yenileyip tekrar dene.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "İşlem başarısız."); }
    finally { setBusy(false); }
  }
  return <section className="panel" id="youtube-channels"><div className="panel-head"><h2>YouTube kanalı ekle</h2></div><div className="panel-body">
    <form onSubmit={add} autoComplete="off"><fieldset className="llm-fields" disabled={busy}>
      <label>Kanal bağlantısı<input className="input" name="youtubeChannelUrl" type="url" autoComplete="off" placeholder="https://www.youtube.com/@kanal" maxLength={2048} required /></label>
      {!hasKey ? <p className="notice">YouTube bağlantısı henüz hazırlanmadı. <Link className="text-link" href="/settings/integrations#youtube">Bağlantı ayarlarından kurulumu tamamla</Link></p> : null}
      <p className="small muted">Geçmiş yalnız kaydedilir. Kanal takibinin başladığı tarihten sonra yazılan yorumlar ve yanıtlar AI analizine girer. Yeni videolar 15 dakikada bir keşfedilir; yeni videolar saatlik, eski videolar günlük taranır. Büyük arşivler kotaya göre aşamalı tamamlanır. Yorumların toplanması yeni yorumların Runware analiz kullanımını artırabilir.</p>
      <button className="btn primary" type="submit" disabled={!hasKey}>YouTube kanalını ekle</button>
    </fieldset></form>
    {message ? <p className="notice" role="status">{message}</p> : null}
    {channels.map(channel => <article className="panel-body" key={channel.id}>
      <h3><a href={channel.url} target="_blank" rel="noopener noreferrer">{channel.title || "YouTube kanalı"}</a> <span className="badge">{channel.status === "paused" ? "Duraklatıldı" : channel.status === "blocked" ? "Müdahale bekliyor" : channel.continuing ? "Video keşfi sürüyor" : channel.lastSyncedAt ? "Takip ediliyor" : "İlk keşif bekleniyor"}</span></h3>
      <p>{channel.count} video izlemeye alındı · <Link className="text-link" href={`/?mode=sources&connection=youtube:${channel.id}`}>Kanalın paylaşımlarını ve yorumlarını gör</Link></p>
      <p className="small muted">Yeni yorumların analiz başlangıcı: {channel.analysisAfter ? new Date(channel.analysisAfter).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) : "Belirlenmedi"}. Geçmiş yorumlara otomatik AI kararı verilmez.</p>
      {channel.lastError ? <p className="notice">{errors[channel.lastError] ?? "Video keşfi tamamlanamadı. Kaynak/kota kontrolünden sonra tekrar deneyebilirsin."}</p> : null}
      <div className="watched-video-actions"><button className="btn" disabled={busy} onClick={() => action(channel, channel.status === "active" ? "pause" : "resume")}>{channel.status === "active" ? "Duraklat" : "Devam et"}</button><button className="btn" disabled={busy} onClick={() => action(channel, "remove")}>Kanal takibini kaldır</button></div>
    </article>)}
  </div></section>;
}
