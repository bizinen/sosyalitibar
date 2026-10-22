export type AccountHealth = { platform: string; status: string; lastError: string | null; webhookSubscribed: boolean; tokenExpiresAt: string | null; targetIds: string[] };

export function accountAttention(account: AccountHealth, enabledTargetIds: Set<string>, now: number): string | null {
  if (account.status === "disabled") return null;
  if (account.status === "revoked") return "Yetki kaldırılmış. Yorum alımına devam etmek için hesabı yeniden bağla.";
  if (account.tokenExpiresAt && Date.parse(account.tokenExpiresAt) <= now) return "Hesabın erişim süresi dolmuş. Yeniden bağlanması gerekiyor.";
  if (account.status === "degraded" || account.lastError) return "Bağlantının kontrolü gerekiyor. Ayrıntıları inceleyip izinleri veya taramayı yeniden dene.";
  if (account.platform === "facebook" && !account.webhookSubscribed) return "Yeni yorum bildirimleri bağlı değil. Bildirim bağlantısını yenile.";
  if (!account.targetIds.some(id => enabledTargetIds.has(id))) return "Hesap sahibini seç. İsim içermeyen yorumlar bu kişi veya kurumla ilişkilendirilir.";
  if (account.tokenExpiresAt && Date.parse(account.tokenExpiresAt) <= now + 7 * 86400000) return "Erişim süresi bir hafta içinde doluyor. Kesinti olmaması için hesabı yeniden bağla.";
  return null;
}
