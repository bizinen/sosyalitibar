"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function ReviewActions({ itemId, current, analysisRevision, expectedReviewId, disabled = false, shortcuts = false, onChanged, onConflict }: {
  itemId: string; current: string; analysisRevision: number; expectedReviewId?: string | null; disabled?: boolean;
  shortcuts?: boolean; onChanged?: () => Promise<void>; onConflict?: () => Promise<void>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function setStatus(reviewStatus: string) {
    if (busy || disabled) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/items/${itemId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus, expectedReviewStatus: current, analysisRevision, expectedReviewId }) });
      if (res.status === 409) {
        await onConflict?.();
        router.refresh();
        throw new Error("Yorum veya inceleme durumu değişti. Güncel kaydı inceleyip tekrar işlem yapın.");
      }
      if (!res.ok) throw new Error("Durum güncellenemedi");
      await onChanged?.();
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Durum güncellenemedi"); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!shortcuts) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.defaultPrevented
        || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input,textarea,select,button,a")))) return;
      const status = ({ r: "reviewed", i: "ignored", e: "escalated" } as Record<string, string>)[event.key.toLowerCase()];
      if (status && status !== current && !busy && !disabled) { event.preventDefault(); void setStatus(status); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  return <div className="btn-row review-actions" aria-busy={busy}>
    {error && <div className="notice" role="alert">{error}</div>}
    {current !== "new" && <button disabled={busy || disabled} className="btn" onClick={() => setStatus("new")}>Yeni olarak işaretle</button>}
    {current !== "reviewed" && <button disabled={busy || disabled} className="btn primary" onClick={() => setStatus("reviewed")}>{busy ? "Kaydediliyor…" : "İnceledim"}</button>}
    {current !== "escalated" && <button disabled={busy || disabled} className="btn" onClick={() => setStatus("escalated")}>Önceliklendir</button>}
    {current !== "ignored" && <button disabled={busy || disabled} className="btn quiet" onClick={() => setStatus("ignored")}>Dikkate alma</button>}
  </div>;
}
