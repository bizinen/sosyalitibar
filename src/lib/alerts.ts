import crypto from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { alertOutbox, socialItems } from "@/db/schema";
import { db, type Transaction } from "@/lib/db";
import { getAlertSettings } from "@/lib/alert-settings";
import { log } from "@/lib/log";
import type { Analysis } from "@/lib/llm";
import type { TriageLabel } from "@/lib/triage-contract";
import { signAlertPayload } from "@/lib/alert-signature";

const ALERT_RULE_VERSION = "critical-v1";
const MAX_ATTEMPTS = 6;


type AlertSourceItem = {
  id: string;
  analysisRevision: number;
  platform: string;
  externalId: string;
  itemType: string;
  authorName: string | null;
  text: string;
  permalink: string | null;
  sourceCreatedAt: Date | null;
};

function alertReason(a: Analysis, threshold: number, onThreat: boolean): string | null {
  if (!a.target_match) return null;
  if (onThreat && a.contains_threat) return "threat";
  if (a.severity >= threshold) return `severity_gte_${threshold}`;
  return null;
}

/**
 * Durable outbox enqueue. Notification delivery never blocks Meta webhook handling
 * and is idempotent per item + analyzed text hash + rule version.
 */
export async function enqueueAlertIfNeeded(item: AlertSourceItem, analysis: Analysis | { label: TriageLabel }, inputHash: string, tx: Transaction) {
  const cfg = await getAlertSettings(tx);
  const reason = "label" in analysis ? analysis.label === "acil_inceleme" ? "acil_inceleme" : null : alertReason(analysis, cfg.ALERT_SEVERITY_THRESHOLD, cfg.ALERT_ON_THREAT);
  const rule = "label" in analysis ? "triage-v1" : ALERT_RULE_VERSION;
  if (!reason) return { queued: false as const, reason: "below_threshold" };

  const dedupeKey = crypto
    .createHash("sha256")
    .update(`${rule}:${item.id}:${item.analysisRevision}:${inputHash}:${reason}`)
    .digest("hex");
  const payload = {
    event: "social_reputation.alert",
    version: "label" in analysis ? 2 : 1,
    rule,
    reason,
    source_revision: item.analysisRevision,
    item: {
      id: item.id,
      platform: item.platform,
      external_id: item.externalId,
      type: item.itemType,
      author_name: item.authorName,
      text: item.text.slice(0, 1200),
      permalink: item.permalink,
      source_created_at: item.sourceCreatedAt?.toISOString() ?? null,
    },
    analysis: "label" in analysis ? { label: analysis.label, needs_review: true } : {
      target_match: analysis.target_match,
      target_confidence: analysis.target_confidence,
      matched_target: analysis.matched_target,
      sentiment: analysis.sentiment,
      category: analysis.category,
      severity: analysis.severity,
      contains_insult: analysis.contains_insult,
      contains_threat: analysis.contains_threat,
      contains_claim: analysis.contains_claim,
      claim_text: analysis.claim_text,
      needs_review: analysis.needs_review,
      summary: analysis.summary,
    },
    created_at: new Date().toISOString(),
  } satisfies Record<string, unknown>;

  const [created] = await tx.insert(alertOutbox).values({
    itemId: item.id,
    analysisRevision: item.analysisRevision,
    dedupeKey,
    ruleKey: rule,
    receiverKey: cfg.alertEndpoint ? crypto.createHash("sha256").update(cfg.alertEndpoint).digest("hex") : null,
    payload,
  }).onConflictDoNothing({ target: alertOutbox.dedupeKey }).returning({ id: alertOutbox.id });

  return created ? { queued: true as const, id: created.id } : { queued: false as const, reason: "duplicate" };
}

export async function claimAlertJobs(limit = 20): Promise<Array<{ id: string; lockId: string }>> {
  const now = new Date();
  const candidates = await db.select({ id: alertOutbox.id }).from(alertOutbox).where(and(
    inArray(alertOutbox.status, ["pending", "retry"]),
    lte(alertOutbox.availableAt, now),
  )).orderBy(asc(alertOutbox.availableAt), asc(alertOutbox.createdAt)).limit(Math.max(1, Math.min(limit * 2, 200)));

  const claimed: Array<{ id: string; lockId: string }> = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    const lockId = crypto.randomUUID();
    const [row] = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('sosyal_itibar_alert_settings'))`);
      const cfg = await getAlertSettings(tx);
      if (!cfg.ALERT_WEBHOOK_URL || !cfg.ALERT_WEBHOOK_SECRET) return [];
      return tx.update(alertOutbox).set({
      status: "processing",
      lockedAt: now,
      dispatchStartedAt: null,
      lockId,
      updatedAt: now,
    }).where(and(
      eq(alertOutbox.id, candidate.id),
      inArray(alertOutbox.status, ["pending", "retry"]),
      lte(alertOutbox.availableAt, now),
    )).returning({ id: alertOutbox.id });
    });
    if (row) claimed.push({ id: row.id, lockId });
  }
  return claimed;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export async function processClaimedAlert(id: string, lockId: string) {
  const row = await db.query.alertOutbox.findFirst({
    where: and(eq(alertOutbox.id, id), eq(alertOutbox.status, "processing"), eq(alertOutbox.lockId, lockId)),
  });
  if (!row) return { delivered: false as const, reason: "lost_lock" };

  const sourceItem = await db.query.socialItems.findFirst({ where: eq(socialItems.id, row.itemId) });
  if (!sourceItem || sourceItem.deletedAt || sourceItem.sourceUnavailableAt || sourceItem.analysisRevision !== row.analysisRevision || sourceItem.analysisStatus !== "complete") {
    const cancelled = await db.update(alertOutbox).set({
      status: "cancelled",
      lockedAt: null,
      lockId: null,
      lastError: "source item deleted or superseded before delivery",
      updatedAt: new Date(),
    }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId), eq(alertOutbox.status, "processing"), isNull(alertOutbox.dispatchStartedAt)))
      .returning({ id: alertOutbox.id });
    if (!cancelled.length) return { delivered: false as const, reason: "lost_lock" };
    return { delivered: false as const, reason: "cancelled" };
  }

  const cfg = await getAlertSettings();
  if (!cfg.ALERT_WEBHOOK_URL || !cfg.ALERT_WEBHOOK_SECRET) {
    const changed = await db.update(alertOutbox).set({
      status: "dead",
      lastError: "alert webhook configuration missing",
      lockedAt: null,
      lockId: null,
      updatedAt: new Date(),
    }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId), eq(alertOutbox.status, "processing"), isNull(alertOutbox.dispatchStartedAt)))
      .returning({ id: alertOutbox.id });
    if (!changed.length) return { delivered: false as const, reason: "lost_lock" };
    return { delivered: false as const, reason: "configuration_missing" };
  }

  const body = JSON.stringify({ ...row.payload, delivery_id: row.id });
  const receiverKey = crypto.createHash("sha256").update(cfg.ALERT_WEBHOOK_URL).digest("hex");
  if (row.receiverKey && row.receiverKey !== receiverKey) {
    await db.update(alertOutbox).set({ status: "dead", lockedAt: null, lockId: null,
      lastError: "Alarm alıcısı değişti; önceki teslimat sonucu belirsiz olabileceği için başka alıcıya otomatik gönderilmedi.", updatedAt: new Date(),
    }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId), eq(alertOutbox.status, "processing"), isNull(alertOutbox.dispatchStartedAt)));
    return { delivered: false as const, reason: "receiver_changed" };
  }
  const signature = signAlertPayload(body, cfg.ALERT_WEBHOOK_SECRET);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let status: number | null = null;
  let thrown: unknown = null;
  let retryAfterMs = 0;

  try {
    const accepted = await db.transaction(async (tx) => {
      const [source] = await tx.select().from(socialItems).where(eq(socialItems.id, row.itemId)).for("share");
      const [owned] = await tx.select().from(alertOutbox).where(and(
        eq(alertOutbox.id, id), eq(alertOutbox.status, "processing"), eq(alertOutbox.lockId, lockId), isNull(alertOutbox.dispatchStartedAt),
      )).for("update");
      if (!owned) return false;
      if (!source || source.deletedAt || source.sourceUnavailableAt || source.analysisRevision !== row.analysisRevision || source.analysisStatus !== "complete") {
        await tx.update(alertOutbox).set({ status: "cancelled", lockedAt: null, lockId: null,
          lastError: "source item deleted or superseded before dispatch", updatedAt: new Date(),
        }).where(eq(alertOutbox.id, id));
        return false;
      }
      await tx.update(alertOutbox).set({ dispatchStartedAt: new Date(), receiverKey, updatedAt: new Date() }).where(eq(alertOutbox.id, id));
      return true;
    });
    if (!accepted) return { delivered: false as const, reason: "lost_lock" };
    const response = await fetch(cfg.ALERT_WEBHOOK_URL, {
      method: "POST",
      signal: controller.signal,
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "user-agent": "sosyal-itibar-alerts/1",
        "x-sosyal-itibar-event": "social_reputation.alert",
        "x-sosyal-itibar-delivery": row.id,
        "x-sosyal-itibar-signature-256": signature,
        "idempotency-key": row.dedupeKey,
      },
      body,
    });
    status = response.status;
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const delay = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(delay)) retryAfterMs = Math.max(0, Math.min(4 * 60 * 60 * 1000, delay));
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) {
      const delivered = await db.update(alertOutbox).set({
        status: "delivered",
        attempts: row.attempts + 1,
        deliveredAt: new Date(),
        lockedAt: null,
        lockId: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId), eq(alertOutbox.status, "processing"))).returning({ id: alertOutbox.id });
      if (!delivered.length) return { delivered: false as const, reason: "lost_lock", status };
      return { delivered: true as const, status };
    }
  } catch (error) {
    thrown = error;
  } finally {
    clearTimeout(timer);
  }

  const attempts = row.attempts + 1;
  const retryable = thrown !== null || (status !== null && retryableStatus(status));
  const dead = !retryable || attempts >= MAX_ATTEMPTS;
  const delayMs = Math.min(4 * 60 * 60 * 1000, Math.max(retryAfterMs, 30_000 * 2 ** Math.max(0, attempts - 1) * (1 + Math.random() * 0.2)));
  const errorMessage = thrown !== null
    ? "alert network request failed or timed out"
    : `HTTP ${status ?? "unknown"}`;

  const updated = await db.update(alertOutbox).set({
    status: dead ? "dead" : "retry",
    dispatchStartedAt: null,
    attempts,
    availableAt: dead ? new Date() : new Date(Date.now() + delayMs),
    lockedAt: null,
    lockId: null,
    lastError: errorMessage,
    updatedAt: new Date(),
  }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId), eq(alertOutbox.status, "processing"))).returning({ id: alertOutbox.id });
  if (!updated.length) return { delivered: false as const, reason: "lost_lock", status };
  log.warn("alert.delivery_failed", { id, attempts, dead, status, message: errorMessage });
  return { delivered: false as const, reason: dead ? "dead" : "retry", status };
}

export async function requeueStaleAlertLocks(maxAgeMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const rows = await db.update(alertOutbox).set({
    status: "retry",
    dispatchStartedAt: null,
    lockedAt: null,
    lockId: null,
    availableAt: new Date(),
    lastError: "stale alert lock recovered",
    updatedAt: new Date(),
  }).where(and(eq(alertOutbox.status, "processing"), lte(alertOutbox.lockedAt, cutoff))).returning({ id: alertOutbox.id });
  return rows.length;
}
