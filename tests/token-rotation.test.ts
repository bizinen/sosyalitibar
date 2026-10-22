import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), config: { TOKEN_ENCRYPTION_KEY: "", TOKEN_ENCRYPTION_KEY_PREVIOUS: undefined as string | undefined } }));
vi.mock("@/lib/db", () => ({ db: { execute: mocks.execute } }));
vi.mock("@/lib/config", () => ({ env: () => mocks.config }));

import { currentSecretPrefix, decryptSecret, encryptSecret } from "@/lib/crypto";
import { rotateStoredTokens } from "@/lib/token-rotation";

beforeEach(() => {
  mocks.execute.mockReset().mockResolvedValue([]);
  mocks.config.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  mocks.config.TOKEN_ENCRYPTION_KEY_PREVIOUS = undefined;
});

function switchKey() {
  mocks.config.TOKEN_ENCRYPTION_KEY_PREVIOUS = mocks.config.TOKEN_ENCRYPTION_KEY;
  mocks.config.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
}

describe("maintenance token rotation", () => {
  it("rotates owner, disabled connection and continuation secrets with CAS, usable without previous key", async () => {
    const owner = encryptSecret("owner-token");
    const disabled = { status: "disabled", ciphertext: encryptSecret("page-token") };
    const continuation = encryptSecret('{"tasks":[],"private":"cursor-token"}');
    const apiKey = encryptSecret("llm-key");
    const youtubeKey = encryptSecret("youtube-key");
    const appSecret = encryptSecret("app-secret");
    const verifyToken = encryptSecret("verify-token");
    const videoKey = encryptSecret("video-key");
    const videoProgress = encryptSecret('{"phase":"dataset","offset":100}');
    const alertSecret = encryptSecret("alert-secret");
    switchKey();
    const rotated: string[] = [];
    mocks.execute.mockImplementation(async (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      const ciphertext = query.sql.includes("sync_state") ? continuation : query.sql.includes("meta_auth_accounts") ? owner : query.sql.includes("llm_settings") ? apiKey : query.sql.includes("youtube_settings") ? youtubeKey : query.sql.includes("watched_videos") ? query.sql.includes("progress_encrypted") ? videoProgress : videoKey : query.sql.includes("app_secret_encrypted") ? appSecret : query.sql.includes("verify_token_encrypted") ? verifyToken : query.sql.includes("alert_settings") ? alertSecret : disabled.ciphertext;
      if (query.sql.includes("select count")) return [{ count: 0 }];
      if (query.sql.includes("select id")) {
        expect(query.sql).toContain("limit 100");
        expect(query.sql).not.toContain("status");
        expect(query.params).toEqual([`${currentSecretPrefix()}%`]);
        return [{ id: "id", ciphertext }];
      }
      expect(query.sql).not.toContain("status");
      expect(query.params[2]).toBe(ciphertext);
      rotated.push(String(query.params[0]));
      return [{ id: "id" }];
    });
    expect(await rotateStoredTokens()).toEqual({ rotated: 10, failed: 0, remaining: 0 });
    mocks.config.TOKEN_ENCRYPTION_KEY_PREVIOUS = undefined;
    expect(rotated.map(decryptSecret)).toEqual(["owner-token", "page-token", "llm-key", "youtube-key", "video-key", '{"phase":"dataset","offset":100}', "app-secret", "verify-token", "alert-secret", '{"tasks":[],"private":"cursor-token"}']);
    expect(disabled.status).toBe("disabled");
  });

  it("reports corrupt tokens and remaining inventory without stopping other rotations", async () => {
    const valid = encryptSecret("valid-token");
    switchKey();
    mocks.execute.mockResolvedValueOnce([{ id: "broken", ciphertext: "broken" }, { id: "valid", ciphertext: valid }])
      .mockResolvedValueOnce([{ id: "valid" }]).mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);
    expect(await rotateStoredTokens()).toEqual({ rotated: 1, failed: 1, remaining: 1 });
  });

  it("does not count a concurrent OAuth replacement as rotated", async () => {
    const old = encryptSecret("old-token");
    switchKey();
    mocks.execute.mockResolvedValueOnce([{ id: "id", ciphertext: old }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);
    expect(await rotateStoredTokens()).toEqual({ rotated: 0, failed: 0, remaining: 0 });
  });
});
