import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { commentDisplay } from "@/lib/comment-display";
import { readSourceKey, sourceKey, type CommentParams } from "@/lib/comment-feed";
import type { SourceScan } from "@/lib/source-scan";
import { env } from "@/lib/config";

export type SourceWatch = { id: string; revision: number; status: string; provider: string; channelPaused: boolean; running: boolean; continuing: boolean };

export const sourceSortOptions = [{ value: "recent", label: "Son yorum: en yeni" }, { value: "oldest", label: "Son yorum: en eski" },
  { value: "comments", label: "En çok yorum alınan" }, { value: "pending", label: "İnceleme bekleyen önce" }, { value: "risk", label: "Yüksek öncelik önce" }] as const;
export const sourceFilterOptions = [{ value: "", label: "Tüm paylaşımlar" }, { value: "pending", label: "İnceleme bekleyen" },
  { value: "risk", label: "Yüksek öncelikli" }, { value: "empty", label: "Henüz yorum alınmayan" }] as const;

type SourceRow = {
  platform: string; source_id: string | null; title: string | null; channel: string | null;
  permalink: string | null; comments: number; pending: number; risk: number;
  latest_at: string; cursor_at: string; total: number; sort_metric: number;
  scan: SourceScan | null;
  watch: SourceWatch | null; connection_id: string | null;
};

export async function commentSources(p: CommentParams, selected = false) {
  const cfg = env();
  const sort = sourceSortOptions.find(option => option.value === p.sourceSort)?.value ?? "recent";
  const filter = selected ? "" : sourceFilterOptions.find(option => option.value === p.sourceFilter)?.value ?? "";
  const source = selected ? readSourceKey(p.source) : null;
  if (selected && !source) return { rows: [], next: null, total: 0, sort, filter };
  const platform = source?.platform ?? (["youtube", "instagram", "facebook"].includes(p.platform ?? "") ? p.platform : null);
  const connection = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.connection ?? "") ? p.connection : null;
  const youtubeChannel = /^youtube:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p.connection ?? "") ? p.connection!.slice(8) : null;
  const query = selected ? "" : p.sourceQ?.trim().slice(0, 120) ?? "";
  const scope = createHash("sha256").update(JSON.stringify([sort, filter, platform, connection, youtubeChannel, query])).digest("hex");
  const metric = sort === "comments" ? sql`comments` : sort === "pending" ? sql`pending` : sort === "risk" ? sql`risk` : sql`0::int`;
  const direction = sort === "oldest" ? sql`asc` : sql`desc`;
  let after: { at: string; platform: string; id: string; metric: number } | null = null;
  if (!selected && p.sourceAfter && p.sourceAfter.length <= 2048) {
    try {
      const value = JSON.parse(Buffer.from(p.sourceAfter, "base64url").toString("utf8"));
      if (value.scope === scope && Number.isInteger(value.metric) && value.metric >= 0 && value.metric <= 2147483647
        && (!["recent", "oldest"].includes(sort) || value.metric === 0)
        && typeof value.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at)
        && Number.isFinite(Date.parse(value.at)) && new Date(value.at).toISOString() === value.at.replace(/(\.\d{3})\d{3}Z$/, "$1Z")
        && ["youtube", "instagram", "facebook"].includes(value.platform)
        && typeof value.id === "string" && value.id.length <= 512) after = value;
    } catch { /* An invalid page cursor returns the first page. */ }
  }
  const result = await db.execute<SourceRow>(sql`
    with grouped as (
      select i.platform, i.root_external_id as source_id, count(*)::int as comments,
        count(*) filter (where i.review_status = 'new' and a.needs_review is true and i.source_unavailable_at is null)::int as pending,
        count(*) filter (where a.severity >= 70 or a.triage_label = 'acil_inceleme')::int as risk,
        max(i.ingested_at) as latest_at
      from social_items i left join social_analyses a on a.item_id = i.id
      where i.deleted_at is null
        ${platform ? sql`and i.platform = ${platform}` : sql``}
        ${connection ? sql`and i.connection_id = ${connection}::uuid` : sql``}
        ${youtubeChannel ? sql`and exists (select 1 from watched_videos w where w.channel_id = ${youtubeChannel}::uuid and w.platform = i.platform and w.external_id = i.root_external_id)` : sql``}
        ${source ? source.id === null ? sql`and i.root_external_id is null` : sql`and i.root_external_id = ${source.id}` : sql``}
      group by i.platform, i.root_external_id
    ), sources as (
      select coalesce(g.platform, v.platform) as platform, coalesce(g.source_id, v.external_id) as source_id,
        coalesce(nullif(v.title, ''), nullif(m.raw->'source_post'->>'text', '')) as title,
        coalesce(nullif(v.channel_name, ''), nullif(m.raw->>'source_channel', ''), c.display_name) as channel,
        coalesce(v.url, m.raw->'source_post'->>'permalink', m.raw->'source_post'->>'permalink_url') as permalink,
        coalesce(g.comments, 0) as comments, coalesce(g.pending, 0) as pending, coalesce(g.risk, 0) as risk,
        coalesce(g.latest_at, v.created_at) as latest_at,
        c.id as connection_id,
        case when control.id is not null then jsonb_build_object('id', control.id, 'revision', control.revision, 'status', control.status, 'provider', control.provider,
          'channelPaused', coalesce(channel.status <> 'active', false), 'running', coalesce(v.locked_at > now() - interval '3 minutes', false),
          'continuing', v.progress_encrypted is not null) else null end as watch,
        case when v.external_id is not null then jsonb_build_object(
          'provider', v.provider, 'status', case when channel.status <> 'active' then 'paused' else v.status end, 'lastSyncedAt', v.last_synced_at,
          'resultsLimit', v.results_limit, 'maxChargeCents', v.max_charge_cents,
          'continuing', v.progress_encrypted is not null, 'lastError', v.last_error is not null,
          'running', coalesce(v.locked_at > now() - interval '3 minutes', false),
          'overdue', v.status = 'active' and (channel.id is null or channel.status = 'active') and v.available_at < now() - interval '5 minutes'
            and (v.locked_at is null or v.locked_at < now() - interval '3 minutes'))
        when c.id is not null then jsonb_build_object(
          'provider', 'meta', 'status', case c.status when 'disabled' then 'paused' when 'revoked' then 'blocked' else c.status end,
          'lastSyncedAt', c.last_synced_at, 'resultsLimit', 0, 'maxChargeCents', 0,
          'continuing', c.sync_state->>'continuation' is not null, 'lastError', c.last_error is not null,
          'running', coalesce(extract(epoch from (now() - c.sync_locked_at)) * 1000 < ${cfg.SYNC_LEASE_MS}, false),
          'overdue', c.status in ('active', 'degraded')
            and extract(epoch from (now() - coalesce(c.sync_attempted_at, c.created_at))) * 1000 > ${cfg.RECONCILE_INTERVAL_MS + 300000}
            and (c.sync_locked_at is null or extract(epoch from (now() - c.sync_locked_at)) * 1000 > ${cfg.SYNC_LEASE_MS}))
        else null end as scan
      from grouped g full join (
        select id, revision, platform, external_id, title, channel_name, url, created_at, provider, status, last_synced_at,
          results_limit, max_charge_cents, progress_encrypted, last_error, locked_at, available_at, channel_id from watched_videos
        where status <> 'removed' and source_kind = 'video' ${connection ? sql`and false` : sql``}
          ${youtubeChannel ? sql`and channel_id = ${youtubeChannel}::uuid` : sql``}
          ${platform ? sql`and platform = ${platform}` : sql``}
          ${source ? source.id === null ? sql`and false` : sql`and external_id = ${source.id}` : sql``}
      ) v on v.platform = g.platform and v.external_id = g.source_id
      left join watched_videos control on control.platform = coalesce(g.platform, v.platform) and control.external_id = coalesce(g.source_id, v.external_id)
      left join watched_videos channel on channel.id = v.channel_id
      left join lateral (
        select i.raw, i.connection_id from social_items i
        where i.platform = g.platform and (i.root_external_id = g.source_id or (i.root_external_id is null and g.source_id is null))
          and i.deleted_at is null ${connection ? sql`and i.connection_id = ${connection}::uuid` : sql``}
        order by i.ingested_at desc, i.id desc limit 1
      ) m on true
      left join social_connections c on c.id = m.connection_id
    ), matched as (
      select *, count(*) over()::int as total from sources
      where ${query ? sql`concat_ws(' ', title, channel, permalink, source_id) ilike ${`%${query.replace(/[\\%_]/g, "\\$&")}%`}` : sql`true`}
        and ${filter === "pending" ? sql`pending > 0` : filter === "risk" ? sql`risk > 0` : filter === "empty" ? sql`comments = 0` : sql`true`}
    )
    select *, ${metric} as sort_metric, to_char(latest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at from matched
    ${after ? sql`where (${metric}, latest_at, platform, coalesce(source_id, '')) ${sort === "oldest" ? sql`>` : sql`<`}
      (${after.metric}::int, ${after.at}::timestamptz, ${after.platform}, ${after.id})` : sql``}
    order by sort_metric ${direction}, latest_at ${direction}, platform ${direction}, coalesce(source_id, '') ${direction} limit ${selected ? 1 : 25}
  `);
  const visible = result.slice(0, 24);
  const last = visible.at(-1);
  return {
    rows: visible.map((row) => ({ ...row, key: sourceKey(row.platform, row.source_id),
      raw: commentDisplay({ source_channel: row.channel, source_post: { id: row.source_id, text: row.title, permalink: row.permalink } }) })),
    total: result[0]?.total ?? 0,
    sort, filter,
    next: result.length > 24 && last ? Buffer.from(JSON.stringify({ at: last.cursor_at, platform: last.platform, id: last.source_id ?? "", metric: last.sort_metric, scope }), "utf8").toString("base64url") : null,
  };
}
