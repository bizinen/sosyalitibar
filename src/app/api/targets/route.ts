import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { monitoringTargets } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { invalidateAnalyses, lockAnalysisContext } from "@/lib/analysis-state";
import { audit } from "@/lib/audit";

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await db.select().from(monitoringTargets).orderBy(asc(monitoringTargets.name)));
}

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  const aliases = [...new Set(parsed.data.aliases.map((x) => x.trim()).filter(Boolean))];
  try {
    const row = await db.transaction(async (tx) => {
      await lockAnalysisContext(tx, true);
      const [created] = await tx.insert(monitoringTargets).values({ ...parsed.data, aliases }).returning();
      await invalidateAnalyses(tx);
      return created;
    });
    await audit({ request: req, actor: "admin", action: "target.created", entityType: "monitoring_target", entityId: row?.id, metadata: { name: parsed.data.name } });
    return NextResponse.json(row, { status: 201 });
  } catch {
    return NextResponse.json({ error: "target_create_failed" }, { status: 409 });
  }
}
