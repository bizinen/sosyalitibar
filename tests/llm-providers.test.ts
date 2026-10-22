import { afterEach, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ LLM_BASE_URL: "https://api.openai.com/v1", LLM_API_KEY: "fixture-key",
  LLM_MODEL: "arbitrary-model-id", LLM_MAX_RETRIES: 0, LLM_TIMEOUT_MS: 5000 }));
vi.mock("@/lib/llm-settings", () => ({ getLlmSettings: async () => ({ ...config, policy: (await import("@/lib/triage-contract")).defaultAiPolicy, policyRevision: 0 }) }));
import { analyzeComment } from "@/lib/llm";
import { translateToTurkish } from "@/lib/translation";
import { validLlmModelId } from "@/lib/llm-providers";

afterEach(() => { vi.unstubAllGlobals(); config.LLM_MODEL = "arbitrary-model-id"; });

const analysis = { target_match: false, target_confidence: 0, matched_target: null, sentiment: "neutral", category: "other",
  severity: 0, contains_insult: false, contains_threat: false, contains_claim: false, claim_text: null, needs_review: false, summary: "Nötr yorum." };

it("validates Runware AIR syntax without imposing a model allowlist on providers", () => {
  for (const model of ["openai:gpt@5.4-nano", "minimax:m2.7@0", "google:gemini@3.1-pro"]) expect(validLlmModelId("https://api.runware.ai/v1", model)).toBe(true);
  for (const model of ["1", "gpt", "openai:gpt@", "openai: gpt@5.4"]) expect(validLlmModelId("https://api.runware.ai/v1", model)).toBe(false);
  expect(validLlmModelId("https://api.openai.com/v1", "arbitrary-model-id")).toBe(true);
});

it.each([
  ["https://api.openai.com/v1", "max_completion_tokens"],
  ["https://generativelanguage.googleapis.com/v1beta/openai", "max_tokens"],
  ["https://openrouter.ai/api/v1", "max_tokens"],
  ["https://api.runware.ai/v1", "max_completion_tokens"],
  ["https://api.runware.ai/v1", "max_completion_tokens", "openai:gpt-oss@120b"],
])("uses %s for both analysis and translation without restricting model IDs", async (baseUrl, tokenParameter, model = "arbitrary-model-id") => {
  config.LLM_BASE_URL = baseUrl;
  config.LLM_MODEL = model ?? "arbitrary-model-id";
  let calls = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe(`${baseUrl}/chat/completions`);
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bearer fixture-key" });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(config.LLM_MODEL);
    expect(body[tokenParameter]).toBe(8192);
    expect(body).not.toHaveProperty(tokenParameter === "max_tokens" ? "max_completion_tokens" : "max_tokens");
    expect(body).not.toHaveProperty("temperature");
    if (model === "openai:gpt-oss@120b") expect(body).not.toHaveProperty("response_format");
    else expect(body.response_format).toEqual({ type: "json_object" });
    if (baseUrl.includes("openrouter")) expect(body.provider).toEqual({ require_parameters: true });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(
      calls === 1 ? analysis : { text: "Merhaba" }) } }] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(analyzeComment({ text: "Hello", targets: [] })).resolves.toMatchObject({ data: analysis, model: config.LLM_MODEL });
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  await expect(translateToTurkish("Hello", heartbeat)).resolves.toMatchObject({ text: "Merhaba", model: config.LLM_MODEL, promptHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(heartbeat).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not accept an inconsistent assessment from a configured provider", async () => {
  config.LLM_BASE_URL = "https://api.runware.ai/v1";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop",
    message: { content: JSON.stringify({ ...analysis, category: "threat", contains_threat: false }) } }] }))));
  await expect(analyzeComment({ text: "Hello", targets: [] })).rejects.toThrow("LLM çıktı sözleşmesi geçersiz");
});
