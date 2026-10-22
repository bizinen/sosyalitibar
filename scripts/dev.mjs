import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";

function terminate(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {});
  } else if (child.pid) {
    try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
  } else child.kill(signal);
}

export async function runDev(signal, { spawnProcess = spawn, request = fetch, args = process.argv.slice(2) } = {}) {
  if (signal.aborted) return;
  nextEnv.loadEnvConfig(process.cwd(), true);
  if (!process.env.CRON_SECRET) throw new Error("Web ve worker için CRON_SECRET gerekli");
  const portFlag = args.findIndex(arg => arg === "--port" || arg === "-p");
  const port = portFlag >= 0 ? args[portFlag + 1] : process.env.PORT || "3000";
  if (!/^\d+$/.test(port ?? "") || Number(port) < 1 || Number(port) > 65535) throw new Error("Geçersiz geliştirme portu");
  const base = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const options = { cwd: process.cwd(), stdio: "inherit", windowsHide: true, detached: process.platform !== "win32", env: process.env };
  const nextArgs = portFlag >= 0 ? args : ["--port", port, ...args];
  const app = spawnProcess(process.execPath, [createRequire(import.meta.url).resolve("next/dist/bin/next"), "dev", ...nextArgs], options);
  let worker;
  let stopTimer;
  const stop = () => {
    if (stopTimer) return;
    terminate(worker); terminate(app);
    stopTimer = setTimeout(() => { terminate(app, "SIGKILL"); terminate(worker, "SIGKILL"); }, 10000);
    stopTimer.unref();
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  const appDone = new Promise((resolve, reject) => {
    app.once("exit", code => { abort(); resolve(code); });
    app.once("error", error => { abort(); reject(error); });
  });
  const workerLoop = (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await request(`${base}/api/health`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { /* The web server may still be compiling its health route. */ }
      await delay(1000, undefined, { signal: controller.signal }).catch(() => {});
    }
    let failures = 0;
    while (!controller.signal.aborted) {
      const started = Date.now();
      worker = spawnProcess(process.execPath, ["scripts/scheduler.mjs"], { ...options,
        env: { ...process.env, APP_INTERNAL_URL: base } });
      await new Promise(resolve => { worker.once("exit", resolve); worker.once("error", resolve); });
      if (controller.signal.aborted) break;
      failures = Date.now() - started > 60000 ? 1 : failures + 1;
      const waitMs = Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
      console.error(JSON.stringify({ event: "dev.worker_restart", waitMs }));
      await delay(waitMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  })();
  try {
    const code = await Promise.race([appDone, workerLoop.then(() => appDone)]);
    await workerLoop;
    if (code && !signal.aborted) throw new Error(`Geliştirme sunucusu kapandı (${code})`);
  } finally {
    abort(); stop();
    await Promise.allSettled([appDone, workerLoop]);
    clearTimeout(stopTimer);
    signal.removeEventListener("abort", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  runDev(controller.signal).catch(() => { console.error("Web/worker başlatılamadı. Yapılandırmayı ve süreç çıktısını kontrol et."); process.exitCode = 1; })
    .finally(() => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); });
}
