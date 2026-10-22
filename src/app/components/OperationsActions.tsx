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
      if (kind === "sync") {
        const failures = Array.isArray(body.results) ? body.results.filter((x: { ok?: boolean }) => x.ok === false).length : 0;
        const processed = Array.isArray(body.results) ? body.results.length : 0;
        const limited = Array.isArray(body.results) ? body.results.filter((x: { coverageLimited?: boolean }) => x.coverageLimited).length : 0;
        const skipped = Array.isArray(body.results) ? body.results.filter((x: { skipped?: boolean }) => x.skipped).length : 0;
        setMessage((failures ? `${failures} kaynak eşitlenemedi. Kaynak hata bilgilerini kontrol edin; başarılı kaynakların analizleri kuyrukta.` : processed ? `${processed - skipped} kaynak için bu senkronizasyon grubu tamamlandı. Kalan kaynaklar worker tarafından sırayla işlenecek.` : "İşlenebilecek kaynak bulunamadı; bağlantılar durdurulmuş, yetkisi iptal edilmiş veya başka worker tarafından işleniyor olabilir.")
          + (limited ? ` ${limited} kaynakta tarama sınırına ulaşıldı; tüm geçmişin kapsandığı garanti edilmez.` : "")
          + (skipped ? ` ${skipped} kaynak işlem sırasında durduruldu veya yetkisi iptal edildi.` : ""));
      } else if (kind === "health") {
        const unhealthy = Array.isArray(body.results) ? body.results.filter((x: { status?: string }) => x.status === "degraded" || x.status === "revoked").length : 0;
        setMessage(unhealthy ? `${unhealthy} bağlantı müdahale gerektiriyor. Sağlık ve izin bilgilerini kontrol edin.` : "Bağlantı sağlık kontrolü tamamlandı.");
      } else {
        const failed = Number(body.failed?.webhooks || 0) + Number(body.failed?.analyses || 0) + Number(body.failed?.alerts || 0);
        const blocked = [body.analysisBlocked ? "LLM yapılandırması eksik; yorumlar analiz kuyruğunda korundu." : "",
          body.alertBlocked ? "Alarm teslimatı yapılandırılmamış; kritik kararlar outbox kuyruğunda korundu." : ""].filter(Boolean).join(" ");
        setMessage([blocked, failed ? `${failed} iş tamamlanamadı; retry/dead-letter durumunu operasyon ekranından takip edin.` : ""].filter(Boolean).join(" ") || "Webhook, analiz ve alarm kuyrukları işlendi.");
      }
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "İşlem başarısız"); }
    finally { setBusy(null); }
  }
  return <div>
    <details className="action-menu"><summary className="btn">{busy ? "İşlem sürüyor…" : "Manuel işlemler"}</summary><div className="action-menu-content">
      <button className="btn" disabled={Boolean(busy)} onClick={() => run("health")}>Bağlantıları kontrol et</button>
      <button className="btn" disabled={Boolean(busy)} onClick={() => run("sync")}>Yorumları al</button>
      <button className="btn" disabled={Boolean(busy)} onClick={() => run("queues")}>Bekleyen işleri işle</button>
    </div></details>
    {message ? <div className="action-feedback" role="status">{message}</div> : null}
  </div>;
}
