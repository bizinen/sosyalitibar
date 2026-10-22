import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { llmConfigured } from "@/lib/config";
import { getLlmSettings, getLlmProviderProfiles } from "@/lib/llm-settings";
import { LlmSettingsForm } from "@/app/components/LlmSettingsForm";
import { AdminNav } from "@/app/components/AdminNav";
import { AiPolicyForm } from "@/app/components/AiPolicyForm";
import { ANALYSIS_SYSTEM_PROMPT } from "@/lib/llm";

export default async function LlmSettingsPage() {
  if (!(await isAdmin())) redirect("/login");
  const cfg = await getLlmSettings();
  const profiles = await getLlmProviderProfiles();
  const configured = llmConfigured(cfg);
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>AI ayarları</h1><p className="muted" style={{ margin: "8px 0 0" }}>Sağlayıcıyı, modeli, analiz talimatlarını ve bağlamı yönet.</p></div><span className={`badge ${configured ? "blue" : "warn"}`}>{configured ? "Bağlantı ayarları kayıtlı" : "Kurulum gerekli"}</span></div>
    <div style={{marginBottom:22}}><LlmSettingsForm key={cfg.settingsRevision} baseUrl={cfg.LLM_BASE_URL} model={cfg.LLM_MODEL === "local-not-configured" ? "" : cfg.LLM_MODEL} hasKey={cfg.LLM_API_KEY !== "local-not-configured"} revision={cfg.settingsRevision} profiles={profiles} /></div>
    {!configured ? <div className="notice" role="alert">Model ve API anahtarı henüz ayarlanmadı. Alınan yorumlar analiz için bekler; sonuç üretilmiş gibi gösterilmez.</div> : null}
    <AiPolicyForm policy={cfg.policy} revision={cfg.policyRevision} legacyDefault={ANALYSIS_SYSTEM_PROMPT} />
    <details className="settings-disclosure"><summary>Çalışma ve bağlantı ayrıntıları</summary><dl><div><dt>İstek süresi sınırı</dt><dd>{cfg.LLM_TIMEOUT_MS / 1000} saniye</dd></div><div><dt>Toplu çıktı düzeltme</dt><dd>Eksik/geçersiz sonuç için bir ek tur; devam eden hata kuyrukta en fazla 5 deneme</dd></div><div><dt>Grup büyüklüğü</dt><dd>En fazla {cfg.policy.batchSize} yorum</dd></div><div><dt>Çeviri / eski analiz yedek modeli</dt><dd>{cfg.LLM_FALLBACK_MODEL || "Yapılandırılmadı"}</dd></div></dl><p className="small muted">Toplu etiketleme seçili modeli kullanır. Aynı paylaşımın bağlamı grupta bir kez gönderilir. Ağ hataları kuyrukta gecikmeli denenir; yorum veya kaynak bağlamı güncellenmedikçe tamamlanmış analiz tekrar çalışmaz. Süre sınırı ve çevirinin yedek modeli sunucu yapılandırmasından yönetilir.</p></details>
  </main></div>;
}
