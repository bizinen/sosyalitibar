import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { analyzeClaimedItem, claimAnalysisJobs, requeueStaleAnalysisLocks } from "@/lib/ingest";
import { mapLimit } from "@/lib/concurrency";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!safeEqual(auth, `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = env();
  const recovered = await requeueStaleAnalysisLocks();
  const jobs = await claimAnalysisJobs(cfg.ANALYSIS_BATCH_SIZE);
  const results = await mapLimit(jobs, cfg.ANALYSIS_CONCURRENCY, (job) => analyzeClaimedItem(job.id, job.lockId));
  return NextResponse.json({ recovered, claimed: jobs.length, succeeded: results.filter((x) => x.processed).length, failed: results.filter((x) => !x.processed).length });
}
