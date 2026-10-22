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
  const [editingId, setEditingId] = useState<string | null>(null);

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
      if (id === editingId) { setEditingId(null); setName(""); setAliases(""); setNotes(""); }
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Hata"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("Bu hedef silinsin mi? Geçmiş korunur; mevcut kararlar geçersiz kılınarak yorumlar yeniden analiz edilir.")) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/targets/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Hedef silinemedi");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Hata"); }
    finally { setBusy(false); }
  }

  return <div className="two-col">
    <section className="panel">
      <div className="panel-head"><h2>{editingId ? "Kişi veya kurumu düzenle" : "Kişi veya kurum ekle"}</h2></div>
      <div className="panel-body form-grid">
        <label><div className="small muted">Kişinin veya kurumun adı</div><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ahmet Yılmaz" /></label>
        <label><div className="small muted">Diğer adları ve kullanıcı adları (virgülle ayır)</div><input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Ahmet Hoca, @ahmetyilmaz" /></label>
        <label><div className="small muted">AI için bağlam notu</div><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Kişinin rolü, kurumla ilişkisi veya yorumlarda önemli olabilecek bağlam…" rows={3} /></label>
        {error ? <div className="notice" role="alert">{error}</div> : null}
        <button className="btn primary" disabled={busy || name.trim().length < 2} onClick={() => editingId ? patch(editingId, { name, aliases: aliases.split(",").map((x) => x.trim()).filter(Boolean), notes: notes || null }) : create()}>{busy ? "Kaydediliyor…" : editingId ? "Değişiklikleri kaydet" : "Ekle"}</button>
        {editingId && <button className="btn" disabled={busy} onClick={() => { setEditingId(null); setName(""); setAliases(""); setNotes(""); setError(""); }}>Vazgeç</button>}
      </div>
    </section>
    <section className="panel">
      <div className="panel-head"><h2>Kişiler ve kurumlar</h2><span className="badge">{targets.length}</span></div>
      {targets.length === 0 ? <div className="empty"><h2>Hesaplarının sahibini tanımla.</h2><p>Bir kişi veya kurum ekledikten sonra Hesaplarım ekranından ilgili hesaplarla eşleştirebilirsin.</p></div> : <div className="table-wrap"><table><thead><tr><th>Adı</th><th>Diğer adları</th><th>İzleme</th><th>İşlemler</th></tr></thead><tbody>
        {targets.map((t) => <tr key={t.id}><td><strong>{t.name}</strong>{t.notes ? <div className="small muted">{t.notes}</div> : null}</td><td>{t.aliases.join(", ") || "—"}</td><td><button className={`badge ${t.enabled ? "ok" : ""}`} disabled={busy || editingId !== null} onClick={() => patch(t.id,{enabled:!t.enabled})}>{t.enabled ? "Aktif" : "Pasif"}</button></td><td><button className="btn" disabled={busy} onClick={() => { setEditingId(t.id); setName(t.name); setAliases(t.aliases.join(", ")); setNotes(t.notes || ""); setError(""); }}>Düzenle</button><button className="btn danger" disabled={busy || editingId !== null} onClick={() => remove(t.id)}>Sil</button></td></tr>)}
      </tbody></table></div>}
    </section>
  </div>;
}
