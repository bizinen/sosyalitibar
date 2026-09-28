const base = (process.env.APP_INTERNAL_URL || process.env.APP_URL || "http://app:3000").replace(/\/$/, "");
const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("CRON_SECRET gerekli");

const pollMs = Math.max(2000, Number(process.env.WORKER_POLL_MS || 5000));
const reconcileMs = Math.max(60_000, Number(process.env.RECONCILE_INTERVAL_MS || 15 * 60_000));
const healthMs = Math.max(5 * 60_000, Number(process.env.HEALTH_CHECK_INTERVAL_MS || 6 * 60 * 60_000));
const maintenanceMs = Math.max(60 * 60_000, Number(process.env.MAINTENANCE_INTERVAL_MS || 24 * 60 * 60_000));
let stopping = false;
let lastReconcile = 0;
let lastHealth = 0;
let lastMaintenance = 0;

function emit(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function post(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${secret}`, "user-agent": "sosyal-itibar-worker/1" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function safePost(path, event) {
  try {
    return await post(path);
  } catch (error) {
    emit("error", event, { path, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function cycle() {
  const events = await safePost("/api/jobs/process-events", "worker.events_failed");
  const analyses = await safePost("/api/jobs/process-analyses", "worker.analyses_failed");
  const alerts = await safePost("/api/jobs/process-alerts", "worker.alerts_failed");
  if ((events?.claimed || 0) + (analyses?.claimed || 0) + (alerts?.claimed || 0) > 0) {
    emit("info", "worker.cycle", { events, analyses, alerts });
  }

  const now = Date.now();
  if (now - lastReconcile >= reconcileMs) {
    // Record attempt time before network call so a persistent Meta failure does not hammer every poll cycle.
    lastReconcile = now;
    const reconcile = await safePost("/api/jobs/reconcile", "worker.reconcile_failed");
    if (reconcile) emit("info", "worker.reconcile", { resultCount: reconcile.results?.length || 0 });
  }
  if (now - lastHealth >= healthMs) {
    lastHealth = now;
    const health = await safePost("/api/jobs/check-connections", "worker.connection_health_failed");
    if (health) emit("info", "worker.connection_health", { resultCount: health.results?.length || 0 });
  }
  if (now - lastMaintenance >= maintenanceMs) {
    lastMaintenance = now;
    const maintenance = await safePost("/api/jobs/maintenance", "worker.maintenance_failed");
    if (maintenance) emit("info", "worker.maintenance", { maintenance });
  }
}

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
emit("info", "worker.started", { pollMs, reconcileMs, healthMs, maintenanceMs });
while (!stopping) {
  await cycle();
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
emit("info", "worker.stopped");
