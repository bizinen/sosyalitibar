import { NextResponse } from "next/server";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { socialItems } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { decodeItemCursor } from "@/lib/cursor";
import { readResponseBody } from "@/lib/http-body";
import { assertSameOrigin } from "@/lib/security";

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  let input: { after?: string; ids?: unknown } = { after: params.get("after") ?? undefined, ids: params.get("ids")?.split(",").filter(Boolean) ?? [] };
  if (req.method === "POST") {
    if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
    try { input = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 65536))); }
    catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
    if (!input || typeof input !== "object") return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const cursor = decodeItemCursor(typeof input.after === "string" ? input.after : undefined);
  if (!cursor) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  const ids = z.array(z.string().uuid()).max(req.method === "POST" ? 1000 : 100).safeParse(input.ids);
  if (!ids.success) return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
  const at = sql`${cursor.preciseAt ?? cursor.at.toISOString()}::timestamptz`;
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(socialItems).where(and(isNull(socialItems.deletedAt),
    or(gt(socialItems.ingestedAt, at), and(eq(socialItems.ingestedAt, at), gt(socialItems.id, cursor.id)))));
  const updates = ids.data.length ? await db.select({ id: socialItems.id, revision: socialItems.analysisRevision,
    status: socialItems.analysisStatus, reviewStatus: socialItems.reviewStatus, updatedAt: socialItems.updatedAt,
  }).from(socialItems).where(inArray(socialItems.id, ids.data)) : [];
  return NextResponse.json({ count: row?.count ?? 0, updates }, { headers: { "Cache-Control": "no-store" } });
}

export const POST = GET;
