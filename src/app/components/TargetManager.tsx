"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Target = { id: string; name: string; aliases: string[]; notes: string | null; enabled: boolean };

export function TargetManager({ targets }: { targets: Target[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/targets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, aliases: aliases.split(",").map((x) => x.trim()).filter(Boolean), notes: notes || null }) });
      if (!res.ok) throw new Error("Hedef eklenemedi; aynı isim zaten bulunuyor olabilir.");
      setName(""); setAliases(""); setNotes(""); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Hata"); }
    finally { setBusy(false); }
  }
  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/targets/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("Hedef güncellenemedi");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Hata"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("Bu hedef silinsin mi? Mevcut analiz kayıtları silinmez.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/targets/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Hedef silinemedi");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Hata"); }
    finally { setBusy(false); }
  }

  return <div className="two-col">
    <section className="panel">
      <div className="panel-head"><h2>Yeni hedef</h2></div>
      <div className="panel-body form-grid">
        <label><div className="small muted">Kanonik ad</div><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ahmet Yılmaz" /></label>
        <label><div className="small muted">Alias / yanlış yazımlar (virgülle)</div><input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Ahmet Hoca, @ahmetyilmaz" /></label>
        <label><div className="small muted">Not</div><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></label>
        {error ? <div className="notice">{error}</div> : null}
        <button className="btn primary" disabled={busy || name.trim().length < 2} onClick={create}>Hedef ekle</button>
      </div>
    </section>
    <section className="panel">
      <div className="panel-head"><h2>İzlenen hedefler</h2><span className="badge">{targets.length}</span></div>
      {targets.length === 0 ? <div className="empty">Henüz hedef yok.</div> : <div className="table-wrap"><table><thead><tr><th>Hedef</th><th>Alias</th><th>Durum</th><th></th></tr></thead><tbody>
        {targets.map((t) => <tr key={t.id}><td><strong>{t.name}</strong>{t.notes ? <div className="small muted">{t.notes}</div> : null}</td><td>{t.aliases.join(", ") || "—"}</td><td><button className={`badge ${t.enabled ? "ok" : ""}`} disabled={busy} onClick={() => patch(t.id,{enabled:!t.enabled})}>{t.enabled ? "Aktif" : "Pasif"}</button></td><td><button className="btn danger" disabled={busy} onClick={() => remove(t.id)}>Sil</button></td></tr>)}
      </tbody></table></div>}
    </section>
  </div>;
}
