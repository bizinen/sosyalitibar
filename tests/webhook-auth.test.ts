import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaWebhookSignature } from "@/lib/webhook-auth";

const secret = "meta-test-secret";
const raw = JSON.stringify({ object: "instagram", entry: [{ id: "1" }] });

describe("Meta webhook signature", () => {
  it("accepts the exact HMAC-SHA256 signature", () => {
    const sig = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyMetaWebhookSignature(raw, sig, secret)).toBe(true);
  });

  it("rejects a modified body and malformed signature", () => {
    const sig = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyMetaWebhookSignature(`${raw}x`, sig, secret)).toBe(false);
    expect(verifyMetaWebhookSignature(raw, "sha1=bad", secret)).toBe(false);
    expect(verifyMetaWebhookSignature(raw, null, secret)).toBe(false);
  });
});
