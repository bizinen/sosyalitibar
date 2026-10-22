import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, socialConnections, watchedVideos } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { readResponseBody } from "@/lib/http-body";
import { encryptSecret } from "@/lib/crypto";
import { videoSource, videoScanSettingsSchema } from "@/lib/video-source";

const schema = z.object({ platform: z.enum(["youtube", "facebook", "instagram"]), url: z.string().trim().url().max(2048),
  resourceId: z.string().trim().max(100).optional(), connectionId: z.string().uuid().optional(),
  apiKey: z.string().trim().max(4096).refine((key) => !/\s/.test(key)).optional(),
  provider: z.enum(["official", "apify"]).default("official"),
  resultsLimit: videoScanSettingsSchema.shape.resultsLimit.default(1000),
  pollMinutes: videoScanSettingsSchema.shape.pollMinutes.default(60),
  maxChargeCents: videoScanSettingsSchema.shape.maxChargeCents.default(100),
  sourceText: z.string().trim().max(20000).optional(), channelName: z.string().trim().max(256).optional(),
}).strict();

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 131072))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const value = parsed.data;
  if (value.provider === "apify" && value.platform === "youtube") return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  let source: ReturnType<typeof videoSource>;
  try { source = videoSource(value.platform, value.url, value.resourceId, value.provider === "apify"); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "invalid_video_url" }, { status: 400 }); }
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_videos'))`);
      let encrypted: string | null = null;
      if (value.platform === "youtube" || value.provider === "apify") {
        const [saved] = await tx.select({ key: watchedVideos.apiKeyEncrypted }).from(watchedVideos)
          .where(and(eq(watchedVideos.provider, value.provider), ...(value.provider === "official" ? [eq(watchedVideos.platform, "youtube")] : []),
            isNotNull(watchedVideos.apiKeyEncrypted))).orderBy(desc(watchedVideos.updatedAt)).limit(1);
        encrypted = value.apiKey ? encryptSecret(value.apiKey) : saved?.key ?? null;
        if (!encrypted) return { error: value.provider === "apify" ? "apify_key_required" : "youtube_key_required" };
      } else {
        if (!value.connectionId) return { error: "meta_connection_required" };
        const [connection] = await tx.select().from(socialConnections).where(eq(socialConnections.id, value.connectionId)).for("share");
        if (!connection || connection.platform !== value.platform || connection.status !== "active") return { error: "meta_connection_required" };
      }
      const [existing] = await tx.select().from(watchedVideos).where(and(eq(watchedVideos.platform, value.platform),
        sql`(${watchedVideos.externalId} = ${source.externalId} or ${watchedVideos.url} = ${source.url})`))
        .orderBy(sql`${watchedVideos.status} = 'removed'`).for("update");
      if (existing && existing.status !== "removed") return { error: "video_exists" };
      const fields = { ...source, platform: value.platform, apiKeyEncrypted: encrypted,
        provider: value.provider, resultsLimit: value.resultsLimit, pollMinutes: value.pollMinutes, maxChargeCents: value.maxChargeCents,
        sourceText: value.sourceText || null, channelName: value.channelName || null,
        title: value.provider === "apify" ? value.sourceText?.split("\n")[0]?.slice(0, 500) || null : null, lastRunId: null, lastRunCount: null,
        credentialConnectionId: value.platform === "youtube" || value.provider === "apify" ? null : value.connectionId!, status: "active", attempts: 0,
        lastError: null, lockId: null, lockedAt: null, progressEncrypted: null, availableAt: new Date(), updatedAt: new Date() };
      const [video] = existing ? await tx.update(watchedVideos).set({ ...fields, revision: existing.revision + 1 }).where(eq(watchedVideos.id, existing.id)).returning({ id: watchedVideos.id })
        : await tx.insert(watchedVideos).values(fields).returning({ id: watchedVideos.id });
      await tx.insert(auditLogs).values({ actor: "admin", action: "video.added", entityType: "watched_video", entityId: video!.id, metadata: { platform: value.platform, externalId: source.externalId } });
      return { id: video!.id };
    });
    return "error" in result ? NextResponse.json(result, { status: result.error === "video_exists" ? 409 : 400 }) : NextResponse.json(result, { status: 201 });
  } catch { return NextResponse.json({ error: "video_save_failed" }, { status: 500 }); }
}
