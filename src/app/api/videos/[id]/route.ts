import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, watchedVideos } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { readResponseBody } from "@/lib/http-body";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { abortApifyRun, apifyProgressSchema } from "@/lib/apify-videos";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 2048))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = z.object({ action: z.enum(["pause", "resume", "collect", "remove", "recover", "restart"]), revision: z.number().int().positive(),
    runId: z.string().regex(/^[A-Za-z0-9]{10,40}$/).optional() }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const result = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(watchedVideos).where(eq(watchedVideos.id, id)).for("update");
      if (!current || current.status === "removed") return "not_found";
      if (current.revision !== parsed.data.revision) return "conflict";
      const action = parsed.data.action;
      let abort: { runId: string; key: string } | undefined;
      let abortUnconfirmed = false;
      if ((action === "pause" || action === "remove") && current.provider === "apify" && current.progressEncrypted && current.apiKeyEncrypted) {
        const progress = apifyProgressSchema.safeParse(JSON.parse(decryptSecret(current.progressEncrypted)));
        if (progress.success && progress.data.phase === "running" && progress.data.verified && progress.data.runId) abort = { runId: progress.data.runId, key: current.apiKeyEncrypted };
        else if (!progress.success || progress.data.phase !== "dataset") abortUnconfirmed = true;
      }
      let recovery: string | undefined;
      if (action === "recover") {
        if (current.provider !== "apify" || !parsed.data.runId || !current.progressEncrypted || current.status !== "blocked") return "invalid_recovery";
        const progress = apifyProgressSchema.parse(JSON.parse(decryptSecret(current.progressEncrypted)));
        recovery = encryptSecret(JSON.stringify({ ...progress, phase: "running", runId: parsed.data.runId,
          datasetId: null, offset: 0, recordOffset: 0, imported: 0, verified: false }));
      }
      if (action === "restart" && (current.provider !== "apify" || current.status !== "blocked")) return "invalid_recovery";
      if (action === "collect" && (current.status !== "active" || current.lockId)) return "source_busy";
      const status = action === "pause" ? "paused" : action === "remove" ? "removed" : "active";
      await tx.update(watchedVideos).set({ status, revision: current.revision + 1, availableAt: new Date(),
        lockId: null, lockedAt: null, attempts: 0, lastError: null, updatedAt: new Date(),
        ...((action === "resume" && current.status === "blocked" && current.provider !== "apify") || action === "restart" ? { progressEncrypted: null } : {}),
        ...(recovery ? { progressEncrypted: recovery } : {}),
      }).where(and(eq(watchedVideos.id, id), eq(watchedVideos.revision, parsed.data.revision)));
      await tx.insert(auditLogs).values({ actor: "admin", action: `video.${action}`, entityType: "watched_video", entityId: id });
      return { saved: true, abort, abortUnconfirmed };
    });
    if (typeof result === "string") return NextResponse.json({ error: result }, { status: result === "not_found" ? 404 : 409 });
    let warning: string | undefined = result.abortUnconfirmed ? "apify_abort_unconfirmed" : undefined;
    if (result.abort) {
      try { await abortApifyRun(result.abort.runId, result.abort.key); }
      catch { warning = "apify_abort_unconfirmed"; }
    }
    return NextResponse.json({ saved: true, warning });
  } catch { return NextResponse.json({ error: "video_save_failed" }, { status: 500 }); }
}
