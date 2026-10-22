import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runDev } from "../scripts/dev.mjs";

vi.mock("@next/env", () => ({ default: { loadEnvConfig: vi.fn() } }));
vi.mock("node:timers/promises", () => ({ setTimeout: (ms, value, { signal }) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(value); }, ms);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
}) }));

beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("CRON_SECRET", "fixture-secret"); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function child() {
  const value = new EventEmitter(); value.exitCode = null;
  value.kill = vi.fn(() => { value.exitCode = 0; queueMicrotask(() => value.emit("exit", 0)); return true; });
  return value;
}

it("starts worker only after web readiness and restarts failed worker without overlap", async () => {
  const app = child(), first = child(), second = child();
  const spawnProcess = vi.fn().mockReturnValueOnce(app).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const request = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
  const controller = new AbortController();
  const running = runDev(controller.signal, { spawnProcess, request, args: ["--port", "3333"] });
  await vi.advanceTimersByTimeAsync(999); expect(spawnProcess).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(spawnProcess).toHaveBeenCalledTimes(2);
  expect(spawnProcess.mock.calls[1][2].env.APP_INTERNAL_URL).toBe("http://127.0.0.1:3333");
  first.exitCode = 1; first.emit("exit", 1);
  await vi.advanceTimersByTimeAsync(999); expect(spawnProcess).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(spawnProcess).toHaveBeenCalledTimes(3);
  controller.abort(); await running;
  expect(app.kill).toHaveBeenCalled(); expect(second.kill).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("stops worker when the web process exits", async () => {
  const app = child(), worker = child();
  const spawnProcess = vi.fn().mockReturnValueOnce(app).mockReturnValueOnce(worker);
  const controller = new AbortController();
  const running = runDev(controller.signal, { spawnProcess, request: async () => ({ ok: true }), args: [] });
  expect(spawnProcess.mock.calls[0][1]).toContain("--port");
  const checked = expect(running).rejects.toThrow("sunucusu kapandı");
  await vi.advanceTimersByTimeAsync(0);
  app.exitCode = 1; app.emit("exit", 1);
  await checked; expect(worker.kill).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("does not launch children after cancellation or without worker credentials", async () => {
  const spawnProcess = vi.fn(); const cancelled = AbortSignal.abort();
  await runDev(cancelled, { spawnProcess, args: [] }); expect(spawnProcess).not.toHaveBeenCalled();
  vi.stubEnv("CRON_SECRET", "");
  await expect(runDev(new AbortController().signal, { spawnProcess, args: [] })).rejects.toThrow("CRON_SECRET");
  expect(spawnProcess).not.toHaveBeenCalled();
});
