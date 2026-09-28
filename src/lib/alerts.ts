import crypto from "node:crypto";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { alertOutbox, socialItems } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/config";
import { log } from "@/lib/log";
import type { Analysis } from "@/lib/llm";
import { signAlertPayload } from "@/lib/alert-signature";

const ALERT_RULE_VERSION = "critical-v1";
const MAX_ATTEMPTS = 6;


type AlertSourceItem = {
  id: string;
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
export async function enqueueAlertIfNeeded(item: AlertSourceItem, analysis: Analysis, inputHash: string) {
  const cfg = env();
  if (!cfg.ALERT_WEBHOOK_URL) return { queued: false as const, reason: "not_configured" };
  const reason = alertReason(analysis, cfg.ALERT_SEVERITY_THRESHOLD, cfg.ALERT_ON_THREAT);
  if (!reason) return { queued: false as const, reason: "below_threshold" };

  const dedupeKey = crypto
    .createHash("sha256")
    .update(`${ALERT_RULE_VERSION}:${item.id}:${inputHash}:${reason}`)
    .digest("hex");
  const payload = {
    event: "social_reputation.alert",
    version: 1,
    rule: ALERT_RULE_VERSION,
    reason,
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
    analysis: {
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

  const [created] = await db.insert(alertOutbox).values({
    itemId: item.id,
    dedupeKey,
    ruleKey: ALERT_RULE_VERSION,
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
    const [row] = await db.update(alertOutbox).set({
      status: "processing",
      lockedAt: now,
      lockId,
      updatedAt: now,
    }).where(and(
      eq(alertOutbox.id, candidate.id),
      inArray(alertOutbox.status, ["pending", "retry"]),
      lte(alertOutbox.availableAt, now),
    )).returning({ id: alertOutbox.id });
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
  if (!sourceItem || sourceItem.deletedAt) {
    await db.update(alertOutbox).set({
      status: "cancelled",
      lockedAt: null,
      lockId: null,
      lastError: "source item deleted before delivery",
      updatedAt: new Date(),
    }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId)));
    return { delivered: false as const, reason: "cancelled" };
  }

  const cfg = env();
  if (!cfg.ALERT_WEBHOOK_URL || !cfg.ALERT_WEBHOOK_SECRET) {
    await db.update(alertOutbox).set({
      status: "dead",
      lastError: "alert webhook configuration missing",
      lockedAt: null,
      lockId: null,
      updatedAt: new Date(),
    }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId)));
    return { delivered: false as const, reason: "configuration_missing" };
  }

  const body = JSON.stringify({ ...row.payload, delivery_id: row.id });
  const signature = signAlertPayload(body, cfg.ALERT_WEBHOOK_SECRET);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let status: number | null = null;
  let responseText = "";
  let thrown: unknown = null;

  try {
    const response = await fetch(cfg.ALERT_WEBHOOK_URL, {
      method: "POST",
      signal: controller.signal,
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
    responseText = (await response.text()).slice(0, 500);
    if (response.ok) {
      await db.update(alertOutbox).set({
        status: "delivered",
        attempts: row.attempts + 1,
        deliveredAt: new Date(),
        lockedAt: null,
        lockId: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId)));
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
  const delayMs = Math.min(4 * 60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));
  const errorMessage = thrown instanceof Error
    ? thrown.message.slice(0, 1000)
    : `HTTP ${status ?? "unknown"}${responseText ? `: ${responseText}` : ""}`.slice(0, 1000);

  await db.update(alertOutbox).set({
    status: dead ? "dead" : "retry",
    attempts,
    availableAt: dead ? new Date() : new Date(Date.now() + delayMs),
    lockedAt: null,
    lockId: null,
    lastError: errorMessage,
    updatedAt: new Date(),
  }).where(and(eq(alertOutbox.id, id), eq(alertOutbox.lockId, lockId)));
  log.warn("alert.delivery_failed", { id, attempts, dead, status, message: errorMessage });
  return { delivered: false as const, reason: dead ? "dead" : "retry", status };
}

export async function requeueStaleAlertLocks(maxAgeMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const rows = await db.update(alertOutbox).set({
    status: "retry",
    lockedAt: null,
    lockId: null,
    availableAt: new Date(),
    lastError: "stale alert lock recovered",
    updatedAt: new Date(),
  }).where(and(eq(alertOutbox.status, "processing"), lte(alertOutbox.lockedAt, cutoff))).returning({ id: alertOutbox.id });
  return rows.length;
}
