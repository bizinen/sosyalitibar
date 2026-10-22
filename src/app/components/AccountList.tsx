"use client";

import Link from "next/link";
import { ConnectionActions } from "@/app/components/ConnectionActions";
import { ConnectionTargetManager } from "@/app/components/ConnectionTargetManager";
import { UiIcon } from "@/app/components/UiIcon";
import { accountAttention } from "@/lib/account-status";

export type Account = { id: string; platform: string; displayName: string; username: string | null; status: string; lastError: string | null; externalAccountId: string; grantedScopes: string[]; webhookSubscribed: boolean; lastSyncedAt: string | null; healthCheckedAt: string | null; tokenExpiresAt: string | null; targetIds: string[] };
type Target = { id: string; name: string; enabled: boolean };
const statuses: Record<string, string> = { active: "Bağlı", degraded: "Kontrol gerekiyor", revoked: "Yeniden bağlanmalı", disabled: "Duraklatıldı" };
function date(value: string | null) { return value ? new Date(value).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Henüz yapılmadı"; }

export function AccountList({ accounts, targets, reconnectUrl, checkedAt }: { accounts: Account[]; targets: Target[]; reconnectUrl: string | null; checkedAt: number }) {
  const enabled = new Set(targets.filter(target => target.enabled).map(target => target.id));
  return <section className="accounts-section">
    <div className="feed-head"><div><h2>Facebook / Instagram hesapları</h2><p className="section-description">Bağlantı durumu ve hesap sahibi, tek bir yerde.</p></div><span className="badge">{accounts.length} Meta hesabı</span></div>
    <div className="account-grid">{accounts.map((account) => {
      const owners = targets.filter((target) => target.enabled && account.targetIds.includes(target.id));
      const issue = accountAttention(account, enabled, checkedAt);
      return <article className="account-card" key={account.id}>
        <div className="account-heading"><span className={`platform-avatar ${account.platform}`} aria-hidden="true">{account.platform === "instagram" ? "ig" : "f"}</span><div><h3>{account.displayName}</h3><p>{account.username ? `@${account.username}` : account.platform === "instagram" ? "Instagram" : "Facebook sayfası"}</p></div><span className={`badge ${account.status === "active" ? "ok" : account.status === "revoked" ? "danger" : account.status === "disabled" ? "" : "warn"}`}>{statuses[account.status] || account.status}</span></div>
        <div className="account-sync"><span>Son yorum taraması</span><strong>{date(account.lastSyncedAt)}</strong></div>
        {account.status === "disabled" ? <p className="small muted">Yorum alımı duraklatıldı. Geçmiş yorumlarını incelemeye devam edebilirsin.</p> : issue ? <p className="account-guidance"><UiIcon name="shield" size={16} />{issue}</p> : <p className="small muted">Bağlantı açık. Yorumlar otomatik takip edilir.</p>}
        {account.lastError ? <details className="account-error"><summary>Bağlantıda dikkat gerektiren bir durum var</summary><p>{account.lastError}</p><p>İzin sorunu varsa hesabı yeniden bağla. Diğer sorunlar için sistem durumuna bak.</p></details> : null}
        <details className="account-owner" open={owners.length === 0}><summary><span>Hesabın sahibi</span><strong>{owners.length ? owners.map((owner) => owner.name).join(", ") : "Henüz belirtilmedi"}</strong></summary><p className="small muted">Bu seçim, isim içermeyen yorumların kime yöneldiğini anlamaya yardımcı olur.</p><ConnectionTargetManager key={`${account.id}:${account.targetIds.join(":")}`} compact connections={[{ id: account.id, platform: account.platform, displayName: account.displayName, username: account.username, targetIds: account.targetIds }]} targets={targets} /></details>
        <details className="connection-details"><summary>Bağlantı ayrıntıları</summary><dl><div><dt>Son bağlantı kontrolü</dt><dd>{date(account.healthCheckedAt)}</dd></div><div><dt>Hesap kimliği</dt><dd>{account.externalAccountId}</dd></div>{account.tokenExpiresAt ? <div><dt>Yetki geçerliliği</dt><dd>{date(account.tokenExpiresAt)}</dd></div> : null}<div><dt>Yorum bildirimi</dt><dd>{account.platform === "facebook" ? account.webhookSubscribed ? "Abonelik kayıtlı" : "Abonelik gerekiyor" : "Meta uygulama ayarlarından yönetilir"}</dd></div><div><dt>Verilen izinler</dt><dd>{account.grantedScopes.length ? account.grantedScopes.join(", ") : "İzin bilgisi bulunmuyor"}</dd></div></dl></details>
        <div className="account-card-actions"><Link className="btn primary" href={`/?mode=sources&connection=${account.id}`}>Paylaşımlar ve yorumlar</Link><ConnectionActions id={account.id} status={account.status} displayName={account.displayName} platform={account.platform} webhookSubscribed={account.webhookSubscribed} reconnectUrl={reconnectUrl} needsReconnect={account.status !== "disabled" && Boolean(account.tokenExpiresAt && Date.parse(account.tokenExpiresAt) <= checkedAt + 7 * 86400000)} /></div>
      </article>;
    })}</div>
  </section>;
}
