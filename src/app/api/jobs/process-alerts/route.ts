import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { getAlertSettings } from "@/lib/alert-settings";
import { safeEqual } from "@/lib/security";
import { claimAlertJobs, processClaimedAlert, requeueStaleAlertLocks } from "@/lib/alerts";
import { mapLimit } from "@/lib/concurrency";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!safeEqual(auth, `Bearer ${env().CRON_SECRET}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const cfg = await getAlertSettings();
  if (!cfg.ALERT_WEBHOOK_URL || !cfg.ALERT_WEBHOOK_SECRET) return NextResponse.json({ error: "alert_not_configured" }, { status: 503 });
  const recovered = await requeueStaleAlertLocks();
  const limit = Math.min(cfg.ALERT_BATCH_SIZE, cfg.ALERT_CONCURRENCY);
  const jobs = await claimAlertJobs(limit);
  const results = await mapLimit(jobs, cfg.ALERT_CONCURRENCY, (job) => processClaimedAlert(job.id, job.lockId));
  return NextResponse.json({
    recovered,
    claimed: jobs.length,
    hasMore: jobs.length === limit,
    delivered: results.filter((x) => x.delivered).length,
    failed: results.filter((x) => !x.delivered).length,
  });
}
