"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { aiPolicySchema, defaultAiPolicy, type AiPolicy } from "@/lib/triage-contract";

export function AiPolicyForm({ policy, revision, legacyDefault }: { policy: AiPolicy; revision: number; legacyDefault: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState(policy);
  const [currentRevision, setRevision] = useState(revision);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const update = <K extends keyof AiPolicy>(key: K, value: AiPolicy[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = aiPolicySchema.safeParse(draft);
    if (!parsed.success) { setFailed(true); setMessage("Alan uzunluklarını ve toplu analiz sınırlarını kontrol et."); return; }
    setSaving(true); setMessage(""); setFailed(false);
    try {
      const response = await fetch("/api/settings/ai-policy", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: parsed.data, revision: currentRevision }) });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? "Ayarlar başka bir oturumda değişti. Yazdıklarını kopyalayıp sayfayı yenile; güncel ayarları görmeden üzerine kaydetmiyoruz." : "Ayarlar kaydedilemedi. Oturumunu ve bağlantını kontrol et.");
      setRevision(body.revision); setDraft(parsed.data);
      setMessage("Kaydedildi. Yeni analiz grupları bu talimatları kullanacak. Geçmiş yorumlar yeniden analize gönderilmedi.");
      router.refresh();
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Kaydedilemedi."); }
    finally { setSaving(false); }
  }
  const textField = (key: "triagePrompt" | "targetContext" | "sourceContext" | "translationPrompt" | "legacyPrompt", title: string, description: string, max: number, rows = 5) =>
    <label style={{ display: "grid", gap: 8 }}><strong>{title}</strong><span className="small muted">{description}</span>
      <textarea className="textarea" value={draft[key]} maxLength={max} rows={rows} onChange={(event) => update(key, event.target.value)} style={{ width: "100%", resize: "vertical" }} />
    </label>;
  return <form className="panel" onSubmit={save} style={{ padding: 24, marginBottom: 22 }}>
    <div className="page-head"><div><h2>Analiz talimatları ve bağlam</h2><p className="small muted">Sürüm {currentRevision} · Yorum başına yalnızca inceleme etiketi üretilir.</p></div></div>
    <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 22 }}>
      {textField("targetContext", "Kimi izliyoruz?", "Hocamızın adı, kullanılan hitaplar, lakaplar ve ayırt edici bilgiler. Aynı isimli başka kişiler varsa farklarını belirt.", 16000)}
      {textField("sourceContext", "Paylaşımların ortak bağlamı", "Kendi hesapların ve konuk olunan kanallar için yorumlama bağlamı. Her yorumun mevcut paylaşım ve üst yorum metni ayrıca eklenir.", 8000, 4)}
      {textField("triagePrompt", "Etiketleme talimatı", "Hangi yorumun olağan, insan incelemesi gerektiren veya acil olduğunu tanımla. Gerçek yorumlardan kısa sınır örnekleri ekleyebilirsin.", 16000, 10)}
      <div><button className="btn quiet" type="button" onClick={() => update("triagePrompt", defaultAiPolicy.triagePrompt)}>Varsayılan etiketleme talimatını getir</button></div>
      <details className="settings-disclosure"><summary>Toplu analiz ve maliyet sınırları</summary>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, paddingTop: 16 }}>
          <label>Gruptaki en fazla yorum<input className="input" type="number" min={1} max={50} required value={draft.batchSize} onChange={(e) => update("batchSize", Number(e.target.value))} /></label>
          <label>Grubu hazırlama beklemesi (ms)<input className="input" type="number" min={0} max={5000} required value={draft.batchWaitMs} onChange={(e) => update("batchWaitMs", Number(e.target.value))} /></label>
          <label>Gruptaki veri sınırı (karakter)<input className="input" type="number" min={4000} max={60000} required value={draft.batchMaxChars} onChange={(e) => update("batchMaxChars", Number(e.target.value))} /></label>
        </div>
        <p className="small muted">Sınır aşılınca grup bölünür. Tek başına sığmayan yorum, metni kesilmeden insan incelemesine ayrılır. Karakter sınırı token veya para limiti değildir; sabit talimatlar ayrıca gönderilir. Bekleme süresi kaynak tarama ve model yanıt süresini içermez. Toplu etiketlemede yedek modele otomatik geçilmez.</p>
      </details>
      <details className="settings-disclosure"><summary>Çeviri talimatı</summary><div style={{ paddingTop: 16 }}>
        {textField("translationPrompt", "Türkçe çeviri", "Çeviri yalnız istendiğinde çalışır. Talimat değişince eski çeviri yeni istek için kullanılmaz.", 8000)}
        <button className="btn quiet" type="button" onClick={() => update("translationPrompt", defaultAiPolicy.translationPrompt)}>Varsayılan çeviri talimatını getir</button>
      </div></details>
      <details className="settings-disclosure"><summary>Eski ayrıntılı analiz talimatı</summary><div style={{ paddingTop: 16 }}>
        <p className="small muted">Yeni yorum akışı bu talimatı kullanmaz; toplu etiketleme talimatını kullanır. Ayrıntılı analiz işlevinin talimatı burada korunur. Boş bırakılırsa aşağıdaki varsayılan kullanılır.</p>
        {textField("legacyPrompt", "Ayrıntılı analiz talimatı", "Eski kategori ve puan sözleşmesi korunur.", 24000, 8)}
        <button className="btn quiet" type="button" onClick={() => update("legacyPrompt", legacyDefault)}>Varsayılan ayrıntılı talimatı getir</button>
        <details><summary>Varsayılanı görüntüle</summary><pre style={{ whiteSpace: "pre-wrap" }}>{legacyDefault}</pre></details>
      </div></details>
      <p className="small muted">JSON alanları, izin verilen üç etiket ve yorum içindeki talimatların uygulanmaması sistem sözleşmesidir. Bu korumalar prompt düzenlenerek kapatılmaz. İnsan değerlendirmesi AI sonucundan ayrı saklanır.</p>
      <div><button className="btn primary" type="submit">{saving ? "Kaydediliyor…" : "Talimatları ve bağlamı kaydet"}</button></div>
    </fieldset>
    {message ? <p className={failed ? "notice" : "small"} role={failed ? "alert" : "status"}>{message}</p> : null}
  </form>;
}
