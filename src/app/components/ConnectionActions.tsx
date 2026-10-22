"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function ConnectionActions({ id, status, displayName, platform, webhookSubscribed, reconnectUrl, needsReconnect }: { id: string; status: string; displayName: string; platform?: string; webhookSubscribed?: boolean; reconnectUrl: string | null; needsReconnect?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);

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
    setBusy(true); setError(""); setMessage("");
    try {
      const res = await fetch(`/api/connections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error === "reauthorization_required" ? "Yetki kaldırılmış; hesabı yeniden bağla." : body.error === "connection_changed_retry" ? "Bağlantı başka bir işlemde değişti. Listeyi yenileyip tekrar dene." : "Durum değiştirilemedi. Listeyi yenileyip tekrar dene.");
      setMessage(next === "disabled" ? "Yorum alımı duraklatıldı. Geçmiş yorumlar korundu." : "Takip açıldı. Bağlantı ve izinler kontrol edilecek.");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Durum değiştirilemedi"); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError(""); setMessage("");
    try {
      const res = await fetch(`/api/connections/${id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Bağlantı kaldırılamadı");
      setConfirmRemove(false);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Bağlantı kaldırılamadı"); }
    finally { setBusy(false); }
  }

  return <div>
    <div className="btn-row">
      {status === "disabled"
        ? <button className="btn" disabled={busy} onClick={() => setStatus("active")}>Takibe devam et</button>
        : status === "revoked" || needsReconnect
          ? <a className="btn" href={reconnectUrl ?? "/settings/integrations#meta"}>{reconnectUrl ? "Yeniden bağla" : "Bağlantı ayarlarını aç"}</a>
          : <button className="btn" disabled={busy} onClick={() => setStatus("disabled")}>Duraklat</button>}
      <details className="account-more"><summary>Diğer işlemler</summary><div className="btn-row">
      {needsReconnect && status !== "revoked" ? <button className="btn" disabled={busy} onClick={() => setStatus("disabled")}>Duraklat</button> : null}
      {status === "active" || status === "degraded" ? <button className="btn" disabled={busy} onClick={retrySync}>Yorumları yeniden tara</button> : null}
      {platform === "facebook" && !webhookSubscribed && (status === "active" || status === "degraded") ? <button className="btn" disabled={busy} onClick={restoreSubscription}>Yorum bildirimlerini bağla</button> : null}
      <button ref={removeButton} className="btn danger" disabled={busy} onClick={() => setConfirmRemove(true)}>Bağlantıyı kaldır…</button>
      </div></details>
    </div>
    {confirmRemove ? <div className="account-remove-confirm" role="group" aria-label={`${displayName} bağlantısını kaldır`}><strong>{displayName} bağlantısı kaldırılsın mı?</strong><p>Yeni yorum alımı durur. Geçmiş yorumlar ve incelemeler korunur. Hesap bağlamına bağlı analizler yeniden değerlendirme kuyruğuna alınır. Sosyal medya hesabın silinmez.</p><div className="btn-row"><button className="btn" disabled={busy} onClick={() => { setConfirmRemove(false); removeButton.current?.focus(); }}>Vazgeç</button><button className="btn danger" disabled={busy} onClick={disconnect}>Evet, bağlantıyı kaldır</button></div></div> : null}
    {error ? <div className="account-action-error small" role="alert">{error}</div> : null}
    {message ? <div className="small" role="status" style={{marginTop:6,maxWidth:280}}>{message}</div> : null}
  </div>;
}
