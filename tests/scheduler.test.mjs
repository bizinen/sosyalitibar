import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("CRON_SECRET", "test-secret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("scheduler independent workers", () => {
  it("reports work failures inside HTTP 200 responses and backs off when no work succeeds", async () => {
    const fetchMock = vi.fn(async (url) => ({ ok: true, text: async () => JSON.stringify(
      url.endsWith("process-videos") ? { results: [{ error: "source_read_failed" }] }
        : url.endsWith("process-analyses") ? { claimed: 8, succeeded: 0, failed: 8, hasMore: true } : {}) }));
    vi.stubGlobal("fetch", fetchMock);
    const { runScheduler } = await import("../scripts/scheduler.mjs");
    const controller = new AbortController();
    const running = runScheduler(controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(9999);
      const heartbeats = fetchMock.mock.calls.filter(([url]) => url.endsWith("/heartbeat")).map(([, init]) => JSON.parse(init.body));
      expect(heartbeats.find(row => row.job === "process-videos").succeeded).toBe(false);
      expect(heartbeats.find(row => row.job === "process-analyses").succeeded).toBe(false);
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("process-analyses"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("process-analyses"))).toHaveLength(2);
    } finally { controller.abort(); await running; }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains full successful packages promptly and returns to idle polling after an empty package", async () => {
    let packages = 0;
    const fetchMock = vi.fn(async (url) => ({ ok: true, text: async () => JSON.stringify(
      url.endsWith("process-events") && ++packages < 3 ? { claimed: 8, succeeded: 8, hasMore: true } : { claimed: 0 }) }));
    vi.stubGlobal("fetch", fetchMock);
    const { runScheduler } = await import("../scripts/scheduler.mjs");
    const controller = new AbortController();
    const running = runScheduler(controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(packages).toBe(3);
      await vi.advanceTimersByTimeAsync(4999);
      expect(packages).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(packages).toBe(4);
    } finally { controller.abort(); await running; }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains maintenance debt in bounded bursts and resumes the daily interval when finished", async () => {
    let batches = 0;
    const fetchMock = vi.fn(async (url) => ({ ok: true, text: async () => JSON.stringify(
      url.endsWith("maintenance") ? { batchMayHaveMore: ++batches <= 10 } : {}) }));
    vi.stubGlobal("fetch", fetchMock);
    const { runScheduler } = await import("../scripts/scheduler.mjs");
    const controller = new AbortController();
    const running = runScheduler(controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(45000);
      expect(batches).toBe(10);
      await vi.advanceTimersByTimeAsync(59999);
      expect(batches).toBe(10);
      await vi.advanceTimersByTimeAsync(1);
      expect(batches).toBe(11);
      await vi.advanceTimersByTimeAsync(60000);
      expect(batches).toBe(11);
    } finally { controller.abort(); await running; }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("imports without starting network calls or requiring credentials", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await import("../scripts/scheduler.mjs");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues alerts and events while analysis is pending, without overlapping analysis", async () => {
    const fetchMock = vi.fn((url, init) => {
      if (url.endsWith("process-analyses")) {
        return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      return Promise.resolve({ ok: true, text: async () => '{"claimed":1}' });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { runScheduler } = await import("../scripts/scheduler.mjs");
    const controller = new AbortController();
    const running = runScheduler(controller.signal);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("process-alerts"))).toHaveLength(25);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("process-events"))).toHaveLength(25);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("process-analyses"))).toHaveLength(1);
    controller.abort();
    await running;
    expect(fetchMock.mock.calls.find(([url]) => url.endsWith("process-analyses"))[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates failures, reports failed heartbeats and backs off before retrying", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network failure"));
    vi.stubGlobal("fetch", fetchMock);
    const { runScheduler } = await import("../scripts/scheduler.mjs");
    const controller = new AbortController();
    const running = runScheduler(controller.signal);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchMock).toHaveBeenCalledTimes(14);
    const heartbeats = fetchMock.mock.calls.filter(([url]) => url.endsWith("/heartbeat"));
    expect(heartbeats).toHaveLength(7);
    expect(heartbeats.every(([, init]) => JSON.parse(init.body).succeeded === false)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(22);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("worker.alerts_failed"));
    controller.abort();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });
});
