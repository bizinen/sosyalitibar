import { NextResponse } from "next/server";
import { llmConfigured } from "@/lib/config";
import { getLlmSettings } from "@/lib/llm-settings";
import { getAlertSettings } from "@/lib/alert-settings";
import { mapLimit } from "@/lib/concurrency";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { claimWebhookJobs, processClaimedWebhook, requeueStaleWebhookLocks } from "@/lib/webhook-processing";
import { processAnalysisJobs, claimAnalysisJobs, requeueStaleAnalysisLocks } from "@/lib/ingest";
import { audit } from "@/lib/audit";
import { claimAlertJobs, processClaimedAlert, requeueStaleAlertLocks } from "@/lib/alerts";
import { analysisProviderKey } from "@/lib/batch-triage";

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  await requeueStaleWebhookLocks();
  await requeueStaleAnalysisLocks();
  await requeueStaleAlertLocks();
  const cfg = await getLlmSettings();
  const webhooks = await claimWebhookJobs(Math.min(cfg.WEBHOOK_BATCH_SIZE, cfg.WEBHOOK_CONCURRENCY));
  const webhookResults = await mapLimit(webhooks, cfg.WEBHOOK_CONCURRENCY, (job) => processClaimedWebhook(job.id, job.lockId));
  const analysisConfigured = llmConfigured(cfg);
  const analyses = analysisConfigured ? await claimAnalysisJobs(cfg.policy.batchSize, analysisProviderKey(cfg)) : [];
  const analysisResults = await processAnalysisJobs(analyses, cfg);
  const alertCfg = await getAlertSettings();
  const alertConfigured = Boolean(alertCfg.ALERT_WEBHOOK_URL && alertCfg.ALERT_WEBHOOK_SECRET);
  const alerts = alertConfigured ? await claimAlertJobs(Math.min(cfg.ALERT_BATCH_SIZE, cfg.ALERT_CONCURRENCY)) : [];
  const alertResults = await mapLimit(alerts, cfg.ALERT_CONCURRENCY, (job) => processClaimedAlert(job.id, job.lockId));
  await audit({ request: req, actor: "admin", action: "queues.manual_run", metadata: { webhooks: webhooks.length, analyses: analyses.length, alerts: alerts.length } });
  return NextResponse.json({ webhooks: webhooks.length, analyses: analyses.length, alerts: alerts.length,
    analysisBlocked: !analysisConfigured,
    alertBlocked: !alertConfigured,
    failed: { webhooks: webhookResults.filter((x) => !x.ok).length, analyses: analysisResults.filter((x) => !x.processed).length, alerts: alertResults.filter((x) => !x.delivered).length },
  });
}
