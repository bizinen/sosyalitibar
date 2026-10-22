import { expect, it } from "vitest";
import { accountAttention, type AccountHealth } from "@/lib/account-status";

const now = Date.parse("2026-10-22T12:00:00Z");
const ownerIds = new Set(["enabled-owner"]);
const account: AccountHealth = { platform: "facebook", status: "active", lastError: null, webhookSubscribed: true, tokenExpiresAt: null, targetIds: ["enabled-owner"] };

it("does not report a healthy mapped account as requiring intervention", () => {
  expect(accountAttention(account, ownerIds, now)).toBeNull();
});
it("keeps paused accounts out of repair recommendations even with expired credentials or errors", () => {
  expect(accountAttention({ ...account, status: "disabled", tokenExpiresAt: "2020-01-01", lastError: "old failure", targetIds: [] }, ownerIds, now)).toBeNull();
});
it("prioritizes revoked authorization over missing ownership and subscriptions", () => {
  expect(accountAttention({ ...account, status: "revoked", targetIds: [], webhookSubscribed: false }, ownerIds, now)).toContain("yeniden bağla");
});
it.each(["2026-10-21T12:00:00Z", "2026-10-22T12:00:00Z"])("recognizes expired access at the boundary: %s", tokenExpiresAt => {
  expect(accountAttention({ ...account, tokenExpiresAt }, ownerIds, now)).toContain("erişim süresi dolmuş");
});
it("warns before expiry, without reporting a valid token beyond seven days", () => {
  expect(accountAttention({ ...account, tokenExpiresAt: "2026-10-29T12:00:00Z" }, ownerIds, now)).toContain("bir hafta");
  expect(accountAttention({ ...account, tokenExpiresAt: "2026-10-29T12:00:01Z" }, ownerIds, now)).toBeNull();
});
it("requires an enabled owner rather than treating disabled target mappings as sufficient", () => {
  expect(accountAttention({ ...account, targetIds: ["disabled-owner"] }, ownerIds, now)).toContain("Hesap sahibini seç");
});
it("does not apply Facebook page subscription requirements to Instagram", () => {
  expect(accountAttention({ ...account, webhookSubscribed: false }, ownerIds, now)).toContain("bildirimleri");
  expect(accountAttention({ ...account, platform: "instagram", webhookSubscribed: false }, ownerIds, now)).toBeNull();
});
