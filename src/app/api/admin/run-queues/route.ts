import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { claimWebhookJobs, processClaimedWebhook, requeueStaleWebhookLocks } from "@/lib/webhook-processing";
import { analyzeClaimedItem, claimAnalysisJobs, requeueStaleAnalysisLocks } from "@/lib/ingest";
import { audit } from "@/lib/audit";
import { claimAlertJobs, processClaimedAlert, requeueStaleAlertLocks } from "@/lib/alerts";

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  await requeueStaleWebhookLocks();
  await requeueStaleAnalysisLocks();
  await requeueStaleAlertLocks();
  const webhooks = await claimWebhookJobs(25);
  for (const job of webhooks) await processClaimedWebhook(job.id, job.lockId);
  const analyses = await claimAnalysisJobs(25);
  for (const job of analyses) await analyzeClaimedItem(job.id, job.lockId);
  const alerts = await claimAlertJobs(25);
  for (const job of alerts) await processClaimedAlert(job.id, job.lockId);
  await audit({ request: req, actor: "admin", action: "queues.manual_run", metadata: { webhooks: webhooks.length, analyses: analyses.length, alerts: alerts.length } });
  return NextResponse.json({ webhooks: webhooks.length, analyses: analyses.length, alerts: alerts.length });
}
