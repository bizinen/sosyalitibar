import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { claimAlertJobs, processClaimedAlert, requeueStaleAlertLocks } from "@/lib/alerts";
import { mapLimit } from "@/lib/concurrency";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const cfg = env();
  if (!safeEqual(auth, `Bearer ${cfg.CRON_SECRET}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const recovered = await requeueStaleAlertLocks();
  const jobs = await claimAlertJobs(cfg.ALERT_BATCH_SIZE);
  const results = await mapLimit(jobs, cfg.ALERT_CONCURRENCY, (job) => processClaimedAlert(job.id, job.lockId));
  return NextResponse.json({
    recovered,
    claimed: jobs.length,
    delivered: results.filter((x) => x.delivered).length,
    failed: results.filter((x) => !x.delivered).length,
  });
}
