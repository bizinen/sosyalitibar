"use client";

import { triageLabels, triageLabelSchema } from "@/lib/triage-contract";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { itemReviewEvents, socialAnalyses, socialItems } from "@/db/schema";
import type { HumanAssessment } from "@/lib/review-contract";
import { ReviewActions } from "@/app/components/ReviewActions";

type Event = Omit<typeof itemReviewEvents.$inferSelect, "createdAt"> & { createdAt: string };
type Data = { analysisRevision: number; reviewStatus: string; latest: Event | null; events: Event[]; nextCursor: string | null;
  alerts: Array<{ id: string; status: string; lastError: string | null; deliveredAt: string | null; availableAt: string }>;
  translation: { text: string; model: string } | null; targets: Array<{ name: string }>;
  legacy: Array<{ id: string; createdAt: string; metadata: Record<string, unknown> | null }>;
};
const categories: Record<string, string> = { criticism: "Eleştiri", insult: "Hakaret", accusation: "İddia", threat: "Tehdit", mockery: "Alay", spam: "Spam", support: "Destek", other: "Diğer" };
const statuses: Record<string, string> = { new: "Yeni", reviewed: "İncelendi", ignored: "Dikkate alınmadı", escalated: "Önceliklendirildi" };
const verdicts = { attack: "İtibar saldırısı", criticism: "Eleştiri / saldırı değil", uncertain: "Belirsiz" };

function CorrectionForm({ assessment, analysis, targets, disabled, save }: {
  assessment: HumanAssessment | null; analysis: typeof socialAnalyses.$inferSelect | null;
  targets: Array<{ name: string }>; disabled: boolean; save: (assessment: HumanAssessment) => Promise<void>;
}) {
  const [verdict, setVerdict] = useState<HumanAssessment["verdict"]>(assessment?.verdict ?? "uncertain");
  const [category, setCategory] = useState(assessment?.category ?? analysis?.category ?? "other");
  const [severity, setSeverity] = useState(assessment?.severity ?? analysis?.severity ?? 0);
  const initialTarget = assessment ? assessment.matchedTarget : analysis?.matchedTarget;
  const [target, setTarget] = useState(targets.some((entry) => entry.name === initialTarget) ? initialTarget ?? "" : "");
  const [reason, setReason] = useState(assessment?.reason ?? "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    await save({ verdict, category: category as HumanAssessment["category"], severity, targetMatch: Boolean(target), matchedTarget: target || null, reason });
  }
  return <form onSubmit={submit}><fieldset className="human-fields" disabled={disabled}>
    <label>İnsan değerlendirmesi<select className="select" value={verdict} onChange={(event) => setVerdict(event.target.value as HumanAssessment["verdict"])}>{Object.entries(verdicts).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>Kategori<select className="select" value={category} onChange={(event) => setCategory(event.target.value)}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>Öncelik puanı<input className="input" type="number" min={0} max={100} required value={severity} onChange={(event) => setSeverity(Number(event.target.value))} /></label>
    <label>Yöneldiği kişi / kurum<select className="select" required={verdict === "attack"} value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Eşleşme yok / belirsiz</option>{targets.map((entry) => <option key={entry.name}>{entry.name}</option>)}</select></label>
    <label className="human-reason">Düzeltme gerekçesi<textarea className="input" rows={3} required minLength={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Örneğin: Üst yorumdaki ifadeyi alıntılıyor; tehdit yorum yazarına ait değil." /></label>
    <button className="btn primary" type="submit">İnsan değerlendirmesini kaydet</button>
  </fieldset></form>;
}

export function CommentReviewPanel({ item, analysis, onReviewed }: {
  item: typeof socialItems.$inferSelect; analysis: typeof socialAnalyses.$inferSelect | null; onReviewed: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"overview" | "history" | "alerts">("overview");
  const activeRequest = useRef<AbortController | null>(null);
  const translationRequest = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  async function load(before?: string) {
    if (!mounted.current) return;
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    setLoading(true);
    try {
      const response = await fetch(`/api/items/${item.id}/review${before ? `?before=${encodeURIComponent(before)}` : ""}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("İnceleme geçmişi alınamadı. Yeniden deneyin.");
      const result: Data = await response.json();
      if (controller.signal.aborted) return;
      if (result.analysisRevision !== item.analysisRevision) { setData(null); setError("Yorum değişti. Güncel yorumu yükleyin."); router.refresh(); return; }
      setData((previous) => before && previous ? { ...result, events: [...previous.events, ...result.events] } : result);
    } catch (failure) {
      if (timedOut && activeRequest.current === controller) setError("İnceleme isteği zaman aşımına uğradı. Yeniden deneyin.");
      else if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "İnceleme alınamadı.");
    }
    finally { clearTimeout(timeout); if (activeRequest.current === controller && (!controller.signal.aborted || timedOut)) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); mounted.current = false; activeRequest.current?.abort(); translationRequest.current?.abort(); };
    // The parent remounts this panel when the item or revision changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.analysisRevision]);
  const stale = !data || data.analysisRevision !== item.analysisRevision || Boolean(item.deletedAt || item.sourceUnavailableAt);
  async function write(extra: { assessment?: HumanAssessment; undoEventId?: string }) {
    if (!data || busy || loading || stale) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/items/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewStatus: extra.assessment ? "reviewed" : data.reviewStatus, expectedReviewStatus: data.reviewStatus,
          analysisRevision: item.analysisRevision, expectedReviewId: data.latest?.id ?? null, ...extra }),
      });
      if (!response.ok) { if (response.status === 409) { await load(); router.refresh(); } throw new Error(response.status === 409 ? "Yorum veya inceleme değişti; güncel kaydı tekrar inceleyin." : "İnsan değerlendirmesi kaydedilemedi."); }
      if (!mounted.current) return;
      await load(); router.refresh();
      if (!mounted.current) return;
      setMessage(extra.undoEventId ? "Son inceleme işlemi geri alındı. Geçmiş kaydı korundu." : "İnsan değerlendirmesi ayrı kaydedildi. LLM sonucu korundu.");
      if (extra.assessment) onReviewed();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "İşlem tamamlanamadı."); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function translate() {
    if (translating || stale) return;
    const controller = new AbortController(); translationRequest.current = controller;
    setTranslating(true); setError("");
    try {
      const response = await fetch(`/api/items/${item.id}/translate`, { method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ analysisRevision: item.analysisRevision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error === "translation_in_progress" ? "Çeviri başka bir istekte hazırlanıyor. Biraz sonra incelemeyi yenileyin."
        : result.error === "translation_text_limit" ? "Çeviri 60.000 karaktere kadar destekleniyor; metin kısaltılarak gönderilmedi."
        : result.error === "llm_not_configured" ? "Çeviri için önce AI ayarlarını tamamlayın." : "Çeviri tamamlanamadı. Özgün metin korundu; tekrar deneyin.");
      if (!controller.signal.aborted) setData((previous) => previous ? { ...previous, translation: result } : previous);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Çeviri başarısız."); }
    finally { if (!controller.signal.aborted) setTranslating(false); }
  }
  const human = data?.latest?.analysisRevision === item.analysisRevision ? data.latest.assessment : null;
  return <div className="review-detail-tools">
    {error ? <div className="notice" role="alert">{error} <button className="btn quiet" disabled={loading} onClick={() => { setError(""); void load(); }}>İncelemeyi yenile</button></div> : null}
    {message ? <p className="small" role="status">{message}</p> : null}
    <section className="review-tool-section review-decision-actions" aria-label="İnceleme işlemleri"><div className="review-section-head"><h3 title="R: inceledim · E: önceliklendir · I: dikkate alma">İnceleme kararı</h3>{data ? <span className="badge">{statuses[data.reviewStatus] ?? data.reviewStatus}</span> : null}</div>
      <ReviewActions itemId={item.id} current={data?.reviewStatus ?? item.reviewStatus} analysisRevision={item.analysisRevision}
        expectedReviewId={data?.latest?.id ?? null} disabled={loading || busy || stale} onConflict={async () => { await load(); }} onChanged={async () => { await load(); if (mounted.current) onReviewed(); }} />
      {data?.latest && data.latest.analysisRevision === item.analysisRevision && data.latest.action !== "undo"
        ? <button className="btn quiet undo-review" disabled={loading || busy || stale} onClick={() => write({ undoEventId: data.latest!.id })}>Son inceleme işlemini geri al</button> : null}
    </section>
    <div className="review-detail-tabs" role="tablist" aria-label="İnceleme ayrıntıları">
      {([ ["overview", "Değerlendirme"], ["history", "İnceleme geçmişi"], ["alerts", "Alarmlar"] ] as const).map(([value, label], index, entries) => <button key={value} type="button" role="tab"
        id={`review-${item.id}-tab-${value}`} aria-controls={`review-${item.id}-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
        onClick={() => setTab(value)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? (index + 1) % entries.length : event.key === "ArrowLeft" ? (index + entries.length - 1) % entries.length : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); setTab(entries[next]![0]);
          (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
        }}>{label}{value === "alerts" && data?.alerts.length ? <span>{data.alerts.length}</span> : null}</button>)}
    </div>
    <div role="tabpanel" id={`review-${item.id}-overview`} aria-labelledby={`review-${item.id}-tab-overview`} hidden={tab !== "overview"} tabIndex={0}>
    <details className="review-tool-section review-translation"><summary>Türkçe çeviri{data?.translation ? <span className="badge">Hazır</span> : null}</summary><div className="review-section-head"><p className="small muted">Özgün yorum korunur.</p><button className="btn" disabled={translating || stale || Boolean(data?.translation)} onClick={translate}>{translating ? "Çevriliyor…" : data?.translation ? "Çeviri hazır" : "Türkçeye çevir"}</button></div>
      {data?.translation ? <><p className="comment-text" dir="auto">{data.translation.text}</p><p className="small muted">AI çevirisi · {data.translation.model}. Karar verirken özgün metni esas alın; çeviri analiz sonucunu değiştirmez.</p></> : <p className="small muted">Çeviri yalnız istendiğinde AI sağlayıcısı ile üretilir. Özgün yorum ayrı korunur.</p>}
    </details>
    <section className="review-tool-section"><h3>İnsan değerlendirmesi</h3>
      {human ? <div className="human-verdict"><strong>{verdicts[human.verdict]}</strong><span>{categories[human.category]} · {human.severity}/100 · {human.matchedTarget ?? "Hedef eşleşmesi yok"}</span><p>{human.reason}</p></div> : <p className="small muted">Bu revizyon için ayrı insan değerlendirmesi henüz yok.</p>}
      <details className="correction-disclosure"><summary>{human ? "Değerlendirmeyi düzenle" : "İnsan değerlendirmesi ekle / AI kararını düzelt"}</summary>
        <p className="small muted">LLM sonucu üzerine yazılmaz. Bu kayıt otomatik model eğitimi, yeniden analiz veya alarm iptali başlatmaz.</p>
        {data ? <CorrectionForm key={data.latest?.id ?? "initial"} assessment={human} analysis={analysis} targets={data.targets} disabled={busy || loading || stale} save={async (assessment) => write({ assessment })} /> : <p role="status">İnceleme yükleniyor…</p>}
      </details>
    </section>
    </div>
    <section className="review-tool-section" role="tabpanel" id={`review-${item.id}-alerts`} aria-labelledby={`review-${item.id}-tab-alerts`} hidden={tab !== "alerts"} tabIndex={0}><h3>Alarm durumu</h3>{data?.alerts.length ? data.alerts.map((alert) => <div className="review-alert" key={alert.id}><strong>{({ pending: "Teslimat bekliyor", processing: "Gönderiliyor", retry: "Yeniden denenecek", delivered: "Teslim edildi", dead: "Teslim edilemedi", cancelled: "İptal edildi" } as Record<string, string>)[alert.status] ?? alert.status}</strong>
      {alert.deliveredAt ? <time>{new Date(alert.deliveredAt).toLocaleString("tr-TR")}</time> : alert.status === "retry" ? <time>Sonraki deneme: {new Date(alert.availableAt).toLocaleString("tr-TR")}</time> : null}{alert.lastError ? <p className="small muted">{alert.lastError}</p> : null}</div>) : <p className="small muted">Bu yorum revizyonu için alarm kaydı yok. Bu durum yorumun güvenli olduğuna dair karar değildir.</p>}</section>
    <section className="review-tool-section" role="tabpanel" id={`review-${item.id}-history`} aria-labelledby={`review-${item.id}-tab-history`} hidden={tab !== "history"} tabIndex={0}><h3>İnceleme geçmişi</h3>{loading ? <p className="small" role="status">Geçmiş yükleniyor…</p> : null}
      {data?.events.map((event) => <details className="review-history-event" key={event.id}><summary><span>{event.action === "correction" ? "İnsan sınıflandırması" : event.action === "undo" ? "İşlem geri alındı" : statuses[event.reviewStatus]}</span><time>{new Date(event.createdAt).toLocaleString("tr-TR")}</time></summary>
        <p className="small muted">{event.actor} · Revizyon {event.analysisRevision}{event.analysisRevision !== item.analysisRevision ? " · Önceki yorum / analiz bağlamı; güncel karar değil" : ""} · {statuses[event.previousStatus]} → {statuses[event.reviewStatus]}</p>
        {event.assessment ? <p>{verdicts[event.assessment.verdict]} · {categories[event.assessment.category]} · {event.assessment.severity}/100<br />{event.assessment.reason}</p> : null}
        <details><summary>İnceleme anındaki yorum ve LLM kararı</summary><p className="comment-text" dir="auto">{event.sourceText}</p><p className="small muted">{event.llmSnapshot ? triageLabelSchema.safeParse(event.llmSnapshot.triageLabel).success ? triageLabels[triageLabelSchema.parse(event.llmSnapshot.triageLabel)] : `${String(event.llmSnapshot.category)} · ${String(event.llmSnapshot.severity)}/100 · ${String(event.llmSnapshot.summary)}` : "O anda LLM sonucu yoktu."}</p></details>
      </details>)}
      {data && !data.events.length && !data.legacy.length ? <p className="small muted">Henüz inceleme işlemi yapılmadı.</p> : null}
      {data?.nextCursor ? <button className="btn" disabled={loading} onClick={() => load(data.nextCursor!)}>Daha eski incelemeleri yükle</button> : null}
      {data?.legacy.length ? <details><summary>Önceki sistemdeki inceleme kayıtları</summary>{data.legacy.map((entry) => <p className="small" key={entry.id}>{new Date(entry.createdAt).toLocaleString("tr-TR")} · {statuses[String(entry.metadata?.reviewStatus)] ?? "Durum değişikliği"} · Sınıflandırma / yorum görüntüsü o dönemde saklanmıyordu.</p>)}</details> : null}
    </section>
  </div>;
}
