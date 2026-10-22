import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
  const authFailures = id === "auth-failures";
  if (!authFailures && !z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const changed = await db.transaction(async (tx) => {
    await lockAnalysisContext(tx, true);
    const candidates = authFailures ? await tx.select({ id: socialItems.id }).from(socialItems).where(and(
      eq(socialItems.analysisStatus, "dead"), isNull(socialItems.deletedAt), isNull(socialItems.sourceUnavailableAt),
      eq(socialItems.reviewStatus, "new"), sql`${socialItems.analysisError} ~ '(^|[^0-9])401([^0-9]|$)'`,
    )).orderBy(socialItems.id).limit(100).for("update", { skipLocked: true }) : [{ id }];
    if (!candidates.length) return 0;
    const rows = await tx.update(socialItems).set({
      reviewStatus: "new",
      analysisStatus: "pending",
      analysisRevision: sql`${socialItems.analysisRevision} + 1`,
      analysisAttempts: 0,
      analysisAvailableAt: new Date(),
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: null,
      updatedAt: new Date(),
    }).where(and(inArray(socialItems.id, candidates.map((row) => row.id)), eq(socialItems.analysisStatus, "dead"), isNull(socialItems.deletedAt))).returning({ id: socialItems.id });
    if (!rows.length) return 0;
    await tx.update(alertOutbox).set({ status: "cancelled", lockedAt: null, lockId: null, lastError: "analysis requeued", updatedAt: new Date() })
      .where(and(inArray(alertOutbox.itemId, rows.map((row) => row.id)), sql`(${alertOutbox.status} in ('pending', 'retry', 'dead') or (${alertOutbox.status} = 'processing' and ${alertOutbox.dispatchStartedAt} is null))`));
    await tx.delete(socialAnalyses).where(inArray(socialAnalyses.itemId, rows.map((row) => row.id)));
    await audit({ request: req, actor: "admin", action: "dead_letter.analysis_requeue", entityType: "social_item",
      ...(!authFailures ? { entityId: id } : {}), metadata: { reason: authFailures ? "authentication_recovery" : "manual", ids: rows.map((row) => row.id) } }, tx);
    return rows.length;
  });
  if (!changed && !authFailures) return NextResponse.json({ error: "not_dead" }, { status: 409 });
  return NextResponse.json({ ok: true, count: changed });
}
