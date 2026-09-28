import { NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { connectionTargets, monitoringTargets, socialConnections, socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { assertSameOrigin } from "@/lib/security";

const bodySchema = z.object({
  targetIds: z.array(z.string().uuid()).max(50).default([]),
  reanalyzeExisting: z.boolean().default(true),
});

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

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
    await tx.delete(connectionTargets).where(eq(connectionTargets.connectionId, id));
    if (targetIds.length > 0) {
      await tx.insert(connectionTargets).values(targetIds.map((targetId) => ({
        connectionId: id,
        targetId,
        relation: "owned_profile",
      })));
    }

    let requeued = 0;
    if (parsed.data.reanalyzeExisting) {
      // Undelivered alerts may have been produced using the old target context.
      await tx.execute(sql`
        delete from alert_outbox
        where status <> 'delivered'
          and item_id in (select id from social_items where connection_id = ${id})
      `);
      await tx.execute(sql`
        delete from social_analyses
        where item_id in (select id from social_items where connection_id = ${id})
      `);
      const rows = await tx.update(socialItems).set({
        analysisStatus: "pending",
        analysisAttempts: 0,
        analysisAvailableAt: new Date(),
        analysisLockedAt: null,
        analysisLockId: null,
        analysisError: null,
        updatedAt: new Date(),
      }).where(eq(socialItems.connectionId, id)).returning({ id: socialItems.id });
      requeued = rows.length;
    }
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
