import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { socialConnections } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { assertSameOrigin } from "@/lib/security";

const patchSchema = z.object({ status: z.enum(["active", "disabled"]) });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const existing = await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, id) });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (parsed.data.status === "active" && existing.status === "revoked") {
    return NextResponse.json({ error: "reauthorization_required" }, { status: 409 });
  }

  const [row] = await db.update(socialConnections).set({
    status: parsed.data.status,
    lastError: parsed.data.status === "active" ? null : existing.lastError,
    updatedAt: new Date(),
  }).where(eq(socialConnections.id, id)).returning();

  await audit({ request: req, actor: "admin", action: `connection.${parsed.data.status}`, entityType: "social_connection", entityId: id, metadata: { platform: existing.platform, externalAccountId: existing.externalAccountId } });
  return NextResponse.json(row);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const existing = await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, id) });
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.delete(socialConnections).where(eq(socialConnections.id, id));
  await audit({ request: req, actor: "admin", action: "connection.disconnected", entityType: "social_connection", entityId: id, metadata: { platform: existing.platform, externalAccountId: existing.externalAccountId, historyPreserved: true } });
  return NextResponse.json({ ok: true });
}
