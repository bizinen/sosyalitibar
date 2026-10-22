import crypto from "node:crypto";
import { z } from "zod";
import { and, asc, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import { socialConnections, watchedVideos } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { beginSourceRead, upsertSocialItem } from "@/lib/ingest";
import { readResponseBody } from "@/lib/http-body";
import { mapLimit } from "@/lib/concurrency";
import { env } from "@/lib/config";
import { getYouTubeSettings } from "@/lib/youtube-settings";
import { getFacebookPost, getFacebookComments, getFacebookReplies, getInstagramMediaItem, getInstagramComments,
  getInstagramReplies, graphGet, graphGetAbsolute, MetaApiError } from "@/lib/meta";
import { videoSource } from "@/lib/video-source";
import { ApifySourceError, collectApifyVideo } from "@/lib/apify-videos";

const progressSchema = z.object({ phase: z.enum(["comments", "replies"]), token: z.string().max(16384).nullable(),
  nextComments: z.string().max(16384).nullable(), parents: z.array(z.string().min(1).max(256)).max(100),
  seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000).default([]),
  text: z.string().max(20000), channel: z.string().max(256),
}).strict();
type Progress = z.infer<typeof progressSchema>;
type Video = typeof watchedVideos.$inferSelect;
const commentSchema = z.object({ id: z.string().min(1).max(256), snippet: z.object({ textOriginal: z.string().optional(),
  textDisplay: z.string(), authorDisplayName: z.string().optional(), authorProfileImageUrl: z.string().optional(),
  authorChannelId: z.object({ value: z.string() }).optional(), publishedAt: z.string(), parentId: z.string().optional(),
}) });
const youtubePageSchema = z.object({ nextPageToken: z.string().optional(), items: z.array(z.object({
  id: z.string(), snippet: z.object({ topLevelComment: commentSchema, totalReplyCount: z.number().int().nonnegative() }),
})).max(100) });
const metaRecordSchema = z.object({ id: z.string().min(1).max(256), message: z.string().optional(), text: z.string().optional(),
  username: z.string().optional(), created_time: z.string().optional(), timestamp: z.string().optional(),
  permalink_url: z.string().optional(), from: z.object({ id: z.string().optional(), name: z.string().optional() }).nullish(),
  parent: z.object({ id: z.string() }).nullish(), replies: z.object({ data: z.array(z.unknown()) }).optional(),
}).passthrough();
const metaPageSchema = z.object({ data: z.array(metaRecordSchema).max(100), paging: z.object({ next: z.string().optional() }).nullish() });

class SourceError extends Error {
  constructor(message: string, public permanent = false) { super(message); }
}

export async function youtubeGet(path: "videos" | "commentThreads" | "comments" | "channels" | "playlistItems", key: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  url.search = new URLSearchParams({ ...params, key }).toString();
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000) });
  const body = JSON.parse(new TextDecoder().decode(await readResponseBody(response, 4 * 1024 * 1024)));
  if (!response.ok) {
    const reason = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).optional() }) }).safeParse(body);
    const code = reason.success ? reason.data.error.errors?.[0]?.reason : undefined;
    if (["quotaExceeded", "dailyLimitExceeded"].includes(code ?? "")) throw new SourceError("youtube_quota_exceeded");
    if (code === "commentsDisabled") throw new SourceError("comments_disabled", true);
    if (path === "comments" && response.status === 404 && code === "commentNotFound") return { items: [] };
    throw new SourceError(`youtube_http_${response.status}`, [400, 401, 403, 404].includes(response.status));
  }
  return body;
}

function date(value?: string) {
  if (!value) return null;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new SourceError("invalid_source_date");
  return result;
}

async function collectVideo(video: Video, lockId: string) {
  const owned = and(eq(watchedVideos.id, video.id), eq(watchedVideos.lockId, lockId), eq(watchedVideos.status, "active"),
    video.channelId ? sql`exists (select 1 from watched_videos channel where channel.id = ${video.channelId}::uuid and channel.status = 'active')` : undefined);
  const assertOwnership = async (tx: Transaction) => {
    const [lease] = await tx.select({ id: watchedVideos.id }).from(watchedVideos).where(owned).for("share");
    if (!lease) throw new SourceError("source_lease_lost");
    if (video.channelId) {
      const [channel] = await tx.select({ status: watchedVideos.status }).from(watchedVideos).where(eq(watchedVideos.id, video.channelId)).for("share");
      if (channel?.status !== "active") throw new SourceError("source_lease_lost");
    }
    if (video.platform !== "youtube") {
      const [connection] = video.credentialConnectionId ? await tx.select({ status: socialConnections.status }).from(socialConnections)
        .where(eq(socialConnections.id, video.credentialConnectionId)).for("share") : [];
      if (connection?.status !== "active") throw new SourceError("meta_connection_required", true);
    }
  };
  const save = async (progress: Progress | null, complete = false) => {
    const updated = await db.update(watchedVideos).set({ progressEncrypted: progress ? encryptSecret(JSON.stringify(progress)) : null,
      ...(progress ? { title: progress.text.split("\n")[0]?.slice(0, 500), channelName: progress.channel } : {}),
      lockedAt: new Date(), updatedAt: new Date(), ...(complete ? { lockId: null, lockedAt: null, lastSyncedAt: new Date(),
        availableAt: new Date(Date.now() + (video.channelId ? Math.max(video.pollMinutes, Date.now() - video.createdAt.getTime() > 7 * 86400000 ? 1440 : 0) : 10) * 60000), lastError: null, attempts: 0 } : {}),
    }).where(owned).returning({ id: watchedVideos.id });
    if (!updated.length) throw new SourceError("source_lease_lost");
  };
  try {
    if (video.provider === "apify") return await collectApifyVideo(video, lockId);
    let key: string;
    if (video.platform === "youtube") {
      const channel = video.channelId ? await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, video.channelId) }) : undefined;
      const encrypted = (await getYouTubeSettings())?.apiKeyEncrypted ?? channel?.apiKeyEncrypted ?? video.apiKeyEncrypted;
      if (!encrypted) throw new SourceError("youtube_key_required", true);
      key = decryptSecret(encrypted);
    } else {
      const connection = video.credentialConnectionId ? await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, video.credentialConnectionId) }) : undefined;
      if (!connection || connection.status !== "active" || connection.platform !== video.platform) throw new SourceError("meta_connection_required", true);
      key = decryptSecret(connection.encryptedAccessToken);
    }
    if (video.sourceKind === "channel") {
      const schema = z.object({ token: z.string().max(16384).nullable(), seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000), headCheckedAt: z.number().nonnegative().default(0) }).strict();
      const progress = video.progressEncrypted ? schema.parse(JSON.parse(decryptSecret(video.progressEncrypted))) : { token: null, seen: [], headCheckedAt: 0 };
      const refreshHead = Boolean(progress.token && Date.now() - progress.headCheckedAt >= 15 * 60000);
      const pageKey = crypto.createHash("sha256").update(JSON.stringify(progress.token)).digest("hex");
      if (!refreshHead && progress.seen.includes(pageKey)) throw new SourceError("source_pagination_stalled", true);
      if (progress.seen.length >= 10000) throw new SourceError("source_pagination_limit", true);
      const page = z.object({ nextPageToken: z.string().max(16384).optional(), items: z.array(z.object({
        snippet: z.object({ title: z.string(), videoOwnerChannelId: z.string().optional(), resourceId: z.object({ videoId: z.string().optional() }) }),
        contentDetails: z.object({ videoPublishedAt: z.string().datetime().optional() }).optional(),
      })).max(50) }).parse(await youtubeGet("playlistItems", key, { part: "snippet,contentDetails", playlistId: video.uploadsPlaylistId!, maxResults: "50",
        ...(progress.token && !refreshHead ? { pageToken: progress.token } : {}) }));
      await db.transaction(async (tx) => {
        const [channel] = await tx.select({ id: watchedVideos.id }).from(watchedVideos).where(owned).for("update");
        if (!channel) throw new SourceError("source_lease_lost");
        for (const item of page.items) {
          const id = item.snippet.resourceId.videoId;
          if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) continue;
          if (item.snippet.videoOwnerChannelId && item.snippet.videoOwnerChannelId !== video.externalId) throw new SourceError("source_identity_mismatch", true);
          const recent = item.contentDetails?.videoPublishedAt && Date.parse(item.contentDetails.videoPublishedAt) > Date.now() - 7 * 86400000;
          await tx.insert(watchedVideos).values({ platform: "youtube", externalId: id, url: `https://www.youtube.com/watch?v=${id}`,
            channelId: video.id, analysisAfter: video.analysisAfter, title: item.snippet.title.slice(0, 500), channelName: video.channelName,
            pollMinutes: recent ? 60 : 1440 }).onConflictDoNothing({ target: [watchedVideos.platform, watchedVideos.externalId] });
        }
        const next = refreshHead ? { ...progress, headCheckedAt: Date.now() } : page.nextPageToken
          ? { token: page.nextPageToken, seen: [...progress.seen, pageKey], headCheckedAt: progress.token ? progress.headCheckedAt : Date.now() } : null;
        await tx.update(watchedVideos).set({ progressEncrypted: next ? encryptSecret(JSON.stringify(next)) : null,
          lockId: null, lockedAt: null, attempts: 0, lastError: null, updatedAt: new Date(),
          availableAt: new Date(Date.now() + (next ? 15000 : 15 * 60000)), ...(!next ? { lastSyncedAt: new Date() } : {}),
        }).where(owned);
      });
      return { id: video.id, completed: !refreshHead && !page.nextPageToken, discovered: page.items.length };
    }
    let progress: Progress;
    if (video.progressEncrypted) progress = progressSchema.parse(JSON.parse(decryptSecret(video.progressEncrypted)));
    else {
      let text = "";
      let channel = "";
      if (video.platform === "youtube") {
        const result = z.object({ items: z.array(z.object({ id: z.string(), snippet: z.object({ title: z.string(),
          description: z.string(), channelTitle: z.string() }) })).max(1) }).parse(await youtubeGet("videos", key, { id: video.externalId, part: "snippet" }));
        const root = result.items[0];
        if (!root || root.id !== video.externalId) throw new SourceError("video_unavailable", true);
        text = `${root.snippet.title}\n${root.snippet.description}`;
        channel = root.snippet.channelTitle;
      } else if (video.platform === "facebook") {
        if (video.externalId.includes("_")) {
          const root = await getFacebookPost(video.externalId, key);
          if (root.id !== video.externalId) throw new SourceError("source_identity_mismatch", true);
          text = root.message ?? "";
        } else {
          // Video nodes do not have the Post node's message field.
          const root = z.object({ id: z.string() }).parse(await graphGet(video.externalId, key, { fields: "id" }));
          if (root.id !== video.externalId) throw new SourceError("source_identity_mismatch", true);
        }
        channel = "Facebook yayını";
      } else {
        const root = await getInstagramMediaItem(video.externalId, key);
        if (root.id !== video.externalId || !root.permalink
          || new URL(videoSource("instagram", root.permalink, root.id).url).pathname.replace(/\/$/, "")
            !== new URL(video.url).pathname.replace(/\/$/, "")) throw new SourceError("source_identity_mismatch", true);
        text = root.caption ?? ""; channel = "Instagram yayını";
      }
      progress = { phase: "comments", token: null, nextComments: null, parents: [], seen: [], text: text.slice(0, 20000), channel: channel.slice(0, 256) };
      await save(progress);
    }
    const deadline = Date.now() + 40000;
    const paging = async (url: string) => {
      const parsed = new URL(url);
      parsed.searchParams.set("access_token", key);
      return graphGetAbsolute(parsed.toString());
    };
    for (let step = 0; step < 12 && Date.now() < deadline; step++) {
      await save(progress);
      const version = await beginSourceRead();
      let lastHeartbeat = Date.now();
      const parent = progress.phase === "replies" ? progress.parents[0] : undefined;
      if (progress.phase === "replies" && !parent) throw new SourceError("invalid_source_progress", true);
      const pageKey = crypto.createHash("sha256").update(JSON.stringify(parent
        ? [progress.phase, parent, progress.nextComments, progress.token] : [progress.phase, null, progress.token])).digest("hex");
      if (progress.seen.includes(pageKey)) throw new SourceError("source_pagination_stalled", true);
      if (progress.seen.length >= 10000) throw new SourceError("source_pagination_limit", true);
      const sourcePost = { id: video.externalId, text: progress.text, permalink: video.url };
      const put = async (record: { id: string; text: string; author?: string; authorId?: string; avatar?: string; created?: string; parentId?: string; permalink?: string }) => {
        if (Date.now() - lastHeartbeat > 10000) { await save(progress); lastHeartbeat = Date.now(); }
        const parentId = record.parentId && record.parentId !== video.externalId ? record.parentId : parent;
        await upsertSocialItem({ platform: video.platform as "youtube" | "facebook" | "instagram", externalId: record.id,
          rootExternalId: video.externalId, parentExternalId: parentId ?? video.externalId, itemType: parentId ? "reply" : "comment",
          text: record.text, authorName: record.author, authorId: record.authorId, permalink: record.permalink,
          sourceCreatedAt: date(record.created), sourceReadVersion: version,
          analysisExcluded: Boolean(video.analysisAfter && (!record.created || date(record.created)! <= video.analysisAfter)),
          raw: { source_post: sourcePost, source_channel: progress.channel, watched_video_id: video.id, external_source: true,
            context_incomplete: !progress.text.trim(), author_avatar_url: record.avatar },
        }, assertOwnership);
      };
      let next: string | null;
      const parents: string[] = [];
      if (video.platform === "youtube") {
        const params: Record<string, string> = { part: "snippet", maxResults: "100", textFormat: "plainText",
          ...(parent ? { parentId: parent } : { videoId: video.externalId, order: "time" }), ...(progress.token ? { pageToken: progress.token } : {}) };
        const body = await youtubeGet(parent ? "comments" : "commentThreads", key, params);
        const replies = parent ? z.object({ items: z.array(commentSchema).max(100), nextPageToken: z.string().optional() }).parse(body) : null;
        const threads = parent ? null : youtubePageSchema.parse(body);
        for (const entry of threads?.items ?? []) if (entry.snippet.totalReplyCount > 0) parents.push(entry.snippet.topLevelComment.id);
        const comments = replies?.items ?? threads!.items.map((entry) => entry.snippet.topLevelComment);
        for (const comment of comments) {
          const info = comment.snippet;
          await put({ id: comment.id, text: info.textOriginal ?? info.textDisplay, author: info.authorDisplayName,
            authorId: info.authorChannelId?.value, avatar: info.authorProfileImageUrl, created: info.publishedAt, parentId: info.parentId,
            permalink: `${video.url}&lc=${encodeURIComponent(comment.id)}` });
        }
        next = (replies?.nextPageToken ?? threads?.nextPageToken) ?? null;
      } else {
        const facebook = video.platform === "facebook";
        const result = progress.token ? await paging(progress.token) : parent
          ? facebook ? await getFacebookReplies(parent, key) : await getInstagramReplies(parent, key)
          : facebook ? await getFacebookComments(video.externalId, key) : await getInstagramComments(video.externalId, key);
        const page = metaPageSchema.parse(result);
        for (const record of page.data) {
          await put({ id: record.id, text: record.message ?? record.text ?? "", author: record.from?.name ?? record.username,
            authorId: record.from?.id, created: record.created_time ?? record.timestamp, parentId: record.parent?.id,
            permalink: record.permalink_url });
          if (!parent && (!record.parent?.id || record.parent.id === video.externalId)
            && (facebook || !record.replies || record.replies.data.length > 0)) parents.push(record.id);
        }
        next = page.paging?.next ?? null;
      }
      if (next && next === progress.token) throw new SourceError("source_pagination_stalled", true);
      progress.seen.push(pageKey);
      if (!parent) {
        progress = { ...progress, phase: parents.length ? "replies" : "comments", parents: [...new Set(parents)],
          nextComments: next, token: parents.length ? null : next };
      } else if (next) progress.token = next;
      else {
        progress.parents.shift();
        progress.token = progress.parents.length ? null : progress.nextComments;
        if (!progress.parents.length) progress.phase = "comments";
      }
      const complete = progress.phase === "comments" && !progress.token;
      if (complete) { await save(progress); await save(null, true); return { id: video.id, completed: true }; }
      await save(progress);
    }
    await db.update(watchedVideos).set({ lockId: null, lockedAt: null, availableAt: new Date(Date.now() + 15000),
      attempts: 0, lastError: null }).where(owned);
    return { id: video.id, completed: false };
  } catch (error) {
    const message = error instanceof SourceError || error instanceof ApifySourceError ? error.message : error instanceof MetaApiError ? `meta_http_${error.status}_code_${error.code ?? 0}` : "source_read_failed";
    const attempts = video.attempts + 1;
    const blocked = ((error instanceof SourceError || error instanceof ApifySourceError) && error.permanent) || (error instanceof MetaApiError && [400, 401, 403, 404].includes(error.status))
      || (attempts >= 8 && message !== "youtube_quota_exceeded");
    await db.update(watchedVideos).set({ lockId: null, lockedAt: null, attempts: message === "youtube_quota_exceeded" ? 0 : attempts,
      status: blocked ? "blocked" : "active", lastError: message,
      availableAt: new Date(Date.now() + (message === "youtube_quota_exceeded" ? 3600000 : Math.min(3600000, 30000 * 2 ** attempts))), updatedAt: new Date(),
    }).where(owned);
    return { id: video.id, error: message };
  }
}

export async function collectWatchedVideos() {
  const concurrency = Math.min(2, env().SYNC_CONCURRENCY);
  const lockId = crypto.randomUUID();
  const rows = await db.transaction(async (tx) => {
    const due = and(eq(watchedVideos.status, "active"), lte(watchedVideos.availableAt, new Date()),
      sql`(${watchedVideos.channelId} is null or exists (select 1 from watched_videos channel where channel.id = watched_videos.channel_id and channel.status = 'active'))`,
      or(isNull(watchedVideos.lockedAt), lt(watchedVideos.lockedAt, new Date(Date.now() - 180000))));
    const sources = concurrency > 1 ? await tx.select().from(watchedVideos).where(and(due, eq(watchedVideos.sourceKind, "channel")))
      .orderBy(asc(watchedVideos.availableAt), asc(watchedVideos.id)).limit(1).for("update", { skipLocked: true }) : [];
    const remaining = await tx.select().from(watchedVideos).where(and(due, sources[0] ? ne(watchedVideos.id, sources[0].id) : undefined))
      .orderBy(...(sources.length ? [sql`case when ${watchedVideos.sourceKind} = 'video' then 0 else 1 end`] : []), asc(watchedVideos.availableAt), asc(watchedVideos.id))
      .limit(concurrency - sources.length).for("update", { skipLocked: true });
    sources.push(...remaining);
    for (const source of sources) await tx.update(watchedVideos).set({ lockId, lockedAt: new Date() }).where(eq(watchedVideos.id, source.id));
    return sources;
  });
  return mapLimit(rows, concurrency, (source) => collectVideo(source, lockId));
}
