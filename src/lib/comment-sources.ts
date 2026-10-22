import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { commentDisplay } from "@/lib/comment-display";
import { readSourceKey, sourceKey, type CommentParams } from "@/lib/comment-feed";

type SourceRow = {
  platform: string; source_id: string | null; title: string | null; channel: string | null;
  permalink: string | null; comments: number; pending: number; risk: number;
  latest_at: string; cursor_at: string; total: number;
};

export async function commentSources(p: CommentParams, selected = false) {
  const source = selected ? readSourceKey(p.source) : null;
  if (selected && !source) return { rows: [], next: null, total: 0 };
  const platform = source?.platform ?? (["youtube", "instagram", "facebook"].includes(p.platform ?? "") ? p.platform : null);
  const connection = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.connection ?? "") ? p.connection : null;
  const query = selected ? "" : p.sourceQ?.trim().slice(0, 120) ?? "";
  let after: { at: string; platform: string; id: string } | null = null;
  if (!selected && p.sourceAfter && p.sourceAfter.length <= 2048) {
    try {
      const value = JSON.parse(Buffer.from(p.sourceAfter, "base64url").toString("utf8"));
      if (typeof value.at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.at)
        && Number.isFinite(Date.parse(value.at)) && new Date(value.at).toISOString() === value.at.replace(/(\.\d{3})\d{3}Z$/, "$1Z")
        && ["youtube", "instagram", "facebook"].includes(value.platform)
        && typeof value.id === "string" && value.id.length <= 512) after = value;
    } catch { /* An invalid page cursor returns the first page. */ }
  }
  const result = await db.execute<SourceRow>(sql`
    with grouped as (
      select i.platform, i.root_external_id as source_id, count(*)::int as comments,
        count(*) filter (where i.review_status = 'new' and i.source_unavailable_at is null)::int as pending,
        count(*) filter (where a.severity >= 70 or a.triage_label = 'acil_inceleme')::int as risk,
        max(i.ingested_at) as latest_at
      from social_items i left join social_analyses a on a.item_id = i.id
      where i.deleted_at is null
        ${platform ? sql`and i.platform = ${platform}` : sql``}
        ${connection ? sql`and i.connection_id = ${connection}::uuid` : sql``}
        ${source ? source.id === null ? sql`and i.root_external_id is null` : sql`and i.root_external_id = ${source.id}` : sql``}
      group by i.platform, i.root_external_id
    ), sources as (
      select coalesce(g.platform, v.platform) as platform, coalesce(g.source_id, v.external_id) as source_id,
        coalesce(nullif(v.title, ''), nullif(m.raw->'source_post'->>'text', '')) as title,
        coalesce(nullif(v.channel_name, ''), nullif(m.raw->>'source_channel', ''), c.display_name) as channel,
        coalesce(v.url, m.raw->'source_post'->>'permalink', m.raw->'source_post'->>'permalink_url') as permalink,
        coalesce(g.comments, 0) as comments, coalesce(g.pending, 0) as pending, coalesce(g.risk, 0) as risk,
        coalesce(g.latest_at, v.created_at) as latest_at
      from grouped g full join (
        select platform, external_id, title, channel_name, url, created_at from watched_videos
        where status <> 'removed' ${connection ? sql`and false` : sql``}
          ${platform ? sql`and platform = ${platform}` : sql``}
          ${source ? source.id === null ? sql`and false` : sql`and external_id = ${source.id}` : sql``}
      ) v on v.platform = g.platform and v.external_id = g.source_id
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
    )
    select *, to_char(latest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at from matched
    ${after ? sql`where (latest_at, platform, coalesce(source_id, '')) < (${after.at}::timestamptz, ${after.platform}, ${after.id})` : sql``}
    order by latest_at desc, platform desc, coalesce(source_id, '') desc limit ${selected ? 1 : 25}
  `);
  const visible = result.slice(0, 24);
  const last = visible.at(-1);
  return {
    rows: visible.map((row) => ({ ...row, key: sourceKey(row.platform, row.source_id),
      raw: commentDisplay({ source_channel: row.channel, source_post: { id: row.source_id, text: row.title, permalink: row.permalink } }) })),
    total: result[0]?.total ?? 0,
    next: result.length > 24 && last ? Buffer.from(JSON.stringify({ at: last.cursor_at, platform: last.platform, id: last.source_id ?? "" }), "utf8").toString("base64url") : null,
  };
}
