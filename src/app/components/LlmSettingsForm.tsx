"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LLM_PROVIDERS, llmProviderId, validLlmModelId, type LlmProviderId, type LlmProviderProfile } from "@/lib/llm-providers";

export function LlmSettingsForm({ baseUrl, model, hasKey, revision, profiles }: { baseUrl: string; model: string; hasKey: boolean; revision: number; profiles: LlmProviderProfile[] }) {
  const router = useRouter();
  const [provider, setProvider] = useState<LlmProviderId>(llmProviderId(baseUrl));
  const [customUrl, setCustomUrl] = useState(baseUrl);
  const [savedProfiles, setProfiles] = useState(profiles);
  const selectedProvider = LLM_PROVIDERS.find((entry) => entry.id === provider);
  const selectedUrl = selectedProvider?.baseUrl ?? customUrl;
  const keyAvailable = (provider !== "custom" && savedProfiles.some((entry) => entry.provider === provider && entry.hasKey))
    || (selectedUrl.replace(/\/+$/, "") === baseUrl.replace(/\/+$/, "") && hasKey);
  const [selectedModel, setModel] = useState(model);
  const [key, setKey] = useState("");
  const [version, setVersion] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  function selectProvider(next: LlmProviderId) {
    setProvider(next); setKey(""); setError(""); setMessage("");
    if (next === "custom" && llmProviderId(baseUrl) !== "custom") setCustomUrl("");
    setModel(savedProfiles.find((entry) => entry.provider === next)?.model ?? (next === llmProviderId(baseUrl) ? model : ""));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(""); setError("");
    if (!validLlmModelId(selectedUrl, selectedModel.trim())) {
      setError("Runware için AIR model kimliği gir; örneğin openai:gpt@5.4-nano. Yalnız sayı geçerli bir model kimliği değildir."); return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/settings/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, baseUrl: selectedUrl, model: selectedModel, apiKey: key, revision: version }) });
      const body = await response.json();
      if (!response.ok && body.error === "invalid_model") throw new Error("Runware AIR model kimliği geçersiz; sağlayıcının model kimliğini kontrol et.");
      if (!response.ok) throw new Error(body.error === "conflict" ? "Ayarlar başka bir ekranda değişti. Sayfayı yenileyip tekrar düzenle." : body.error === "provider_key_required" ? "Sağlayıcı adresi değiştiğinde yeni sağlayıcının API anahtarını gir." : body.error === "api_key_required" ? "API anahtarı gerekli." : body.error === "invalid_provider_url" ? "HTTPS sağlayıcı adresi veya HTTP yerel sunucu adresi kullan. Adrese anahtar veya query parametresi ekleme." : "Ayarlar kaydedilemedi. Alanları kontrol edip tekrar dene.");
      setVersion(body.revision); setKey(""); setProfiles((previous) => [...previous.filter((entry) => entry.provider !== provider), { provider, model: selectedModel.trim(), hasKey: true }]); setMessage("Sağlayıcı kaydedildi ve etkinleştirildi. Sonraki analiz ve çeviriler bu modeli kullanır. Geçmiş sonuçlar değişmez."); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Ayarlar kaydedilemedi."); }
    finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-head"><h2>Model bağlantısı</h2><span className="badge">{selectedProvider?.name ?? "Özel sağlayıcı"}</span></div><form className="panel-body form-grid" onSubmit={save} aria-busy={busy}><fieldset disabled={busy} className="llm-fields">
    <label><span className="small muted">Sağlayıcı</span><select className="input" value={provider} onChange={(e) => selectProvider(e.target.value as LlmProviderId)}>{LLM_PROVIDERS.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{savedProfiles.some((profile) => profile.provider === entry.id) ? " · kayıtlı" : ""}</option>)}<option value="custom">Özel / OpenAI uyumlu</option></select></label>
    <label><span className="small muted">Model kimliği · serbest giriş</span><input className="input" required maxLength={200} value={selectedModel} onChange={(e) => setModel(e.target.value)} placeholder={selectedProvider?.modelHint ?? "Sağlayıcının model kimliği"} autoComplete="off" spellCheck={false} /></label>
    <label><span className="small muted">API anahtarı {keyAvailable ? "· bu sağlayıcı için kayıtlı" : "· gerekli"}</span><input className="input" type="password" autoComplete="new-password" required={!keyAvailable} maxLength={4096} value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyAvailable ? "Boş bırakırsan kayıtlı anahtar korunur" : "Seçili sağlayıcının API anahtarı"} /></label>
    <label><span className="small muted">API adresi</span><input className="input" type="url" required readOnly={provider !== "custom"} maxLength={500} value={selectedUrl} onChange={(e) => { setCustomUrl(e.target.value); setKey(""); }} placeholder="https://sağlayıcı-adresi/v1" /></label>
    {error ? <div className="notice" role="alert">{error}</div> : null}{message ? <p className="small" role="status">{message}</p> : null}
    <button className="btn primary" type="submit">{busy ? "Kaydediliyor…" : "Kaydet ve etkinleştir"}</button>
  </fieldset></form></section>;
}
