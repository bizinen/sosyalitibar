import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { itemTranslations, socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { lockAnalysisContext } from "@/lib/analysis-state";
import { translateToTurkish, translationPromptHash } from "@/lib/translation";
import { getLlmSettings } from "@/lib/llm-settings";
import { llmConfigured } from "@/lib/config";
import { readResponseBody } from "@/lib/http-body";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 1024))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = z.object({ analysisRevision: z.number().int().positive() }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const revision = parsed.data.analysisRevision;
  const condition = and(eq(itemTranslations.itemId, id), eq(itemTranslations.analysisRevision, revision), eq(itemTranslations.targetLanguage, "tr"));
  const item = await db.query.socialItems.findFirst({ where: eq(socialItems.id, id) });
  if (!item || item.deletedAt || item.sourceUnavailableAt || item.analysisRevision !== revision) return NextResponse.json({ error: "source_changed" }, { status: 409 });
  if (!item.text.trim() || item.text.length > 60000) return NextResponse.json({ error: "translation_text_limit" }, { status: 400 });
  const cfg = await getLlmSettings();
  const promptHash = translationPromptHash(cfg.policy);
  const cached = await db.query.itemTranslations.findFirst({ where: and(condition, isNull(itemTranslations.lockId), eq(itemTranslations.promptHash, promptHash)) });
  if (cached) return NextResponse.json({ text: cached.text, model: cached.model, analysisRevision: revision });
  if (!llmConfigured(cfg)) return NextResponse.json({ error: "llm_not_configured" }, { status: 503 });
  const lockId = crypto.randomUUID();
  const [claimed] = await db.insert(itemTranslations).values({ itemId: id, analysisRevision: revision, text: "", model: "", lockId, lockedAt: new Date() })
    .onConflictDoUpdate({ target: [itemTranslations.itemId, itemTranslations.analysisRevision, itemTranslations.targetLanguage],
      set: { lockId, lockedAt: new Date() }, setWhere: sql`(${itemTranslations.lockId} is null and ${itemTranslations.promptHash} is distinct from ${promptHash}) or (${itemTranslations.lockId} is not null and ${itemTranslations.lockedAt} < now() - interval '5 minutes')`,
    }).returning({ itemId: itemTranslations.itemId });
  if (!claimed) return NextResponse.json({ error: "translation_in_progress" }, { status: 409 });
  try {
    const result = await translateToTurkish(item.text, async () => {
      const held = await db.update(itemTranslations).set({ lockedAt: new Date() }).where(and(condition, eq(itemTranslations.lockId, lockId))).returning({ id: itemTranslations.itemId });
      if (!held.length) throw new Error("translation_lease_lost");
    }, cfg);
    const saved = await db.transaction(async (tx) => {
      await lockAnalysisContext(tx);
      const [source] = await tx.select({ revision: socialItems.analysisRevision }).from(socialItems)
        .where(and(eq(socialItems.id, id), isNull(socialItems.deletedAt), isNull(socialItems.sourceUnavailableAt))).for("share");
      if (source?.revision !== revision) return false;
      const updated = await tx.update(itemTranslations).set({ ...result, lockId: null, lockedAt: null })
        .where(and(condition, eq(itemTranslations.lockId, lockId))).returning({ id: itemTranslations.itemId });
      return updated.length > 0;
    });
    if (!saved) return NextResponse.json({ error: "source_changed" }, { status: 409 });
    return NextResponse.json({ ...result, analysisRevision: revision });
  } catch { return NextResponse.json({ error: "translation_failed" }, { status: 502 }); }
  finally { await db.delete(itemTranslations).where(and(condition, eq(itemTranslations.lockId, lockId))); }
}
