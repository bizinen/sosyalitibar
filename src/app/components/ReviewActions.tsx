"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ReviewActions({ itemId, current }: { itemId: string; current: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function setStatus(reviewStatus: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/items/${itemId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus }) });
      if (!res.ok) throw new Error("Durum güncellenemedi");
      router.refresh();
    } finally { setBusy(false); }
  }
  return <div className="btn-row">
    {current !== "reviewed" && <button disabled={busy} className="btn" onClick={() => setStatus("reviewed")}>İncelendi</button>}
    {current !== "escalated" && <button disabled={busy} className="btn danger" onClick={() => setStatus("escalated")}>Yükselt</button>}
    {current !== "ignored" && <button disabled={busy} className="btn" onClick={() => setStatus("ignored")}>Yok say</button>}
  </div>;
}
