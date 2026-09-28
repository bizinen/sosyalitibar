import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { socialAnalyses, socialItems } from "@/db/schema";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { audit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await params;
  const changed = await db.transaction(async (tx) => {
    const [row] = await tx.update(socialItems).set({
      analysisStatus: "pending",
      analysisAttempts: 0,
      analysisAvailableAt: new Date(),
      analysisLockedAt: null,
      analysisLockId: null,
      analysisError: null,
      updatedAt: new Date(),
    }).where(and(eq(socialItems.id, id), eq(socialItems.analysisStatus, "dead"))).returning({ id: socialItems.id });
    if (!row) return false;
    await tx.delete(socialAnalyses).where(eq(socialAnalyses.itemId, id));
    return true;
  });
  if (!changed) return NextResponse.json({ error: "not_dead" }, { status: 409 });
  await audit({ request: req, actor: "admin", action: "dead_letter.analysis_requeue", entityType: "social_item", entityId: id });
  return NextResponse.json({ ok: true });
}
