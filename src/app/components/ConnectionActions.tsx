"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ConnectionActions({ id, status, displayName, platform, webhookSubscribed }: { id: string; status: string; displayName: string; platform?: string; webhookSubscribed?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function retrySync() {
    setBusy(true); setError(""); setMessage("");
    try {
      const res = await fetch("/api/meta/sync-comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: id, retryFailed: true }) });
      const body = await res.json().catch(() => ({}));
      const result = body.results?.[0];
      if (!res.ok || !result || !result.ok || result.skipped) throw new Error(result?.error || "Tarama başlatılamadı; bağlantının durumunu kontrol edin.");
      setMessage(result.failedTasks ? `${result.failedTasks} tarama işi hâlâ müdahale gerektiriyor.` : result.coverageLimited ? "Tarama ilerledi; kalan işler worker tarafından sürdürülecek." : "Yorum taraması tamamlandı.");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Tarama yeniden denenemedi"); }
    finally { setBusy(false); }
  }

  async function restoreSubscription() {
    setBusy(true); setError(""); setMessage("");
    try {
      const res = await fetch(`/api/connections/${id}/subscribe`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error === "reauthorization_required" ? "Meta hesabını yeniden bağlayın." : body.error === "connection_paused" ? "Önce bağlantıyı etkinleştirin." : body.error === "connection_health_failed" ? "Token ve izin sorunlarını giderdikten sonra tekrar deneyin." : "Webhook aboneliği kurulamadı; bağlantı hata bilgisini kontrol edin.");
      setMessage(body.status === "active" ? "Webhook aboneliği yeniden kuruldu." : "Webhook aboneliği kuruldu; bağlantı sağlık durumunu kontrol edin.");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Webhook aboneliği kurulamadı"); }
    finally { setBusy(false); }
  }

  async function setStatus(next: "active" | "disabled") {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/connections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error === "reauthorization_required" ? "Token iptal edilmiş; Meta hesabını yeniden bağlayın." : (body.error || "Durum değiştirilemedi"));
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Durum değiştirilemedi"); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm(`${displayName} bağlantısı kaldırılsın mı? Geçmiş yorumlar korunacak, hesap bağlamına bağlı analizler yeniden değerlendirilecek.`)) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Bağlantı kaldırılamadı");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Bağlantı kaldırılamadı"); }
    finally { setBusy(false); }
  }

  return <div>
    <div className="btn-row">
      {status === "disabled"
        ? <button className="btn" disabled={busy} onClick={() => setStatus("active")}>Etkinleştir</button>
        : status === "revoked"
          ? <a className="btn" href="/api/meta/connect">Yeniden bağla</a>
          : <button className="btn" disabled={busy} onClick={() => setStatus("disabled")}>Durdur</button>}
      <button className="btn danger" disabled={busy} onClick={disconnect}>Bağlantıyı kaldır</button>
      {status === "active" || status === "degraded" ? <button className="btn" disabled={busy} onClick={retrySync}>Taramayı yeniden dene</button> : null}
      {platform === "facebook" && !webhookSubscribed && (status === "active" || status === "degraded") ? <button className="btn" disabled={busy} onClick={restoreSubscription}>Webhook'u yeniden kur</button> : null}
    </div>
    {error ? <div className="small" style={{color:"var(--danger)",marginTop:6,maxWidth:280}}>{error}</div> : null}
    {message ? <div className="small" role="status" style={{marginTop:6,maxWidth:280}}>{message}</div> : null}
  </div>;
}
