import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const started = Date.now();
  try {
    await db.execute(sql`select 1 as ok`);
    return NextResponse.json({ status: "ok", db: "ok", latencyMs: Date.now() - started }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "degraded", db: "error", latencyMs: Date.now() - started }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
