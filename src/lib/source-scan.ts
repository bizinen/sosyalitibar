export type SourceScan = {
  provider: string; status: string; lastSyncedAt: string | null; resultsLimit: number; maxChargeCents: number;
  continuing: boolean; overdue: boolean; running: boolean; lastError: boolean;
};

export function sourceScanStatus(scan: SourceScan) {
  const label = scan.status === "paused" ? "Duraklatıldı"
    : scan.status === "blocked" ? "Tarama müdahale bekliyor"
    : scan.lastError ? "Tarama hatası · tekrar denenecek"
    : scan.running ? "Yorumlar alınıyor"
    : scan.overdue ? "Tarama gecikmiş · worker kontrol edilmeli"
    : scan.continuing ? "Tarama devam edecek"
    : scan.lastSyncedAt ? scan.provider === "apify" ? "Dataset aktarıldı · kapsam sınırlı" : "Erişilebilir sayfalar tarandı"
    : "İlk tarama bekleniyor";
  const note = scan.provider === "apify"
    ? `Tarama sınırı: ${scan.resultsLimit.toLocaleString("tr-TR")} üst yorum ve $${(scan.maxChargeCents / 100).toFixed(2)}. Yanıtlar eklenebilir; tüm geçmiş doğrulanmadı.`
    : "Sağlayıcının erişime açtığı yorum ve yanıtlar sayfalanır.";
  return { label, note, warning: scan.overdue || scan.lastError || scan.status === "blocked" };
}
