"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function OperationsActions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function run(kind: "health" | "sync" | "queues") {
    setBusy(kind); setMessage("");
    const url = kind === "health" ? "/api/meta/health" : kind === "sync" ? "/api/meta/sync-comments" : "/api/admin/run-queues";
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "İşlem başarısız");
      setMessage(kind === "health" ? "Bağlantı sağlık kontrolü tamamlandı." : kind === "sync" ? "Reconciliation senkronu tamamlandı; analiz kuyruğu arka planda işlenecek." : "Webhook ve analiz kuyrukları işlendi.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "İşlem başarısız"); }
    finally { setBusy(null); }
  }
  return <div>
    <div className="btn-row">
      <a className="btn primary" href="/api/meta/connect">Meta hesabı bağla</a>
      <button className="btn" disabled={Boolean(busy)} onClick={() => run("health")}>Tokenları kontrol et</button>
      <button className="btn" disabled={Boolean(busy)} onClick={() => run("sync")}>Yorumları eşitle</button>
      <button className="btn" disabled={Boolean(busy)} onClick={() => run("queues")}>Kuyrukları şimdi işle</button>
    </div>
    {message ? <div className="small muted" style={{marginTop:8}}>{message}</div> : null}
  </div>;
}
