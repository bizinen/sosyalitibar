import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  find: vi.fn(), update: vi.fn(), analyze: vi.fn(), insert: vi.fn(),
}));
vi.mock("@/lib/db", () => {
  const tx = {
    execute: vi.fn(), update: mocks.update, insert: mocks.insert,
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return { db: { ...tx, query: { socialItems: { findFirst: mocks.find } }, transaction: (fn: (value: typeof tx) => unknown) => fn(tx) } };
});
vi.mock("@/lib/llm", () => ({ analyzeComment: mocks.analyze, PROMPT_VERSION: "test" }));
vi.mock("@/lib/alerts", () => ({ enqueueAlertIfNeeded: vi.fn() }));
vi.mock("@/lib/log", async (original) => ({ ...await original<typeof import("@/lib/log")>(), log: { warn: vi.fn() } }));

import { analyzeClaimedItem } from "@/lib/ingest";

const item = { id: "item", analysisLockId: "lock", analysisStatus: "processing", analysisRevision: 7, analysisAttempts: 0, text: "A comment", connectionId: null, platform: "facebook" };
const result = { data: {}, inputHash: "hash", model: "test", provider: "test", promptVersion: "test", latencyMs: 0, raw: {} };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.find.mockResolvedValue(item);
  mocks.insert.mockReturnValue({ values: () => ({ onConflictDoUpdate: async () => {} }) });
});
afterEach(() => vi.useRealTimers());

describe("analysis lease heartbeat", () => {
  it("renews the exact revision lease during slow LLM work and cleans timers", async () => {
    const where = vi.fn().mockReturnValue({ returning: async () => [{ id: item.id }] });
    mocks.update.mockReturnValue({ set: () => ({ where }) });
    let finish!: (value: typeof result) => void;
    mocks.analyze.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = analyzeClaimedItem(item.id, "lock");
    await vi.advanceTimersByTimeAsync(120_001);
    expect(where).toHaveBeenCalledTimes(3);
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.sql).toContain('"analysis_revision"');
    expect(query.params).toEqual(["item", "lock", "processing", 7]);
    finish(result);
    await expect(pending).resolves.toEqual({ processed: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards provider output after losing ownership without renewing another lease", async () => {
    const returning = vi.fn().mockResolvedValueOnce([{ id: item.id }]).mockResolvedValue([]);
    mocks.update.mockReturnValue({ set: () => ({ where: () => ({ returning }) }) });
    let finish!: (value: typeof result) => void;
    mocks.analyze.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = analyzeClaimedItem(item.id, "lock");
    await vi.advanceTimersByTimeAsync(120_001);
    expect(returning).toHaveBeenCalledTimes(2);
    finish(result);
    await expect(pending).resolves.toEqual({ processed: false, reason: "lost_lock" });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans the timer when the provider fails", async () => {
    mocks.update.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{ id: item.id }] }) }) });
    mocks.analyze.mockRejectedValue(new Error("provider unavailable"));
    await expect(analyzeClaimedItem(item.id, "lock")).resolves.toEqual({ processed: false, reason: "retry" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overlap heartbeat queries and waits for pending renewal cleanup", async () => {
    let renew!: () => void;
    const returning = vi.fn().mockResolvedValueOnce([{ id: item.id }])
      .mockImplementation(() => new Promise((resolve) => { renew = () => resolve([{ id: item.id }]); }));
    mocks.update.mockReturnValue({ set: () => ({ where: () => ({ returning }) }) });
    let finish!: (value: typeof result) => void;
    mocks.analyze.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = analyzeClaimedItem(item.id, "lock");
    await vi.advanceTimersByTimeAsync(180_001);
    expect(returning).toHaveBeenCalledTimes(2);
    returning.mockResolvedValue([{ id: item.id }]);
    finish(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.insert).not.toHaveBeenCalled();
    renew();
    await expect(pending).resolves.toEqual({ processed: true });
  });
});
