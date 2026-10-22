import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

beforeEach(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://x:x@localhost:5432/x";
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "development-only-password";
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.CRON_SECRET = "c".repeat(40);
  process.env.AUDIT_HASH_SECRET = "a".repeat(40);
  process.env.META_APP_ID = "1";
  process.env.META_APP_SECRET = "secret";
  process.env.META_GRAPH_VERSION = "v26.0";
  process.env.META_REDIRECT_URI = "http://localhost:3000/api/meta/callback";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "v".repeat(20);
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.LLM_API_KEY = "x";
  process.env.LLM_MODEL = "test";
});

describe("token crypto", () => {
  it("round trips a secret", async () => {
    const mod = await import("@/lib/crypto");
    const encrypted = mod.encryptSecret("top-secret-token");
    expect(encrypted).not.toContain("top-secret-token");
    expect(mod.decryptSecret(encrypted)).toBe("top-secret-token");
  });
});
