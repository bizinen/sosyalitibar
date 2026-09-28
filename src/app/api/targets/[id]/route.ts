import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { monitoringTargets } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { audit } from "@/lib/audit";

const patchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  enabled: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, "empty patch");

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  const patch = { ...parsed.data, updatedAt: new Date() } as typeof parsed.data & { updatedAt: Date };
  if (patch.aliases) patch.aliases = [...new Set(patch.aliases.map((x) => x.trim()).filter(Boolean))];
  const [row] = await db.update(monitoringTargets).set(patch).where(eq(monitoringTargets.id, id)).returning();
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await audit({ request: req, actor: "admin", action: "target.updated", entityType: "monitoring_target", entityId: id });
  return NextResponse.json(row);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const [row] = await db.delete(monitoringTargets).where(eq(monitoringTargets.id, id)).returning({ id: monitoringTargets.id, name: monitoringTargets.name });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await audit({ request: req, actor: "admin", action: "target.deleted", entityType: "monitoring_target", entityId: id, metadata: { name: row.name } });
  return NextResponse.json({ deleted: true });
}
