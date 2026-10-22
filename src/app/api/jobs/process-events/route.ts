import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { claimWebhookJobs, processClaimedWebhook, requeueStaleWebhookLocks } from "@/lib/webhook-processing";
import { mapLimit } from "@/lib/concurrency";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!safeEqual(auth, `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const recovered = await requeueStaleWebhookLocks();
  const cfg = env();
  const limit = Math.min(cfg.WEBHOOK_BATCH_SIZE, cfg.WEBHOOK_CONCURRENCY);
  const jobs = await claimWebhookJobs(limit);
  const results = await mapLimit(jobs, cfg.WEBHOOK_CONCURRENCY, (job) => processClaimedWebhook(job.id, job.lockId));
  return NextResponse.json({ recovered, claimed: jobs.length, hasMore: jobs.length === limit, succeeded: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length });
}
