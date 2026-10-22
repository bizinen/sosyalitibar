"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function AlertSettingsForm({ enabled, endpoint, hasSecret, threshold, onThreat, revision }: {
  enabled: boolean; endpoint: string; hasSecret: boolean; threshold: number; onThreat: boolean; revision: number;
}) {
  const router = useRouter();
  const [active, setActive] = useState(enabled);
  const [url, setUrl] = useState(endpoint);
  const [secret, setSecret] = useState("");
  const [severity, setSeverity] = useState(threshold);
  const [threat, setThreat] = useState(onThreat);
  const [version, setVersion] = useState(revision);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/settings/alerts", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: active, webhookUrl: url, secret, severityThreshold: severity, onThreat: threat, revision: version }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error === "conflict" ? "Ayarlar başka bir ekranda değişti. Sayfayı yenileyin."
        : body.error === "delivery_in_progress" ? "Bir alarm şu anda gönderiliyor. Gönderim bittikten sonra kaydedin."
        : body.error === "https_endpoint_required" ? "HTTPS alıcı adresi kullanın; adrese kullanıcı bilgisi veya query parametresi eklemeyin."
        : body.error === "new_receiver_secret_required" ? "Yeni alıcının imza anahtarını da girin."
        : body.error === "connection_required" ? "Teslimatı açmak için alıcı adresi ve en az 32 karakterlik imza anahtarı gerekli."
        : "Ayarlar kaydedilemedi. Alanları kontrol edin.");
      setVersion(body.revision); setSecret(""); setVisible(false);
      setMessage("Ayarlar kaydedildi. Yeni analizler yeni kuralları kullanır. Teslimatı kapatmak bekleyen alarmları silmez; eski alıcıya bağlı alarmlar yeni alıcıya otomatik taşınmaz.");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Ayarlar kaydedilemedi."); }
    finally { setBusy(false); }
  }
  return <section className="panel" style={{marginBottom:24}}><div className="panel-head"><h2>Alarm bağlantısı ve kuralları</h2></div>
    <form className="panel-body form-grid" onSubmit={save} aria-busy={busy}><fieldset disabled={busy} className="llm-fields">
      <label><span><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Alarm teslimatını etkinleştir</span></label>
      <label><span className="small muted">Bildirim alıcı adresi</span><input className="input" type="url" required={active} maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://bildirim-alicisi/webhook" /></label>
      <label><span className="small muted">HMAC imza anahtarı {hasSecret ? "· mevcut anahtar kayıtlı" : "· en az 32 karakter"}</span><input className="input" type={visible ? "text" : "password"} autoComplete="new-password" maxLength={4096} value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={hasSecret ? "Boş bırakırsan mevcut anahtar korunur" : "Alıcıyla paylaşacağın imza anahtarı"} /></label>
      <div className="btn-row"><button type="button" className="btn" onClick={() => { const bytes = crypto.getRandomValues(new Uint8Array(32)); setSecret(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")); setVisible(true); }}>Güçlü anahtar oluştur</button><label className="small"><input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} /> Girdiğim anahtarı göster</label></div>
      <label><span className="small muted">Eski ayrıntılı analiz için puan eşiği · 0–100</span><input className="input" type="number" required min={0} max={100} step={1} value={severity} onChange={(event) => setSeverity(Number(event.target.value))} /></label>
      <label><span><input type="checkbox" checked={threat} onChange={(event) => setThreat(event.target.checked)} /> Eski ayrıntılı analizde tehdit için eşikten bağımsız alarm oluştur</span></label>
      <p className="small muted">Yeni toplu analizde acil_inceleme etiketi alarm oluşturur; puan eşiği kullanılmaz. Yukarıdaki puan ve tehdit kuralları yalnız eski ayrıntılı analiz işlevine aittir ve kişi/kurum eşleşmesi gerektirir. Alıcı aynı anahtarla HMAC imzasını kontrol etmeli ve Idempotency-Key ile mükerrer teslimatı ayıklamalı. Anahtarı kaydetmeden önce alıcıya aktar. Bu form bağlantıyı denemez.</p>
      {error ? <div className="notice" role="alert">{error}</div> : null}{message ? <p className="small" role="status">{message}</p> : null}
      <button className="btn primary" type="submit">{busy ? "Kaydediliyor…" : "Alarm ayarlarını kaydet"}</button>
    </fieldset></form>
  </section>;
}
