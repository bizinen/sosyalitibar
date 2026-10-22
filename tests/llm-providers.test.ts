import { afterEach, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ LLM_BASE_URL: "https://api.openai.com/v1", LLM_API_KEY: "fixture-key",
  LLM_MODEL: "arbitrary-model-id", LLM_MAX_RETRIES: 0, LLM_TIMEOUT_MS: 5000 }));
vi.mock("@/lib/llm-settings", () => ({ getLlmSettings: async () => ({ ...config, policy: (await import("@/lib/triage-contract")).defaultAiPolicy, policyRevision: 0 }) }));
import { analyzeComment } from "@/lib/llm";
import { translateToTurkish } from "@/lib/translation";

afterEach(() => vi.unstubAllGlobals());

const analysis = { target_match: false, target_confidence: 0, matched_target: null, sentiment: "neutral", category: "other",
  severity: 0, contains_insult: false, contains_threat: false, contains_claim: false, claim_text: null, needs_review: false, summary: "Nötr yorum." };

it.each([
  ["https://api.openai.com/v1", "max_completion_tokens"],
  ["https://generativelanguage.googleapis.com/v1beta/openai", "max_tokens"],
  ["https://openrouter.ai/api/v1", "max_tokens"],
  ["https://api.runware.ai/v1", "max_completion_tokens"],
])("uses %s for both analysis and translation without restricting model IDs", async (baseUrl, tokenParameter) => {
  config.LLM_BASE_URL = baseUrl;
  let calls = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe(`${baseUrl}/chat/completions`);
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bearer fixture-key" });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("arbitrary-model-id");
    expect(body[tokenParameter]).toBe(8192);
    expect(body).not.toHaveProperty(tokenParameter === "max_tokens" ? "max_completion_tokens" : "max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body.response_format).toEqual({ type: "json_object" });
    if (baseUrl.includes("openrouter")) expect(body.provider).toEqual({ require_parameters: true });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(
      calls === 1 ? analysis : { text: "Merhaba" }) } }] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(analyzeComment({ text: "Hello", targets: [] })).resolves.toMatchObject({ data: analysis, model: "arbitrary-model-id" });
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  await expect(translateToTurkish("Hello", heartbeat)).resolves.toMatchObject({ text: "Merhaba", model: "arbitrary-model-id", promptHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(heartbeat).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not accept an inconsistent assessment from a configured provider", async () => {
  config.LLM_BASE_URL = "https://api.runware.ai/v1";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop",
    message: { content: JSON.stringify({ ...analysis, category: "threat", contains_threat: false }) } }] }))));
  await expect(analyzeComment({ text: "Hello", targets: [] })).rejects.toThrow("LLM çıktı sözleşmesi geçersiz");
});
