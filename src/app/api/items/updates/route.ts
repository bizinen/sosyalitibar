import { NextResponse } from "next/server";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { decodeItemCursor } from "@/lib/cursor";

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const cursor = decodeItemCursor(params.get("after") ?? undefined);
  if (!cursor) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  const ids = z.array(z.string().uuid()).max(100).safeParse(params.get("ids")?.split(",").filter(Boolean) ?? []);
  if (!ids.success) return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
  const at = sql`${cursor.preciseAt ?? cursor.at.toISOString()}::timestamptz`;
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(socialItems).where(and(isNull(socialItems.deletedAt),
    or(gt(socialItems.ingestedAt, at), and(eq(socialItems.ingestedAt, at), gt(socialItems.id, cursor.id)))));
  const updates = ids.data.length ? await db.select({ id: socialItems.id, revision: socialItems.analysisRevision,
    status: socialItems.analysisStatus, reviewStatus: socialItems.reviewStatus, updatedAt: socialItems.updatedAt,
  }).from(socialItems).where(inArray(socialItems.id, ids.data)) : [];
  return NextResponse.json({ count: row?.count ?? 0, updates }, { headers: { "Cache-Control": "no-store" } });
}
