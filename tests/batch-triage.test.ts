import { afterEach, describe, expect, it, vi } from "vitest";
import { createBatchAnalyzer } from "@/lib/batch-triage";
import { defaultAiPolicy, parseTriageResults } from "@/lib/triage-contract";
import type { getLlmSettings } from "@/lib/llm-settings";
import { translationPromptHash } from "@/lib/translation";

const cfg = { LLM_BASE_URL: "https://provider.test/v1", LLM_MODEL: "economical", LLM_API_KEY: "fixture",
  LLM_TIMEOUT_MS: 5000, policy: { ...defaultAiPolicy, targetContext: "Ahmet Hoca" }, policyRevision: 4 } as Awaited<ReturnType<typeof getLlmSettings>>;
const input = { text: "Yorum", targets: [], postText: "Ortak paylaşım", source: { platform: "youtube" } };
const response = (results: unknown[], finish = "stop") => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: JSON.stringify({ results }) } }] }));
type RequestBody = { messages: Array<{ content: string }> };
function request(init: RequestInit | undefined) { return JSON.parse(String(init?.body)) as RequestBody; }
function comments(init: RequestInit | undefined) {
  return JSON.parse(request(init).messages[1]!.content).comments as Array<{ id: string; text: string }>;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("batched triage", () => {
  it("uses the Runware GPT-OSS workaround without weakening strict output validation", async () => {
    const settings = { ...cfg, LLM_BASE_URL: "https://api.runware.ai/v1", LLM_MODEL: "openai:gpt-oss@120b" };
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("response_format");
      return response(comments(init).map(({ id }) => ({ id, label: "insan_incelemesi_gerekli" })));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(createBatchAnalyzer(1, settings)(input)).resolves.toMatchObject({ data: { label: "insan_incelemesi_gerekli" } });
    fetcher.mockImplementation(async () => response([{ id: "foreign", label: "inceleme_gerekmiyor" }]));
    await expect(createBatchAnalyzer(1, settings)(input)).rejects.toThrow("geçersiz");
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"{"results":[]}' } }] })));
    await expect(createBatchAnalyzer(1, settings)(input)).rejects.toThrow("geçersiz");
  });

  it("sends one request with shared post context and maps reordered IDs to the right comments", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = request(init);
      expect(body.messages[0]!.content).toContain("Ahmet Hoca");
      expect(JSON.parse(body.messages[1]!.content).contexts).toHaveLength(1);
      const rows = comments(init);
      return response([{ id: rows[1]!.id, label: "acil_inceleme" }, { id: rows[0]!.id, label: "inceleme_gerekmiyor" }]);
    });
    vi.stubGlobal("fetch", fetcher);
    const analyze = createBatchAnalyzer(2, cfg);
    const results = await Promise.all([analyze(input), analyze({ ...input, text: "Tehdit" })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.map((row) => row.data.label)).toEqual(["inceleme_gerekmiyor", "acil_inceleme"]);
    expect(results[0]!.promptVersion).toBe("triage-v1:p4");
    expect(results[0]!.inputHash).not.toBe(results[1]!.inputHash);
    expect(results[0]!.data).not.toHaveProperty("severity");
  });

  it("retries only missing or duplicate IDs, preserving valid results", async () => {
    const batches: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const ids = comments(init).map((row) => row.id); batches.push(ids);
      return batches.length === 1
        ? response([{ id: ids[0], label: "inceleme_gerekmiyor" }, { id: ids[1], label: "acil_inceleme" }, { id: ids[1], label: "inceleme_gerekmiyor" }])
        : response(ids.map((id) => ({ id, label: "insan_incelemesi_gerekli" })));
    }));
    const analyze = createBatchAnalyzer(3, cfg);
    const results = await Promise.all([analyze(input), analyze(input), analyze(input)]);
    expect(batches).toEqual([["c1", "c2", "c3"], ["c2", "c3"]]);
    expect(results.map((row) => row.data.label)).toEqual(["inceleme_gerekmiyor", "insan_incelemesi_gerekli", "insan_incelemesi_gerekli"]);
  });

  it("rejects foreign IDs and extra fields rather than accepting an unsafe partial match", () => {
    expect(() => parseTriageResults('{"results":[{"id":"alien","label":"inceleme_gerekmiyor"}]}', ["c1"])).toThrow();
    expect(() => parseTriageResults('{"results":[{"id":"c1","label":"inceleme_gerekmiyor","severity":0}]}', ["c1"])).toThrow();
  });

  it("splits a truncated response once and never treats failed output as safe", async () => {
    const batches: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const ids = comments(init).map((row) => row.id); batches.push(ids);
      return response(ids.map((id) => ({ id, label: "inceleme_gerekmiyor" })), "length");
    }));
    const analyze = createBatchAnalyzer(2, cfg);
    const results = await Promise.allSettled([analyze(input), analyze(input)]);
    expect(batches).toEqual([["c1", "c2"], ["c1"], ["c2"]]);
    expect(results.every((row) => row.status === "rejected")).toBe(true);
  });

  it("does not fan out HTTP rate-limit errors or expose the provider error body", async () => {
    const fetcher = vi.fn(async () => new Response("secret private comment", { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const analyze = createBatchAnalyzer(2, cfg);
    const results = await Promise.allSettled([analyze(input), analyze(input)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const row of results) { expect(row.status).toBe("rejected"); if (row.status === "rejected") expect(row.reason.message).toBe("LLM HTTP 429"); }
  });

  it("routes an oversized comment to human review without truncation or a paid request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const result = await createBatchAnalyzer(1, cfg)({ ...input, text: "x".repeat(cfg.policy.batchMaxChars + 1) });
    expect(result).toMatchObject({ data: { label: "insan_incelemesi_gerekli" }, provider: "local", raw: { reason: "input_budget_exceeded", modelCalled: false } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("splits input by its serialized budget and retains every comment", async () => {
    const batches: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(request(init).messages[1]!.content.length).toBeLessThanOrEqual(4000);
      const rows = comments(init); batches.push(rows.map((row) => row.id));
      return response(rows.map(({ id }) => ({ id, label: "inceleme_gerekmiyor" })));
    }));
    const analyze = createBatchAnalyzer(2, { ...cfg, policy: { ...cfg.policy, batchMaxChars: 4000 } });
    const results = await Promise.all([analyze({ ...input, text: "a".repeat(2400) }), analyze({ ...input, text: "b".repeat(2400) })]);
    expect(batches).toEqual([["c1"], ["c2"]]);
    expect(results.every((row) => row.provider !== "local")).toBe(true);
  });

  it("flushes available comments when a claimed sibling never reaches the analyzer", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => response([{ id: "c1", label: "insan_incelemesi_gerekli" }]));
    vi.stubGlobal("fetch", fetcher);
    const pending = createBatchAnalyzer(2, cfg)(input);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ data: { label: "insan_incelemesi_gerekli" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps incomplete reply context in human review even if the model says no review", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ id: "c1", label: "inceleme_gerekmiyor" }])));
    const result = await createBatchAnalyzer(1, cfg)({ ...input, source: { itemType: "reply" } });
    expect(result).toMatchObject({ data: { label: "insan_incelemesi_gerekli" }, raw: { modelLabel: "inceleme_gerekmiyor" } });
  });

  it("changes the input hash when instructions change and isolates translation cache policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ id: "c1", label: "inceleme_gerekmiyor" }])));
    const first = await createBatchAnalyzer(1, cfg)(input);
    const second = await createBatchAnalyzer(1, { ...cfg, policyRevision: 5, policy: { ...cfg.policy, targetContext: "Başka kişi" } })(input);
    expect(first.inputHash).not.toBe(second.inputHash);
    expect(translationPromptHash(cfg.policy)).toBe(translationPromptHash({ ...cfg.policy, targetContext: "Başka kişi" }));
    expect(translationPromptHash(cfg.policy)).not.toBe(translationPromptHash({ ...cfg.policy, translationPrompt: "Farklı çeviri talimatı" }));
  });
});
