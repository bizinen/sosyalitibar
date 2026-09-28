"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AlertRequeueButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function requeue() {
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts/${id}/requeue`, { method: "POST" });
      if (!res.ok) throw new Error("Alarm yeniden kuyruğa alınamadı");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  return <button className="btn" disabled={busy} onClick={requeue}>{busy ? "Alınıyor…" : "Tekrar dene"}</button>;
}
