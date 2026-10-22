import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { alertOutbox, socialAnalyses, socialConnections, socialItems, webhookEvents, workerHeartbeats } from "@/db/schema";
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { safeEqual } from "@/lib/security";
import { WORKER_JOBS } from "@/lib/worker-health";

function metric(name: string, value: number, labels?: Record<string, string>) {
  const labelText = labels && Object.keys(labels).length
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`
    : "";
  return `${name}${labelText} ${Number.isFinite(value) ? value : 0}`;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!safeEqual(auth, `Bearer ${env().CRON_SECRET}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const [webhookStatuses, analysisStatuses, alertStatuses, connectionStatuses, totals, latency, oldestWebhook, oldestAnalysis, oldestAlert, syncLease, heartbeats] = await Promise.all([
    db.select({ status: webhookEvents.status, count: sql<number>`count(*)::int` }).from(webhookEvents).groupBy(webhookEvents.status),
    db.select({ status: socialItems.analysisStatus, count: sql<number>`count(*)::int` }).from(socialItems).groupBy(socialItems.analysisStatus),
    db.select({ status: alertOutbox.status, count: sql<number>`count(*)::int` }).from(alertOutbox).groupBy(alertOutbox.status),
    db.select({ platform: socialConnections.platform, status: socialConnections.status, count: sql<number>`count(*)::int` }).from(socialConnections).groupBy(socialConnections.platform, socialConnections.status),
    db.select({
      items: sql<number>`count(*)::int`,
      negative: sql<number>`count(*) filter (where ${socialAnalyses.sentiment} = 'negative')::int`,
      critical: sql<number>`count(*) filter (where ${socialAnalyses.severity} >= 70 or ${socialAnalyses.triageLabel} = 'acil_inceleme')::int`,
    }).from(socialItems).leftJoin(socialAnalyses, eq(socialAnalyses.itemId, socialItems.id)),
    db.select({ avgMs: sql<number>`coalesce(avg(${socialAnalyses.latencyMs}), 0)::float8`, p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${socialAnalyses.latencyMs}), 0)::float8` }).from(socialAnalyses),
    db.select({ seconds: sql<number>`greatest(coalesce(extract(epoch from (now() - min(${webhookEvents.availableAt}) filter (where ${webhookEvents.status} in ('pending','retry') and ${webhookEvents.availableAt} <= now()))), 0), 0)::float8` }).from(webhookEvents),
    db.select({ seconds: sql<number>`greatest(coalesce(extract(epoch from (now() - min(${socialItems.analysisAvailableAt}) filter (where ${socialItems.analysisStatus} in ('pending','retry') and ${socialItems.analysisAvailableAt} <= now()))), 0), 0)::float8` }).from(socialItems),
    db.select({ seconds: sql<number>`greatest(coalesce(extract(epoch from (now() - min(${alertOutbox.availableAt}) filter (where ${alertOutbox.status} in ('pending','retry') and ${alertOutbox.availableAt} <= now()))), 0), 0)::float8` }).from(alertOutbox),
    db.select({
      active: sql<number>`count(*) filter (where ${socialConnections.syncLockedAt} is not null)::int`,
      oldestSeconds: sql<number>`greatest(coalesce(extract(epoch from (now() - min(${socialConnections.syncLockedAt}) filter (where ${socialConnections.syncLockedAt} is not null))), 0), 0)::float8`,
    }).from(socialConnections),
    db.select().from(workerHeartbeats),
  ]);

  const lines = [
    "# HELP sosyal_itibar_worker_stale Worker job has no recent completed attempt, including empty queues.",
    "# TYPE sosyal_itibar_worker_stale gauge",
    ...WORKER_JOBS.map((job) => { const heartbeat = heartbeats.find((row) => row.job === job); return metric("sosyal_itibar_worker_stale", !heartbeat || Date.now() - heartbeat.lastAttemptAt.getTime() > heartbeat.staleAfterMs ? 1 : 0, { job }); }),
    "# HELP sosyal_itibar_worker_last_success_timestamp_seconds Last successful HTTP job execution; not proof of provider delivery.",
    "# TYPE sosyal_itibar_worker_last_success_timestamp_seconds gauge",
    ...WORKER_JOBS.map((job) => metric("sosyal_itibar_worker_last_success_timestamp_seconds", (heartbeats.find((row) => row.job === job)?.lastSuccessAt?.getTime() ?? 0) / 1000, { job })),
    "# HELP sosyal_itibar_worker_last_attempt_failed Last job HTTP attempt failed or job never reported.",
    "# TYPE sosyal_itibar_worker_last_attempt_failed gauge",
    ...WORKER_JOBS.map((job) => metric("sosyal_itibar_worker_last_attempt_failed", heartbeats.find((row) => row.job === job)?.lastSucceeded ? 0 : 1, { job })),
    "# HELP sosyal_itibar_social_items_total Total ingested social items.",
    "# TYPE sosyal_itibar_social_items_total gauge",
    metric("sosyal_itibar_social_items_total", totals[0]?.items ?? 0),
    "# HELP sosyal_itibar_negative_items_total Items currently classified negative.",
    "# TYPE sosyal_itibar_negative_items_total gauge",
    metric("sosyal_itibar_negative_items_total", totals[0]?.negative ?? 0),
    "# HELP sosyal_itibar_critical_items_total Items with urgent triage label or legacy severity >= 70.",
    "# TYPE sosyal_itibar_critical_items_total gauge",
    metric("sosyal_itibar_critical_items_total", totals[0]?.critical ?? 0),
    "# HELP sosyal_itibar_llm_latency_ms LLM analysis latency in milliseconds.",
    "# TYPE sosyal_itibar_llm_latency_ms gauge",
    metric("sosyal_itibar_llm_latency_ms", latency[0]?.avgMs ?? 0, { quantile: "avg" }),
    metric("sosyal_itibar_llm_latency_ms", latency[0]?.p95Ms ?? 0, { quantile: "p95" }),
    "# HELP sosyal_itibar_queue_items Queue items by pipeline and status.",
    "# TYPE sosyal_itibar_queue_items gauge",
    ...webhookStatuses.map((x) => metric("sosyal_itibar_queue_items", x.count, { queue: "webhook", status: x.status })),
    ...analysisStatuses.map((x) => metric("sosyal_itibar_queue_items", x.count, { queue: "analysis", status: x.status })),
    ...alertStatuses.map((x) => metric("sosyal_itibar_queue_items", x.count, { queue: "alert", status: x.status })),
    "# HELP sosyal_itibar_queue_oldest_age_seconds Age of the oldest runnable pending/retry job.",
    "# TYPE sosyal_itibar_queue_oldest_age_seconds gauge",
    metric("sosyal_itibar_queue_oldest_age_seconds", oldestWebhook[0]?.seconds ?? 0, { queue: "webhook" }),
    metric("sosyal_itibar_queue_oldest_age_seconds", oldestAnalysis[0]?.seconds ?? 0, { queue: "analysis" }),
    metric("sosyal_itibar_queue_oldest_age_seconds", oldestAlert[0]?.seconds ?? 0, { queue: "alert" }),
    "# HELP sosyal_itibar_connections Connections by platform and health status.",
    "# TYPE sosyal_itibar_connections gauge",
    ...connectionStatuses.map((x) => metric("sosyal_itibar_connections", x.count, { platform: x.platform, status: x.status })),
    "# HELP sosyal_itibar_sync_leases Active reconciliation leases and age of the oldest lease.",
    "# TYPE sosyal_itibar_sync_leases gauge",
    metric("sosyal_itibar_sync_leases", syncLease[0]?.active ?? 0, { metric: "active" }),
    metric("sosyal_itibar_sync_leases", syncLease[0]?.oldestSeconds ?? 0, { metric: "oldest_age_seconds" }),
  ];

  return new NextResponse(`${lines.join("\n")}\n`, {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
