import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import { watchedVideos } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { beginSourceRead, upsertSocialItem } from "@/lib/ingest";
import { readResponseBody } from "@/lib/http-body";
import { videoSource } from "@/lib/video-source";

const identifier = z.string().regex(/^[A-Za-z0-9]{10,40}$/);
export const apifyProgressSchema = z.object({ phase: z.enum(["starting", "running", "dataset"]),
  runId: identifier.nullable(), datasetId: identifier.nullable(), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().nonnegative(), imported: z.number().int().nonnegative(), verified: z.boolean(),
  recordOffset: z.number().int().nonnegative(),
  requestedAt: z.number().int().positive(),
}).strict();
type Progress = z.infer<typeof apifyProgressSchema>;
type Video = typeof watchedVideos.$inferSelect;
const runSchema = z.object({ data: z.object({ id: identifier, actId: identifier, status: z.string(), defaultDatasetId: identifier,
  defaultKeyValueStoreId: identifier, startedAt: z.string().datetime() }) });

export class ApifySourceError extends Error {
  constructor(message: string, public permanent = false) { super(message); }
}

async function request(path: string, key: string, input?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.apify.com/v2/${path}`, { method: input === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApifySourceError(`apify_http_${response.status}`, [400, 401, 402, 403, 404].includes(response.status));
  }
  try { return JSON.parse(new TextDecoder().decode(await readResponseBody(response, 4 * 1024 * 1024))); }
  catch { throw new ApifySourceError("apify_invalid_response", true); }
}

export async function abortApifyRun(runId: string, encryptedKey: string) {
  identifier.parse(runId);
  await request(`actor-runs/${runId}/abort`, decryptSecret(encryptedKey), {});
}

const instagramSchema = z.object({ id: z.string().min(1).max(256), text: z.string().max(20000),
  ownerUsername: z.string().max(256).nullish(), ownerId: z.string().max(256).nullish(),
  ownerProfilePicUrl: z.string().max(4096).nullish(), timestamp: z.string().nullish(),
  parentCommentId: z.string().max(256).nullish(), postUrl: z.string().max(2048).nullish(),
  commentUrl: z.string().max(4096).nullish(), parentCommentUrl: z.string().max(4096).nullish(),
  inputUrl: z.string().max(2048).nullish(), replies: z.array(z.unknown()).max(10000).nullish(),
});
const facebookSchema = z.object({ commentId: z.string().regex(/^\d+$/), facebookId: z.string().regex(/^\d+$/),
  text: z.string().max(20000), date: z.string().nullish(), profileName: z.string().max(256).nullish(),
  profileId: z.string().max(256).nullish(), profilePicture: z.string().max(4096).nullish(),
  commentUrl: z.string().max(4096), inputUrl: z.string().max(2048).nullish(),
  postTitle: z.string().max(20000).nullish(), threadingDepth: z.number().int().nonnegative().nullish(),
  replyToCommentId: z.string().regex(/^\d+$/).nullish(), comments: z.array(z.unknown()).max(10000).nullish(),
});

// Apify's Facebook IDs are GraphQL/base64; Graph ingestion uses postId_commentId.
export function normalizeApifyComments(platform: "facebook" | "instagram", records: unknown[], sourceUrl: string) {
  const canonical = videoSource(platform, sourceUrl, undefined, true).externalId;
  const result: { id: string; text: string; author?: string; authorId?: string; avatar?: string;
    created?: string; parentId?: string; reply: boolean; permalink?: string; postText?: string }[] = [];
  const visit = (value: unknown, parentId?: string, depth = 0, facebookId?: string, postText?: string) => {
    if (result.length >= 10000 || depth > 3) throw new ApifySourceError("apify_result_limit", true);
    if (platform === "instagram") {
      const parsed = instagramSchema.safeParse(value);
      if (!parsed.success) throw new ApifySourceError("apify_invalid_result", true);
      const record = parsed.data;
      const url = record.inputUrl ?? record.postUrl;
      if (url && videoSource(platform, url, undefined, true).externalId !== canonical) throw new ApifySourceError("source_identity_mismatch", true);
      const commentIdentity = (link: string) => {
        const parsedUrl = new URL(link);
        const match = parsedUrl.pathname.match(/^(\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+)\/c\/(\d+)\/?$/);
        if (!match || videoSource("instagram", `${parsedUrl.origin}${match[1]}`, undefined, true).externalId !== canonical
          || parsedUrl.username || parsedUrl.password) throw new ApifySourceError("apify_invalid_result", true);
        return match[2]!;
      };
      if (record.commentUrl && commentIdentity(record.commentUrl) !== record.id) throw new ApifySourceError("apify_invalid_result", true);
      const parent = parentId ?? record.parentCommentId ?? (record.parentCommentUrl ? commentIdentity(record.parentCommentUrl) : undefined);
      result.push({ id: record.id, text: record.text, author: record.ownerUsername ?? undefined, authorId: record.ownerId ?? undefined,
        avatar: record.ownerProfilePicUrl ?? undefined, created: record.timestamp ?? undefined, parentId: parent, reply: Boolean(parent),
        permalink: record.commentUrl ?? undefined });
      for (const reply of record.replies ?? []) visit(reply, record.id, depth + 1);
    } else {
      const parsed = facebookSchema.safeParse(facebookId && value && typeof value === "object" && !Array.isArray(value)
        ? { facebookId, postTitle: postText, ...value } : value);
      if (!parsed.success) throw new ApifySourceError("apify_invalid_result", true);
      const record = parsed.data;
      if (record.inputUrl && videoSource(platform, record.inputUrl, undefined, true).externalId !== canonical) throw new ApifySourceError("source_identity_mismatch", true);
      const url = new URL(record.commentUrl);
      if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
        || !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(url.hostname)) throw new ApifySourceError("apify_invalid_result", true);
      const replyId = url.searchParams.get("reply_comment_id");
      const commentId = url.searchParams.get("comment_id");
      if ((replyId ?? commentId) !== record.commentId || [...url.searchParams.keys()].some((field) => /token|secret|authorization/i.test(field)))
        throw new ApifySourceError("apify_invalid_result", true);
      const parent = parentId ?? (record.replyToCommentId ? `${record.facebookId}_${record.replyToCommentId}`
        : replyId === record.commentId && commentId && /^\d+$/.test(commentId) ? `${record.facebookId}_${commentId}` : undefined);
      result.push({ id: `${record.facebookId}_${record.commentId}`, text: record.text, author: record.profileName ?? undefined,
        authorId: record.profileId ?? undefined, avatar: record.profilePicture ?? undefined, created: record.date ?? undefined,
        parentId: parent, reply: Boolean(parent || record.threadingDepth), permalink: record.commentUrl, postText: record.postTitle ?? undefined });
      for (const reply of record.comments ?? []) visit(reply, `${record.facebookId}_${record.commentId}`, depth + 1, record.facebookId, record.postTitle ?? undefined);
    }
  };
  for (const record of records) visit(record);
  const unique = new Map<string, typeof result[number]>();
  for (const record of result) if (!unique.has(record.id) || record.parentId) unique.set(record.id, record);
  if ([...unique.values()].some((record) => record.parentId === record.id)) throw new ApifySourceError("apify_invalid_result", true);
  return [...unique.values()];
}

export async function collectApifyVideo(video: Video, lockId: string) {
  if (video.platform !== "instagram" && video.platform !== "facebook") throw new ApifySourceError("invalid_provider", true);
  if (!video.apiKeyEncrypted) throw new ApifySourceError("apify_key_required", true);
  const platform = video.platform;
  const actor = platform === "instagram" ? "apify~instagram-comment-scraper" : "apify~facebook-comments-scraper";
  const key = decryptSecret(video.apiKeyEncrypted);
  const owned = and(eq(watchedVideos.id, video.id), eq(watchedVideos.lockId, lockId), eq(watchedVideos.status, "active"));
  const assertOwnership = async (tx: Transaction) => {
    const [lease] = await tx.select({ id: watchedVideos.id }).from(watchedVideos).where(owned).for("share");
    if (!lease) throw new ApifySourceError("source_lease_lost");
  };
  const save = async (progress: Progress | null, delay = 0, complete = false) => {
    const rows = await db.update(watchedVideos).set({ progressEncrypted: progress ? encryptSecret(JSON.stringify(progress)) : null,
      ...(progress?.runId ? { lastRunId: progress.runId } : {}), updatedAt: new Date(), lockedAt: new Date(),
      ...(delay || complete ? { lockId: null, lockedAt: null, attempts: 0, lastError: null,
        availableAt: new Date(Date.now() + (complete ? video.pollMinutes * 60000 : delay)) } : {}),
      ...(complete ? { lastSyncedAt: new Date(), lastRunCount: progress?.imported ?? 0, progressEncrypted: null } : {}),
    }).where(owned).returning({ id: watchedVideos.id });
    if (!rows.length) throw new ApifySourceError("source_lease_lost");
  };
  let progress: Progress;
  if (video.progressEncrypted) {
    const parsed = apifyProgressSchema.safeParse(JSON.parse(decryptSecret(video.progressEncrypted)));
    if (!parsed.success) throw new ApifySourceError("invalid_source_progress", true);
    progress = parsed.data;
    if (progress.phase === "starting") throw new ApifySourceError("apify_start_unknown", true);
  } else {
    progress = { phase: "starting", runId: null, datasetId: null, version: await beginSourceRead(), offset: 0, imported: 0,
      verified: false, recordOffset: 0, requestedAt: Date.now() };
    await save(progress);
    const input = platform === "instagram" ? { directUrls: [video.url], resultsLimit: video.resultsLimit, includeNestedComments: true }
      : { startUrls: [{ url: video.url }], resultsLimit: video.resultsLimit, includeNestedComments: true, viewOption: "RECENT_ACTIVITY" };
    let run: z.infer<typeof runSchema>["data"];
    try {
      run = runSchema.parse(await request(`actors/${actor}/runs?timeout=600&restartOnError=false&maxTotalChargeUsd=${video.maxChargeCents / 100}`, key, input)).data;
    } catch (error) {
      if (error instanceof ApifySourceError && /^apify_http_4\d\d$/.test(error.message)) {
        await save(null);
        throw error;
      }
      throw new ApifySourceError("apify_start_unknown", true);
    }
    progress = { ...progress, phase: "running", runId: run.id, datasetId: run.defaultDatasetId, verified: true };
    try { await save(progress, 15000); }
    catch (error) {
      // A pause/removal or DB failure after POST must not leave a paid run unattended.
      try { await abortApifyRun(run.id, video.apiKeyEncrypted); } catch { /* The durable starting marker prevents another automatic POST. */ }
      throw error;
    }
    return { id: video.id, completed: false };
  }
  if (!progress.runId) throw new ApifySourceError("invalid_source_progress", true);
  await save(progress);
  const run = runSchema.parse(await request(`actor-runs/${progress.runId}`, key)).data;
  if (run.id !== progress.runId || (progress.datasetId && run.defaultDatasetId !== progress.datasetId)
    || Date.parse(run.startedAt) < progress.requestedAt - 5000) throw new ApifySourceError("source_identity_mismatch", true);
  if (!progress.verified) {
    const expected = z.object({ data: z.object({ id: identifier }) }).parse(await request(`actors/${actor}`, key));
    if (expected.data.id !== run.actId) throw new ApifySourceError("source_identity_mismatch", true);
    const input = z.object({ directUrls: z.array(z.string()).optional(), startUrls: z.array(z.object({ url: z.string() })).optional() })
      .parse(await request(`key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`, key));
    const urls = platform === "instagram" ? input.directUrls : input.startUrls?.map((entry) => entry.url);
    if (urls?.length !== 1 || videoSource(platform, urls[0]!, undefined, true).externalId !== video.externalId) throw new ApifySourceError("source_identity_mismatch", true);
    progress.verified = true;
  }
  if (["READY", "RUNNING", "TIMING-OUT", "ABORTING"].includes(run.status)) {
    await save(progress, 30000);
    return { id: video.id, completed: false };
  }
  if (run.status !== "SUCCEEDED") throw new ApifySourceError("apify_run_failed", true);
  progress.phase = "dataset";
  progress.datasetId = run.defaultDatasetId;
  await save(progress);
  const deadline = Date.now() + 40000;
  for (let page = 0; page < 10 && Date.now() < deadline; page++) {
    const items = z.array(z.unknown()).max(100).parse(await request(`datasets/${progress.datasetId}/items?format=json&offset=${progress.offset}&limit=100`, key));
    const records = normalizeApifyComments(platform, items, video.url);
    if (progress.recordOffset > records.length) throw new ApifySourceError("invalid_source_progress", true);
    let heartbeat = Date.now();
    for (const record of records.slice(progress.recordOffset)) {
      if (Date.now() >= deadline) { await save(progress, 15000); return { id: video.id, completed: false }; }
      if (Date.now() - heartbeat > 10000) { await save(progress); heartbeat = Date.now(); }
      const created = record.created ? new Date(record.created) : null;
      if (created && Number.isNaN(created.getTime())) throw new ApifySourceError("invalid_source_date", true);
      const text = video.sourceText || record.postText || "";
      await upsertSocialItem({ platform, externalId: record.id, rootExternalId: video.externalId,
        parentExternalId: record.parentId ?? video.externalId, itemType: record.reply ? "reply" : "comment",
        text: record.text, authorName: record.author, authorId: record.authorId, sourceCreatedAt: created,
        permalink: record.permalink, sourceReadVersion: progress.version,
        raw: { source_post: { id: video.externalId, text, permalink: video.url }, source_channel: video.channelName,
          watched_video_id: video.id, external_source: true, provider: "apify", context_incomplete: !text.trim() || (record.reply && !record.parentId),
          author_avatar_url: record.avatar, apify_run_id: progress.runId },
      }, assertOwnership);
      progress.recordOffset++;
      progress.imported++;
    }
    progress.offset += items.length;
    progress.recordOffset = 0;
    if (items.length < 100) { await save(progress, 0, true); return { id: video.id, completed: true }; }
    await save(progress);
  }
  await save(progress, 15000);
  return { id: video.id, completed: false };
}
