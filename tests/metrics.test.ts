import { beforeEach, describe, expect, it, vi } from "vitest";

const { queries, settings } = vi.hoisted(() => ({ queries: [] as string[], settings: vi.fn() }));

vi.mock("@/lib/config", () => ({ env: () => ({ CRON_SECRET: "metrics-secret" }) }));
vi.mock("@/lib/llm-settings", () => ({ getLlmSettings: settings }));
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { db: drizzle(async (query) => { queries.push(query); return { rows: [] }; }) };
});

import { GET } from "@/app/api/metrics/route";

beforeEach(() => { queries.length = 0; settings.mockReset().mockResolvedValue({ LLM_BASE_URL: "https://provider.test/v1", LLM_MODEL: "fixture", LLM_API_KEY: "fixture" }); });

describe("metrics", () => {
  it("keeps queue metrics available when provider settings cannot be decrypted", async () => {
    settings.mockRejectedValue(new Error("private configuration failure"));
    const response = await GET(new Request("http://localhost/api/metrics", { headers: { authorization: "Bearer metrics-secret" } }));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("sosyal_itibar_analysis_provider_configuration_error 1");
    expect(body).toContain("sosyal_itibar_queue_oldest_age_seconds");
    expect(body).not.toContain("private");
  });

  it("rejects unauthorized requests without querying the database", async () => {
    const response = await GET(new Request("http://localhost/api/metrics"));
    expect(response.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it("filters MIN aggregates to runnable jobs and emits zero ages for empty queues", async () => {
    const response = await GET(new Request("http://localhost/api/metrics", { headers: { authorization: "Bearer metrics-secret" } }));
    expect(response.status).toBe(200);
    const ageQueries = queries.filter((query) => query.includes("min(") && !query.includes('from "watched_videos"'));
    expect(ageQueries).toHaveLength(4);
    for (const query of ageQueries) {
      expect(query).toMatch(/min\("[^"]+"\) filter \(where /);
      expect(query).toContain("greatest(coalesce(extract(epoch from (now() - min(");
      expect(query).toContain("), 0), 0)::float8");
    }
    for (const [table, column, status] of [
      ["webhook_events", "available_at", "status"],
      ["social_items", "analysis_available_at", "analysis_status"],
      ["alert_outbox", "available_at", "status"],
    ]) {
      const query = ageQueries.find((candidate) => candidate.includes(`from "${table}"`));
      expect(query).toContain(`min("${column}") filter (where "${status}" in ('pending','retry') and "${column}" <= now())`);
    }
    const body = await response.text();
    for (const queue of ["webhook", "analysis", "alert"]) {
      expect(body).toContain(`sosyal_itibar_queue_oldest_age_seconds{queue="${queue}"} 0`);
    }
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
