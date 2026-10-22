"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { UiIcon } from "@/app/components/UiIcon";
import type { VideoPlatform } from "@/lib/video-source";

type Video = { id: string; platform: string; url: string; title: string | null; channelName: string | null;
  provider: string; resultsLimit: number; pollMinutes: number; maxChargeCents: number; lastRunId: string | null; lastRunCount: number | null;
  status: string; revision: number; lastError: string | null; lastSyncedAt: string | null; lockedAt: string | null; continuing: boolean; count: number };
const platforms = { youtube: "YouTube", instagram: "Instagram", facebook: "Facebook" };
const errors: Record<string, string> = { invalid_video_url: "Seçili platforma ait bir video veya paylaşım bağlantısı gir.",
  source_identity_mismatch: "Paylaşım bağlantısı ve girilen API kimliği farklı içeriklere ait. Kimliği kontrol et.",
  meta_resource_id_required: "Bu paylaşımın sayısal Meta medya / paylaşım kimliği gerekli. Instagram bağlantısındaki kısa kod, API medya kimliği değildir.",
  youtube_key_required: "YouTube Data API v3 anahtarını gir.", meta_connection_required: "Bu platform için aktif bir Meta bağlantısı seç.",
  apify_key_required: "Apify API tokenını gir.", invalid_recovery: "Bu kayıt mevcut çalışma kimliğiyle kurtarılamıyor.",
  video_exists: "Bu paylaşım zaten listede.", conflict: "Kayıt değişti. Listeyi yenileyip tekrar dene.", source_busy: "Tarama sürüyor veya kaynak duraklatılmış.",
};
function sourceError(code: string) {
  if (code === "apify_start_unknown") return "Apify taramayı başlatmış olabilir. Apify Console’daki çalışma kimliğini girerek devam et; yeni tarama ek ücret doğurabilir.";
  if (code === "apify_run_failed") return "Apify taraması tamamlanamadı. Çalışma ayrıntısını Apify Console’da incele; yeniden başlatmak ücretli yeni tarama oluşturur.";
  if (code === "apify_invalid_result" || code === "apify_invalid_response") return "Sağlayıcı beklenen yorum biçimini döndürmedi. Tarama tamamlanmış sayılmadı.";
  if (code.startsWith("apify_http_")) return "Apify isteği başarısız. Token yetkisini, hesabındaki bakiyeyi ve çalışma erişimini kontrol et.";
  if (code === "comments_disabled") return "Bu videoda yorumlar kapalı.";
  if (code === "video_unavailable") return "Video API üzerinden erişilebilir değil.";
  if (code === "source_identity_mismatch") return "Paylaşım bağlantısı ve API medya kimliği eşleşmiyor. Bağlantıyı ve kimliği düzeltip yeniden ekle.";
  if (code === "youtube_quota_exceeded") return "YouTube API kotası doldu. Sistem daha sonra tekrar deneyecek.";
  if (code.startsWith("meta_http_")) return "Meta bu paylaşımı okumaya izin vermedi veya paylaşım erişilebilir değil. Seçili hesabın yetkisini ve paylaşım kimliğini kontrol et.";
  if (code.startsWith("youtube_http_")) return "YouTube isteği başarısız. API anahtarını, API etkinliğini ve video erişimini kontrol et.";
  return errors[code] ?? "Yorumlar alınamadı. Kaynak bağlantısını kontrol edip tekrar dene.";
}

export function WatchedVideos({ videos, connections, hasYouTubeKey, hasApifyKey, checkedAt }: { videos: Video[];
  connections: { id: string; name: string; platform: string }[]; hasYouTubeKey: boolean; hasApifyKey: boolean; checkedAt: number }) {
  const router = useRouter();
  const [platform, setPlatform] = useState<VideoPlatform>("youtube");
  const [url, setUrl] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<"official" | "apify">("apify");
  const [limit, setLimit] = useState(1000);
  const [minutes, setMinutes] = useState(60);
  const [charge, setCharge] = useState(1);
  const [sourceText, setSourceText] = useState("");
  const [channel, setChannel] = useState("");
  const [runIds, setRunIds] = useState<Record<string, string>>({});
  const apify = platform !== "youtube" && provider === "apify";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(checkedAt);
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); if (!document.hidden) router.refresh(); }, 30000); return () => clearInterval(timer); }, [router]);
  async function add(event: FormEvent) {
    event.preventDefault(); setBusy("add"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/videos", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, url, resourceId: resourceId || undefined,
          provider: apify ? "apify" : "official", resultsLimit: limit, pollMinutes: minutes, maxChargeCents: Math.round(charge * 100),
          sourceText: sourceText || undefined, channelName: channel || undefined,
          connectionId: platform === "youtube" || apify ? undefined : connectionId || undefined, apiKey: platform === "youtube" || apify ? key : undefined }) });
      const body = await response.json();
      if (!response.ok) throw new Error(errors[body.error] ?? "Video eklenemedi. Alanları kontrol et.");
      setUrl(""); setResourceId(""); setKey(""); setSourceText(""); setChannel(""); setMessage("Video eklendi ve yorum taraması sıraya alındı."); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Video eklenemedi."); }
    finally { setBusy(null); }
  }
  async function action(video: Video, value: "pause" | "resume" | "collect" | "remove" | "recover" | "restart") {
    if (value === "remove" && !window.confirm("Bu videoyu izlemeyi kaldırmak istiyor musun? Alınan yorumlar ve inceleme geçmişi korunur.")) return;
    if (value === "restart" && !window.confirm(`Yeni bir ücretli Apify taraması başlatılacak. Tarama bütçe sınırı $${(video.maxChargeCents / 100).toFixed(2)}. Console’da önceki çalışmayı kontrol ettin mi?`)) return;
    setBusy(video.id); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/videos/${video.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: value, revision: video.revision, runId: value === "recover" ? runIds[video.id] : undefined }) });
      const body = await response.json();
      if (!response.ok) throw new Error(errors[body.error] ?? "İşlem yapılamadı.");
      setMessage(body.warning === "apify_abort_unconfirmed" ? "İzleme durduruldu; Apify çalışmasının iptali doğrulanamadı. Ücretli çalışmayı Apify Console’da kontrol et."
        : value === "collect" ? "Yorum taraması sıraya alındı." : "İzleme ayarı güncellendi."); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "İşlem yapılamadı."); }
    finally { setBusy(null); }
  }
  return <>
    <section className="panel"><div className="panel-head"><h2>Video veya paylaşım ekle</h2><UiIcon name="plus" /></div>
      <form className="panel-body" onSubmit={add}><fieldset className="llm-fields" disabled={busy !== null}>
        <label>Platform<select className="input" value={platform} onChange={(event) => { setPlatform(event.target.value as VideoPlatform); setConnectionId(""); setResourceId(""); setKey(""); setError(""); }}>
          {Object.entries(platforms).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>Video / paylaşım bağlantısı<input className="input" type="url" required maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
        {platform !== "youtube" ? <label>Yorum erişimi<select className="input" value={provider} onChange={(event) => { setProvider(event.target.value as "official" | "apify"); setKey(""); setConnectionId(""); setResourceId(""); }}>
          <option value="apify">Apify · başka hesapların herkese açık yorumları</option><option value="official">Meta · yetkilendirilmiş yayın</option></select></label> : null}
        {platform === "youtube" || apify ? <label>{apify ? "Apify API tokenı" : "YouTube Data API anahtarı"}{(apify ? hasApifyKey : hasYouTubeKey) ? " · kayıtlı" : ""}<input className="input" type="password" autoComplete="new-password" required={!(apify ? hasApifyKey : hasYouTubeKey)} maxLength={4096} value={key} onChange={(event) => setKey(event.target.value)} placeholder={(apify ? hasApifyKey : hasYouTubeKey) ? "Boş bırakırsan kayıtlı anahtar kullanılır" : apify ? "Apify Console → Settings → API token" : "Google Cloud API anahtarı"} /></label> : <>
          <label>Meta erişim bağlantısı<select className="input" required value={connectionId} onChange={(event) => setConnectionId(event.target.value)}><option value="">Bağlantı seç</option>
            {connections.filter((connection) => connection.platform === platform).map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
          <label>Meta paylaşım / medya kimliği<input className="input" required={platform === "instagram"} maxLength={100} value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder={platform === "instagram" ? "Sayısal Instagram medya kimliği" : "Bağlantıdan çıkarılamıyorsa paylaşım kimliği"} /></label>
          <p className="small muted">Meta bağlantısı erişim için kullanılır. Yayıncıya veya ilgili herkese otomatik erişim vermez; izin yoksa tarama durumu açıklanır.</p>
        </>}
        {apify ? <>
          <details><summary>Tarama bütçesi ve paylaşım bilgisi</summary><div className="llm-fields" style={{ marginTop: 16 }}>
          <label>Her taramada üst yorum sınırı<input className="input" type="number" min={1} max={10000} required value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></label>
          <label>Tarama aralığı · dakika<input className="input" type="number" min={15} max={10080} required value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
          <label>Tarama başına bütçe sınırı · USD<input className="input" type="number" min={0.1} max={100} step={0.01} required value={charge} onChange={(event) => setCharge(Number(event.target.value))} /></label>
          <label>Yayıncı / kanal adı<input className="input" maxLength={256} value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="Kaynak kanalın adı · isteğe bağlı" /></label>
          <label>Paylaşım metni / video bağlamı<textarea className="input" rows={3} maxLength={20000} value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="Modelin yorumu bağlamıyla değerlendirmesi için · isteğe bağlı" /></label>
          </div></details>
          <p className="small muted">Apify ücretlidir. Ekleme sonrası ilk tarama başlar; ardından seçtiğin aralıkla tekrarlanır. Yanıtlar da istenir ve yorum sınırını aşabilir; bütçe sınırı Apify’ye iletilir. Yalnız sağlayıcının erişebildiği herkese açık yorumlar alınır.</p>
          <a className="small" href="https://console.apify.com/settings/integrations" target="_blank" rel="noopener noreferrer">Apify API tokenını al ↗</a>
        </> : null}
        <button className="btn primary" type="submit">{busy === "add" ? "Ekleniyor…" : "İzlemeye ekle"}</button>
      </fieldset></form></section>
    {error ? <div className="notice" role="alert" style={{ marginTop: 16 }}>{error}</div> : null}
    {message ? <p className="small" role="status">{message}</p> : null}
    <div className="feed-head"><h2>İzleme listesi <span className="badge">{videos.length}</span></h2><button className="btn" disabled={busy !== null} onClick={() => router.refresh()}>Yenile</button></div>
    {videos.length === 0 ? <section className="panel empty"><UiIcon name="comments" size={28} /><h2>İlk videoyu ekle.</h2><p>Video bağlantısını gir; alınan yorumlar mevcut inceleme ekranında görünsün.</p></section> : <div className="watched-video-grid">{videos.map((video) => {
      const running = video.lockedAt && Math.max(now, checkedAt) - Date.parse(video.lockedAt) < 180000;
      const status = video.status === "paused" ? "Duraklatıldı" : video.status === "blocked" ? "Erişim / tarama sorunu" : running ? "Yorumlar alınıyor" : video.lastError ? "Tekrar denenecek" : video.continuing ? "Tarama devam edecek" : video.lastSyncedAt ? "Son tarama tamamlandı" : "İlk tarama bekleniyor";
      return <article className="panel watched-video-card" key={video.id}>
        <div className="watched-video-meta"><span className={`review-platform ${video.platform}`}>{platforms[video.platform as VideoPlatform]}</span><span className={`badge ${video.lastError ? "warn" : video.status === "paused" ? "" : "blue"}`}>{status}</span></div>
        <h3><a href={video.url} target="_blank" rel="noopener noreferrer">{video.title || "Video / paylaşım"}<UiIcon name="arrow" size={15} /></a></h3>
        <a className="small muted" href={video.url} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: "anywhere" }}>{video.url}</a>
        <p className="small muted">{video.channelName || (video.provider === "apify" ? "Harici yayın" : "Kanal bilgisi ilk taramada alınır")}{video.provider === "apify" ? ` · Apify · ${video.pollMinutes} dk · $${(video.maxChargeCents / 100).toFixed(2)} / tarama sınırı` : ""}</p>
        <div className="watched-video-stats"><strong>{video.count} yorum</strong><span className="small muted">{video.lastSyncedAt ? `Son tarama: ${new Date(video.lastSyncedAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}` : "Tarama henüz tamamlanmadı"}</span></div>
        {video.lastError ? <p className="notice small">{sourceError(video.lastError)}</p> : null}
        {video.provider === "apify" ? <p className="small muted">{video.lastRunCount === 0 ? "Son tarama hiç yorum döndürmedi; bu, yorum olmadığı anlamına gelmeyebilir." : "Taramalar erişilebilen yorumları kapsar; tam kapsama garantisi yoktur."}
          {video.lastRunId ? <> <a href={`https://console.apify.com/actors/runs/${video.lastRunId}`} target="_blank" rel="noopener noreferrer">Apify çalışmasını aç ↗</a></> : null}</p> : null}
        {video.provider === "apify" && video.status === "blocked" && video.continuing ? <div className="watched-video-actions">
          <input className="input" aria-label="Apify çalışma kimliği" value={runIds[video.id] ?? ""} onChange={(event) => setRunIds({ ...runIds, [video.id]: event.target.value.trim() })} placeholder="Apify Console’daki Run ID" maxLength={40} />
          <button className="btn" disabled={busy !== null || !/^[A-Za-z0-9]{10,40}$/.test(runIds[video.id] ?? "")} onClick={() => action(video, "recover")}>Bu çalışmadan devam et</button>
          <button className="btn" disabled={busy !== null} onClick={() => action(video, "restart")}>Yeni tarama başlat</button></div> : null}
        <div className="watched-video-actions"><Link className="btn primary" href={`/?video=${video.id}`}>Yorumları gör</Link>
          {!(video.provider === "apify" && video.status === "blocked" && video.continuing) ? <button className="btn" disabled={busy !== null || Boolean(running)} onClick={() => action(video, video.status === "active" ? "collect" : "resume")}>{video.status === "paused" ? "Devam et" : video.status === "blocked" ? "Tekrar dene" : "Yorumları al"}</button> : null}
          {video.status === "active" ? <button className="btn" disabled={busy !== null} onClick={() => action(video, "pause")}>Duraklat</button> : null}
          <button className="btn" disabled={busy !== null} onClick={() => action(video, "remove")}>İzlemeyi kaldır</button></div>
      </article>;
    })}</div>}
  </>;
}
