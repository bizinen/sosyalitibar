import { expect, it } from "vitest";
import { sourceScanStatus, type SourceScan } from "@/lib/source-scan";

const scan: SourceScan = { provider: "apify", status: "active", lastSyncedAt: "2026-10-22T00:00:00Z", resultsLimit: 1000,
  maxChargeCents: 100, continuing: false, overdue: false, running: false, lastError: false };

it("does not describe an imported capped dataset as full platform coverage", () => {
  expect(sourceScanStatus(scan)).toMatchObject({ label: "Dataset aktarıldı · kapsam sınırlı", warning: false });
  expect(sourceScanStatus(scan).note).toContain("tüm geçmiş doğrulanmadı");
});

it("exposes overdue scans and preserves operator pause instead of showing a stale success", () => {
  expect(sourceScanStatus({ ...scan, overdue: true })).toMatchObject({ warning: true, label: "Tarama gecikmiş · worker kontrol edilmeli" });
  expect(sourceScanStatus({ ...scan, status: "paused" }).label).toBe("Duraklatıldı");
  expect(sourceScanStatus({ ...scan, running: true }).label).toBe("Yorumlar alınıyor");
});
