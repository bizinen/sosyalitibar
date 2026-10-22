"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export function YouTubeSettingsForm({ hasKey, revision, onBusyChange, onDirtyChange }: { hasKey: boolean; revision: number; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(!hasKey);
  const [version, setVersion] = useState(revision);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(Boolean(key)); }, [key, onDirtyChange]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/settings/youtube", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: key, revision: version }), signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error === "conflict" ? "Ayarlar başka bir ekranda değişti. Sayfayı yenile." : "Ayarlar kaydedilemedi. Anahtarı kontrol et.");
      setVersion(data.revision); setKey(""); setEditing(false); setMessage("YouTube anahtarı kaydedildi. Kanal ve videolar sonraki taramada bu anahtarı kullanacak."); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Ayarlar kaydedilemedi."); }
    finally { setBusy(false); }
  }
  return <div className="integration-form">
    <p className="small muted">YouTube Data API v3 anahtarın şifreli saklanır. Kayıtlı anahtar burada gösterilmez.</p>
    {editing ? <form onSubmit={save}><fieldset className="llm-fields" disabled={busy}>
      <label>YouTube Data API anahtarı<input className="input" name="youtubeProviderApiKey" type="password" autoComplete="new-password" maxLength={4096} value={key} onChange={event => setKey(event.target.value)} required /></label>
      <button className="btn primary" type="submit">YouTube ayarlarını kaydet</button>
      {hasKey || version > 0 ? <button className="btn" type="button" onClick={() => { setKey(""); setEditing(false); }}>Vazgeç</button> : null}
    </fieldset></form> : <p><span className="badge">API anahtarı kayıtlı</span> <button className="btn" onClick={() => setEditing(true)}>Anahtarı değiştir</button></p>}
    {message ? <p className="notice" role="status">{message}</p> : null}
    <details className="integration-help"><summary>API anahtarını nasıl hazırlayacağım?</summary><p className="small muted">Google Cloud projesinde YouTube Data API v3 etkin olmalı. API kısıtlamasını bu servisle sınırla; sunucudan yapılan çağrılara izin ver. Kanal ekleme sırasında erişim doğrulanır. Toplama API kotasına tabidir.</p></details>
    <Link className="text-link" href="/settings/meta#youtube-channels">YouTube kanalı eklemeye git</Link>
  </div>;
}
