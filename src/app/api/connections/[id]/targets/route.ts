import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { connectionTargets, monitoringTargets, socialConnections, socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { invalidateAnalyses, lockAnalysisContext } from "@/lib/analysis-state";
import { assertSameOrigin } from "@/lib/security";

const bodySchema = z.object({
  targetIds: z.array(z.string().uuid()).max(50),
  reanalyzeExisting: z.literal(true).optional(),
});

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_connection_id" }, { status: 400 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });

  const targetIds = [...new Set(parsed.data.targetIds)];
  const connection = await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, id) });
  if (!connection) return NextResponse.json({ error: "connection_not_found" }, { status: 404 });

  if (targetIds.length > 0) {
    const existing = await db.select({ id: monitoringTargets.id }).from(monitoringTargets).where(inArray(monitoringTargets.id, targetIds));
    if (existing.length !== targetIds.length) return NextResponse.json({ error: "target_not_found" }, { status: 400 });
  }

  const result = await db.transaction(async (tx) => {
    await lockAnalysisContext(tx, true);
    const previous = await tx.select({ id: connectionTargets.targetId }).from(connectionTargets).where(eq(connectionTargets.connectionId, id));
    if (JSON.stringify(previous.map((t) => t.id).sort()) === JSON.stringify([...targetIds].sort())) return { requeued: 0 };
    await tx.delete(connectionTargets).where(eq(connectionTargets.connectionId, id));
    if (targetIds.length > 0) {
      await tx.insert(connectionTargets).values(targetIds.map((targetId) => ({
        connectionId: id,
        targetId,
        relation: "owned_profile",
      })));
    }

    const requeued = await invalidateAnalyses(tx, eq(socialItems.connectionId, id));
    return { requeued };
  });

  await audit({
    request: req,
    actor: "admin",
    action: "connection.targets_changed",
    entityType: "social_connection",
    entityId: id,
    metadata: { platform: connection.platform, externalAccountId: connection.externalAccountId, targetIds, requeued: result.requeued },
  });

  return NextResponse.json({ ok: true, targetIds, requeued: result.requeued });
}
