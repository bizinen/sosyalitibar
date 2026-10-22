"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Target = { id: string; name: string; enabled: boolean };
type Connection = {
  id: string;
  platform: string;
  displayName: string;
  username: string | null;
  targetIds: string[];
};

export function ConnectionTargetManager({ connections, targets, compact = false }: { connections: Connection[]; targets: Target[]; compact?: boolean }) {
  const router = useRouter();
  const initial = useMemo(() => Object.fromEntries(connections.map((c) => [c.id, c.targetIds])), [connections]);
  const [selected, setSelected] = useState<Record<string, string[]>>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const enabledTargets = targets.filter((t) => t.enabled);

  function toggle(connectionId: string, targetId: string) {
    setSelected((current) => {
      const values = current[connectionId] ?? [];
      return {
        ...current,
        [connectionId]: values.includes(targetId) ? values.filter((id) => id !== targetId) : [...values, targetId],
      };
    });
  }

  async function save(connectionId: string) {
    setBusyId(connectionId);
    setError("");
    try {
      const response = await fetch(`/api/connections/${connectionId}/targets`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetIds: selected[connectionId] ?? [], reanalyzeExisting: true }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Eşleme kaydedilemedi");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Eşleme kaydedilemedi");
    } finally {
      setBusyId(null);
    }
  }

  if (connections.length === 0) return null;
  return <section className={compact ? "account-targets" : "panel"} style={compact ? undefined : { marginTop: 18 }}>
    {!compact ? <div className="panel-head"><div><h2>Hesapların sahibi</h2><div className="small muted" style={{ marginTop: 5 }}>Hesabın kime ait olduğunu belirt. İsim içermeyen yorumlar da bu bağlamla değerlendirilir.</div></div></div> : null}
    {error ? <div className="notice" role="alert" style={{ margin: 16 }}>{error}</div> : null}
    {enabledTargets.length === 0 ? <div className="empty">Önce <a className="text-link" href="/settings/targets">kişiler ve kurumlar</a> ekranından bir hesap sahibi ekle.</div> : <div className="table-wrap"><table>
      {!compact ? <thead><tr><th>Hesap</th><th>Hesabın sahibi</th><th></th></tr></thead> : null}
      <tbody>{connections.map((connection) => {
        const values = selected[connection.id] ?? [];
        const dirty = JSON.stringify([...values].sort()) !== JSON.stringify([...(initial[connection.id] ?? [])].sort());
        return <tr key={connection.id}>
          {!compact ? <td><strong>{connection.displayName}</strong><div className="small muted">{connection.platform}{connection.username ? ` · @${connection.username}` : ""}</div></td> : null}
          <td><div className="target-checks">{enabledTargets.map((target) => <label className="target-check" key={target.id}>
            <input type="checkbox" checked={values.includes(target.id)} disabled={busyId === connection.id} onChange={() => toggle(connection.id, target.id)} />
            <span>{target.name}</span>
          </label>)}</div></td>
          <td><button className="btn primary" disabled={!dirty || busyId === connection.id} onClick={() => save(connection.id)}>{busyId === connection.id ? "Kaydediliyor…" : "Kaydet"}</button></td>
        </tr>;
      })}</tbody>
    </table></div>}
  </section>;
}
