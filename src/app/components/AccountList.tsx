"use client";

import { useState } from "react";
import { ConnectionActions } from "@/app/components/ConnectionActions";
import { ConnectionTargetManager } from "@/app/components/ConnectionTargetManager";
import { UiIcon } from "@/app/components/UiIcon";

type Account = { id: string; platform: string; displayName: string; username: string | null; status: string; lastError: string | null; externalAccountId: string; grantedScopes: string[]; webhookSubscribed: boolean; lastSyncedAt: string | null; healthCheckedAt: string | null; tokenExpiresAt: string | null; targetIds: string[] };
type Target = { id: string; name: string; enabled: boolean };
const statuses: Record<string, string> = { active: "Bağlı", degraded: "Kontrol gerekiyor", revoked: "Yeniden bağlanmalı", disabled: "Duraklatıldı" };
function date(value: string | null) { return value ? new Date(value).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Henüz yapılmadı"; }

export function AccountList({ accounts, targets }: { accounts: Account[]; targets: Target[] }) {
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState("");
  const visible = accounts.filter((account) => (!platform || account.platform === platform)
    && `${account.displayName} ${account.username || ""}`.toLocaleLowerCase("tr-TR").includes(search.toLocaleLowerCase("tr-TR")));
  return <section className="accounts-section">
    <div className="feed-head"><div><h2>Facebook / Instagram hesapları</h2><p className="section-description">Bağlantı durumu ve hesap sahibi, tek bir yerde.</p></div><span className="badge">{accounts.length} Meta hesabı</span></div>
    {accounts.length > 0 ? <div className="account-tools"><div className="segmented-control" role="group" aria-label="Hesap platformu">{[{ value: "", label: "Tümü" }, { value: "instagram", label: "Instagram" }, { value: "facebook", label: "Facebook" }].map((option) => <button key={option.value} type="button" aria-pressed={platform === option.value} onClick={() => setPlatform(option.value)}>{option.label}</button>)}</div><input className="input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hesap adına göre ara…" aria-label="Hesap ara" /></div> : null}
    {visible.length === 0 ? <div className="empty empty-feature"><span className="empty-symbol"><UiIcon name="accounts" size={30} /></span><h2>{accounts.length === 0 ? "Hesapların burada bir araya gelecek." : "Eşleşen hesap bulunamadı."}</h2><p>{accounts.length === 0 ? "Yukarıdaki hesap ekleme alanından Facebook veya Instagram hesabını bağla." : "Farklı bir isim ara veya platform seçimini değiştir."}</p>{accounts.length > 0 ? <button className="btn" type="button" onClick={() => { setSearch(""); setPlatform(""); }}>Tüm hesapları göster</button> : null}</div> : <div className="account-grid">{visible.map((account) => {
      const owners = targets.filter((target) => target.enabled && account.targetIds.includes(target.id));
      return <article className="account-card" key={account.id}>
        <div className="account-heading"><span className={`platform-avatar ${account.platform}`} aria-hidden="true">{account.platform === "instagram" ? "ig" : "f"}</span><div><h3>{account.displayName}</h3><p>{account.username ? `@${account.username}` : account.platform === "instagram" ? "Instagram" : "Facebook sayfası"}</p></div><span className={`badge ${account.status === "active" ? "ok" : account.status === "revoked" ? "danger" : account.status === "disabled" ? "" : "warn"}`}>{statuses[account.status] || account.status}</span></div>
        <div className="account-sync"><span>Son yorum taraması</span><strong>{date(account.lastSyncedAt)}</strong></div>
        {account.lastError ? <details className="account-error"><summary>Bağlantıda dikkat gerektiren bir durum var</summary><p>{account.lastError}</p><p>İzin sorunu varsa hesabı yeniden bağla. Diğer sorunlar için sistem durumuna bak.</p></details> : null}
        <details className="account-owner" open={owners.length === 0}><summary><span>Hesabın sahibi</span><strong>{owners.length ? owners.map((owner) => owner.name).join(", ") : "Henüz belirtilmedi"}</strong></summary><p className="small muted">Bu seçim, isim içermeyen yorumların kime yöneldiğini anlamaya yardımcı olur.</p><ConnectionTargetManager key={`${account.id}:${account.targetIds.join(":")}`} compact connections={[{ id: account.id, platform: account.platform, displayName: account.displayName, username: account.username, targetIds: account.targetIds }]} targets={targets} /></details>
        <details className="connection-details"><summary>Bağlantı ayrıntıları</summary><dl><div><dt>Son bağlantı kontrolü</dt><dd>{date(account.healthCheckedAt)}</dd></div><div><dt>Hesap kimliği</dt><dd>{account.externalAccountId}</dd></div>{account.tokenExpiresAt ? <div><dt>Yetki geçerliliği</dt><dd>{date(account.tokenExpiresAt)}</dd></div> : null}<div><dt>Yorum bildirimi</dt><dd>{account.platform === "facebook" ? account.webhookSubscribed ? "Abonelik kayıtlı" : "Abonelik gerekiyor" : "Meta uygulama ayarlarından yönetilir"}</dd></div><div><dt>Verilen izinler</dt><dd>{account.grantedScopes.length ? account.grantedScopes.join(", ") : "İzin bilgisi bulunmuyor"}</dd></div></dl></details>
        <div className="account-card-actions"><ConnectionActions id={account.id} status={account.status} displayName={account.displayName} platform={account.platform} webhookSubscribed={account.webhookSubscribed} /></div>
      </article>;
    })}</div>}
  </section>;
}
