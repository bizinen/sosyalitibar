import { NextResponse } from "next/server";
import { env, llmConfigured } from "@/lib/config";
import { getLlmSettings } from "@/lib/llm-settings";
import { safeEqual } from "@/lib/security";
import { processAnalysisJobs, claimAnalysisJobs, requeueStaleAnalysisLocks } from "@/lib/ingest";
import { analysisProviderKey } from "@/lib/batch-triage";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!safeEqual(auth, `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getLlmSettings();
  if (!llmConfigured(cfg)) return NextResponse.json({ error: "llm_not_configured" }, { status: 503 });
  const recovered = await requeueStaleAnalysisLocks();
  const jobs = await claimAnalysisJobs(cfg.policy.batchSize, analysisProviderKey(cfg));
  const results = await processAnalysisJobs(jobs, cfg);
  return NextResponse.json({ recovered, claimed: jobs.length, hasMore: jobs.length === cfg.policy.batchSize, succeeded: results.filter((x) => x.processed).length, failed: results.filter((x) => !x.processed).length });
}
