"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ConnectionActions({ id, status, displayName }: { id: string; status: string; displayName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    if (!window.confirm(`${displayName} bağlantısı kaldırılsın mı? Geçmiş yorum ve analizler korunacak.`)) return;
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
    </div>
    {error ? <div className="small" style={{color:"var(--danger)",marginTop:6,maxWidth:280}}>{error}</div> : null}
  </div>;
}
