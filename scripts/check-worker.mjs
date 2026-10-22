const base = (process.env.APP_INTERNAL_URL || process.env.APP_URL || "http://app:3000").replace(/\/$/, "");
try {
  if (!process.env.CRON_SECRET) throw new Error("missing configuration");
  const response = await fetch(`${base}/api/metrics`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("metrics unavailable");
  const rows = (await response.text()).split("\n").filter(line => line.startsWith("sosyal_itibar_worker_stale{"));
  if (!rows.length || rows.some(line => !line.endsWith(" 0"))) throw new Error("stale heartbeat");
  console.log(JSON.stringify({ workerHeartbeat: "ok", jobs: rows.length }));
} catch {
  console.error(JSON.stringify({ workerHeartbeat: "unavailable_or_stale" }));
  process.exitCode = 1;
}
