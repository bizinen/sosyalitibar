import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, watchedVideos } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { decryptSecret } from "@/lib/crypto";
import { getYouTubeSettings } from "@/lib/youtube-settings";
import { readResponseBody } from "@/lib/http-body";
import { youtubeChannelReference } from "@/lib/video-source";
import { youtubeGet } from "@/lib/watched-videos";

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 8192))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = z.object({ url: z.string().trim().url().max(2048) }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  let reference: ReturnType<typeof youtubeChannelReference>;
  try { reference = youtubeChannelReference(parsed.data.url); }
  catch { return NextResponse.json({ error: "invalid_channel_url" }, { status: 400 }); }
  const encrypted = (await getYouTubeSettings())?.apiKeyEncrypted;
  if (!encrypted) return NextResponse.json({ error: "youtube_key_required" }, { status: 400 });
  try {
    const result = z.object({ items: z.array(z.object({ id: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
      snippet: z.object({ title: z.string().max(500) }), contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string().min(1).max(256) }) }),
    })).max(1) }).parse(await youtubeGet("channels", decryptSecret(encrypted), { part: "snippet,contentDetails", ...reference }));
    const channel = result.items[0];
    if (!channel || (reference.id && channel.id !== reference.id)) return NextResponse.json({ error: "channel_unavailable" }, { status: 404 });
    const response = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_videos'))`);
      const [existing] = await tx.select().from(watchedVideos).where(and(eq(watchedVideos.platform, "youtube"), eq(watchedVideos.externalId, channel.id))).for("update");
      if (existing && existing.status !== "removed") return null;
      const fields = { platform: "youtube", sourceKind: "channel", externalId: channel.id, url: `https://www.youtube.com/channel/${channel.id}`,
        uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads, apiKeyEncrypted: null, title: channel.snippet.title,
        channelName: channel.snippet.title, analysisAfter: existing?.analysisAfter ?? new Date(), status: "active", attempts: 0,
        lastError: null, lockId: null, lockedAt: null, progressEncrypted: null, availableAt: new Date(), updatedAt: new Date() };
      const [row] = existing ? await tx.update(watchedVideos).set({ ...fields, revision: existing.revision + 1 }).where(eq(watchedVideos.id, existing.id)).returning({ id: watchedVideos.id })
        : await tx.insert(watchedVideos).values(fields).returning({ id: watchedVideos.id });
      await tx.insert(auditLogs).values({ actor: "admin", action: "youtube_channel.added", entityType: "watched_video", entityId: row!.id,
        metadata: { channelId: channel.id, historicalAnalysis: false } });
      return row;
    });
    return response ? NextResponse.json(response, { status: 201 }) : NextResponse.json({ error: "channel_exists" }, { status: 409 });
  } catch (error) {
    const code = error instanceof Error && /^(youtube_(quota_exceeded|http_\d+)|channel_unavailable)$/.test(error.message) ? error.message : "channel_add_failed";
    return NextResponse.json({ error: code }, { status: code === "youtube_quota_exceeded" ? 429 : 502 });
  }
}
