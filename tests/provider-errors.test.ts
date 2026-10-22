import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/llm-settings", async () => ({ getLlmSettings: async () => ({ ...(await import("@/lib/config")).env(), policy: (await import("@/lib/triage-contract")).defaultAiPolicy, policyRevision: 0 }) }));
vi.mock("@/lib/meta-settings", async () => ({ getMetaSettings: async () => (await import("@/lib/config")).env() }));
vi.mock("@/lib/config", () => ({ env: () => ({ META_GRAPH_VERSION: "v26.0", LLM_BASE_URL: "https://provider.test/v1",
  LLM_API_KEY: "fixture", LLM_MODEL: "fixture", LLM_TIMEOUT_MS: 5000, LLM_MAX_RETRIES: 0 }) }));
import { getFacebookComment } from "@/lib/meta";
import { analyzeComment } from "@/lib/llm";
afterEach(() => vi.unstubAllGlobals());
it("does not expose Meta error body or nonnumeric error codes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
    message: "private-comment", code: "access_token=private-token", error_subcode: "private-user", is_transient: false,
  } }), { status: 400 })));
  await expect(getFacebookComment("fixture", "fixture-token")).rejects.toThrow("Meta API HTTP 400; code=unknown; subcode=none");
});
it("does not expose LLM error response contents", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-token private-comment", { status: 400 })));
  await expect(analyzeComment({ text: "fixture", targets: [], sourceTargets: [] })).rejects.toThrow("LLM HTTP 400");
});
