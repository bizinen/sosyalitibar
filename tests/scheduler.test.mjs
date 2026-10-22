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
    expect(fetchMock).toHaveBeenCalledTimes(12);
    const heartbeats = fetchMock.mock.calls.filter(([url]) => url.endsWith("/heartbeat"));
    expect(heartbeats).toHaveLength(6);
    expect(heartbeats.every(([, init]) => JSON.parse(init.body).succeeded === false)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(18);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("worker.alerts_failed"));
    controller.abort();
    await running;
    expect(vi.getTimerCount()).toBe(0);
  });
});
