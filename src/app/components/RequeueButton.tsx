"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RequeueButton({ kind, id }: { kind: "webhook" | "analysis"; id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/admin/dead-letter/${kind}/${id}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Yeniden kuyruğa alınamadı");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "İşlem başarısız");
    } finally { setBusy(false); }
  }
  return <div><button className="btn" onClick={run} disabled={busy}>{busy ? "Alınıyor…" : "Tekrar kuyruğa al"}</button>{error ? <div className="small" style={{color:"var(--danger)",marginTop:5}}>{error}</div> : null}</div>;
}
