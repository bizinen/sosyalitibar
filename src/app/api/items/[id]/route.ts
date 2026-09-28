import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { audit } from "@/lib/audit";

const schema = z.object({ reviewStatus: z.enum(["new", "reviewed", "ignored", "escalated"]) });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const [row] = await db.update(socialItems).set({ reviewStatus: parsed.data.reviewStatus, updatedAt: new Date() }).where(eq(socialItems.id, id)).returning();
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await audit({ request: req, actor: "admin", action: "social_item.review_status_changed", entityType: "social_item", entityId: id, metadata: { reviewStatus: parsed.data.reviewStatus } });
  return NextResponse.json(row);
}
