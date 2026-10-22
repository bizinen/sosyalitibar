import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { alertOutbox, socialAnalyses, socialItems } from "@/db/schema";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { audit } from "@/lib/audit";
import { lockAnalysisContext } from "@/lib/analysis-state";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const changed = await db.transaction(async (tx) => {
    await lockAnalysisContext(tx, true);
    const [row] = await tx.update(socialItems).set({
      reviewStatus: "new",
      analysisStatus: "pending",
      analysisRevision: sql`${socialItems.analysisRevision} + 1`,
      analysisAttempts: 0,
      analysisAvailableAt: new Date(),
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: null,
      updatedAt: new Date(),
    }).where(and(eq(socialItems.id, id), eq(socialItems.analysisStatus, "dead"), isNull(socialItems.deletedAt))).returning({ id: socialItems.id });
    if (!row) return false;
    await tx.update(alertOutbox).set({ status: "cancelled", lockedAt: null, lockId: null, lastError: "analysis requeued", updatedAt: new Date() })
      .where(and(eq(alertOutbox.itemId, id), sql`(${alertOutbox.status} in ('pending', 'retry', 'dead') or (${alertOutbox.status} = 'processing' and ${alertOutbox.dispatchStartedAt} is null))`));
    await tx.delete(socialAnalyses).where(eq(socialAnalyses.itemId, id));
    return true;
  });
  if (!changed) return NextResponse.json({ error: "not_dead" }, { status: 409 });
  await audit({ request: req, actor: "admin", action: "dead_letter.analysis_requeue", entityType: "social_item", entityId: id });
  return NextResponse.json({ ok: true });
}
