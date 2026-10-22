import { pathToFileURL } from "node:url";

const base = (process.env.APP_INTERNAL_URL || process.env.APP_URL || "http://app:3000").replace(/\/$/, "");
const secret = process.env.CRON_SECRET;

const pollMs = boundedEnv("WORKER_POLL_MS", 5000, 2000, 2_147_483_647);
const reconcileMs = boundedEnv("RECONCILE_INTERVAL_MS", 15 * 60_000, 60_000, 2_147_483_647);
const healthMs = boundedEnv("HEALTH_CHECK_INTERVAL_MS", 6 * 60 * 60_000, 5 * 60_000, 2_147_483_647);
const maintenanceMs = boundedEnv("MAINTENANCE_INTERVAL_MS", 24 * 60 * 60_000, 60 * 60_000, 2_147_483_647);
function boundedEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

const analysisRetries = boundedEnv("LLM_MAX_RETRIES", 2, 0, 4);
const analysisTimeoutMs = Math.ceil(boundedEnv("ANALYSIS_BATCH_SIZE", 8, 1, 50) / boundedEnv("ANALYSIS_CONCURRENCY", 4, 1, 16))
  * ((analysisRetries + 1) * boundedEnv("LLM_TIMEOUT_MS", 30_000, 5_000, 120_000) + analysisRetries * 60_000)
  * (process.env.LLM_FALLBACK_BASE_URL ? 2 : 1) + 60_000;
const longJobTimeoutMs = boundedEnv("WORKER_JOB_TIMEOUT_MS", 35 * 60_000, 120_000, 24 * 60 * 60_000);

function emit(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function post(path, signal, timeoutMs, body) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${secret}`, "user-agent": "sosyal-itibar-worker/1", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function safePost(path, event, signal, timeoutMs, body) {
  try {
    return await post(path, signal, timeoutMs, body);
  } catch (error) {
    if (!signal.aborted) emit("error", event, { path, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function cycle(path, event, intervalMs, timeoutMs, signal) {
  let failures = 0;
  let maintenanceBatches = 0;
  while (!signal.aborted) {
    const started = Date.now();
    const result = await safePost(path, `${event}_failed`, signal, timeoutMs);
    const failed = result === null || result.failed > 0 || result.tokenRotation?.failed > 0
      || result.results?.some((row) => row.error || row.ok === false || row.failedTasks > 0 || row.retryTasks > 0);
    if (!signal.aborted) await safePost("/api/jobs/heartbeat", "worker.heartbeat_failed", signal, 10000, {
      job: path.split("/").at(-1), succeeded: !failed, intervalMs, timeoutMs,
    });
    const progressed = result?.succeeded > 0 || result?.delivered > 0;
    failures = failed && !progressed ? failures + 1 : 0;
    if (result && (result.claimed > 0 || !path.includes("/process-"))) {
      emit("info", event, { result });
    }
    if (!signal.aborted) {
      // An HTTP abort does not cancel server work; durable queue/DB leases remain authoritative.
      let waitMs = path.endsWith("/reconcile")
        ? result ? (result.results?.length ? pollMs : Math.min(intervalMs, 60_000)) : intervalMs
        : path.includes("/process-") ? intervalMs : Math.max(pollMs, intervalMs - (Date.now() - started));
      if (path.includes("/process-") && result?.hasMore && progressed) waitMs = 100;
      if (path.endsWith("/maintenance") && result && (result.batchMayHaveMore || result.tokenRotation?.remaining > result.tokenRotation?.failed)) {
        // Keep each HTTP batch bounded and yield periodically while draining retention debt.
        maintenanceBatches = (maintenanceBatches + 1) % 10;
        waitMs = maintenanceBatches ? pollMs : 60_000;
      } else maintenanceBatches = 0;
      if (failures) waitMs = Math.max(waitMs, Math.min(60_000, pollMs * 2 ** Math.min(failures, 6)));
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
}

export async function runScheduler(signal) {
  if (!secret) throw new Error("CRON_SECRET gerekli");
  emit("info", "worker.started", { pollMs, reconcileMs, healthMs, maintenanceMs });
  const jobs = [
    ["process-events", "events", pollMs, longJobTimeoutMs],
    ["process-videos", "videos", pollMs, longJobTimeoutMs],
    ["process-analyses", "analyses", pollMs, Math.max(analysisTimeoutMs, longJobTimeoutMs)],
    ["process-alerts", "alerts", pollMs, longJobTimeoutMs],
    ["reconcile", "reconcile", reconcileMs, longJobTimeoutMs],
    ["check-connections", "connection_health", healthMs, longJobTimeoutMs],
    ["maintenance", "maintenance", maintenanceMs, longJobTimeoutMs],
  ];
  await Promise.all(jobs.map(([path, event, interval, timeout]) => cycle(`/api/jobs/${path}`, `worker.${event}`, interval, timeout, signal)));
  emit("info", "worker.stopped");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await runScheduler(controller.signal);
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
