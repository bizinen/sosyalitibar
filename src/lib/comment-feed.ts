import { and, desc, eq, gte, ilike, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { socialAnalyses, socialConnections, socialItems } from "@/db/schema";
import { decodeItemCursor } from "@/lib/cursor";

export type CommentParams = { mode?: string; source?: string; sourceQ?: string; sourceAfter?: string; video?: string; platform?: string; sentiment?: string; category?: string; minSeverity?: string; review?: string; needsReview?: string; q?: string; cursor?: string; connection?: string; target?: string; from?: string; to?: string; analysis?: string; connected?: string; meta_error?: string; view?: string };

export function sourceKey(platform: string, id: string | null) {
  return Buffer.from(JSON.stringify([platform, id]), "utf8").toString("base64url");
}

export function readSourceKey(value?: string) {
  if (!value || value.length > 2048) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(data) || data.length !== 2 || !["youtube", "facebook", "instagram"].includes(data[0])
      || (data[1] !== null && (typeof data[1] !== "string" || !data[1] || data[1].length > 512))) return null;
    return { platform: data[0] as string, id: data[1] as string | null };
  } catch { return null; }
}

export function commentConditions(p: CommentParams) {
  const conditions: SQL[] = [isNull(socialItems.deletedAt)];
  if (p.source) {
    const source = readSourceKey(p.source);
    conditions.push(source ? and(eq(socialItems.platform, source.platform), source.id === null
      ? isNull(socialItems.rootExternalId) : eq(socialItems.rootExternalId, source.id))! : sql`false`);
  }
  if (p.view === "pending") conditions.push(eq(socialItems.reviewStatus, "new"), eq(socialAnalyses.needsReview, true), isNull(socialItems.sourceUnavailableAt));
  if (p.view === "threats") conditions.push(eq(socialAnalyses.containsThreat, true));
  if (p.view === "risk") conditions.push(or(eq(socialAnalyses.triageLabel, "acil_inceleme"), gte(socialAnalyses.severity, 70))!);
  if (p.view === "normal") conditions.push(eq(socialAnalyses.triageLabel, "inceleme_gerekmiyor"));
  if (p.view === "urgent") conditions.push(eq(socialAnalyses.triageLabel, "acil_inceleme"));
  if (p.view === "failed") conditions.push(eq(socialItems.analysisStatus, "dead"));
  if (p.view === "history") conditions.push(eq(socialItems.analysisExcluded, true));
  if (p.view === "unavailable") conditions.push(isNotNull(socialItems.sourceUnavailableAt));
  if (p.view === "human" || p.view === "confirmed") conditions.push(sql`exists (select 1 from item_review_events r where r.item_id = ${socialItems.id}
    and r.analysis_revision = ${socialItems.analysisRevision} and r.assessment is not null
    ${p.view === "confirmed" ? sql`and r.assessment->>'verdict' = 'attack'` : sql``}
    and r.id = (select last_review.id from item_review_events last_review where last_review.item_id = ${socialItems.id} order by last_review.sequence desc limit 1))`);
  if (["facebook", "instagram", "youtube"].includes(p.platform ?? "")) conditions.push(eq(socialItems.platform, p.platform!));
  if (p.video && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.video)) conditions.push(sql`exists (
    select 1 from watched_videos v where v.id = ${p.video}::uuid and v.platform = ${socialItems.platform} and v.external_id = ${socialItems.rootExternalId})`);
  if (["positive", "neutral", "negative"].includes(p.sentiment || "")) conditions.push(eq(socialAnalyses.sentiment, p.sentiment!));
  if (["criticism", "insult", "accusation", "threat", "mockery", "spam", "support", "other"].includes(p.category || "")) conditions.push(eq(socialAnalyses.category, p.category!));
  const minSeverity = Math.max(0, Math.min(100, Number(p.minSeverity || 0) || 0));
  if (minSeverity > 0) conditions.push(gte(socialAnalyses.severity, minSeverity));
  if (["new", "reviewed", "ignored", "escalated"].includes(p.review || "")) conditions.push(eq(socialItems.reviewStatus, p.review!));
  if (p.needsReview === "true") conditions.push(eq(socialAnalyses.needsReview, true));
  if (p.q?.trim()) conditions.push(ilike(socialItems.text, `%${p.q.trim().slice(0, 120)}%`));
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.connection || "")) conditions.push(eq(socialItems.connectionId, p.connection!));
  if (/^youtube:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p.connection ?? "")) {
    conditions.push(sql`exists (select 1 from watched_videos v where v.channel_id = ${p.connection!.slice(8)}::uuid
      and v.platform = ${socialItems.platform} and v.external_id = ${socialItems.rootExternalId})`);
  }
  if (p.target) {
    const assessment = sql`(select r.assessment from item_review_events r where r.item_id = ${socialItems.id}
      and r.analysis_revision = ${socialItems.analysisRevision} order by r.sequence desc limit 1)`;
    conditions.push(p.view === "human" || p.view === "confirmed"
    ? sql`exists (select 1 from item_review_events r where r.item_id = ${socialItems.id}
        and r.analysis_revision = ${socialItems.analysisRevision} and r.assessment->>'matchedTarget' = ${p.target}
        and r.id = (select last_review.id from item_review_events last_review where last_review.item_id = ${socialItems.id} order by last_review.sequence desc limit 1))`
    : sql`case when ${assessment} is not null then ${assessment}->>'matchedTarget' = ${p.target}
      when ${socialAnalyses.triageLabel} is null then ${socialAnalyses.matchedTarget} = ${p.target}
      else coalesce(${socialItems.raw}->>'external_source', 'false') <> 'true' and exists (
        select 1 from connection_targets ct join monitoring_targets mt on mt.id = ct.target_id
        where ct.connection_id = ${socialItems.connectionId} and mt.enabled is true and mt.name = ${p.target}) end`);
  }
  if (["pending", "processing", "retry", "complete", "dead"].includes(p.analysis || "")) conditions.push(eq(socialItems.analysisStatus, p.analysis!));
  for (const [value, end] of [[p.from, false], [p.to, true]] as const) {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) {
        if (end) date.setUTCDate(date.getUTCDate() + 1);
        conditions.push(end ? lt(socialItems.ingestedAt, date) : gte(socialItems.ingestedAt, date));
      }
    }
  }
  const cursor = decodeItemCursor(p.cursor);
  if (cursor) {
    const cursorAt = sql`${cursor.preciseAt ?? cursor.at.toISOString()}::timestamptz`;
    const cursorCondition = or(
      lt(socialItems.ingestedAt, cursorAt),
      and(eq(socialItems.ingestedAt, cursorAt), lt(socialItems.id, cursor.id)),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }
  return conditions;
}

export async function commentRows(p: CommentParams) {
  const conditions = commentConditions(p);
  const parent = alias(socialItems, "parent_item");
  const rows = await db.select({ item: socialItems, analysis: socialAnalyses, connectionName: socialConnections.displayName, parentText: parent.text, cursorAt: sql<string>`to_char(${socialItems.ingestedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(socialItems)
    .leftJoin(socialAnalyses, eq(socialAnalyses.itemId, socialItems.id))
    .leftJoin(socialConnections, eq(socialConnections.id, socialItems.connectionId))
    .leftJoin(parent, and(eq(parent.externalId, socialItems.parentExternalId), eq(parent.platform, socialItems.platform), isNull(parent.deletedAt), isNull(parent.sourceUnavailableAt)))
    .where(and(...conditions))
    .orderBy(desc(socialItems.ingestedAt), desc(socialItems.id))
    .limit(101);
  return rows;
}
