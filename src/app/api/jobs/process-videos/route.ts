import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { collectWatchedVideos } from "@/lib/watched-videos";

export async function POST(req: Request) {
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await collectWatchedVideos();
  return NextResponse.json({ results, claimed: results.length, hasMore: results.length === Math.min(2, env().SYNC_CONCURRENCY),
    succeeded: results.filter((row) => !("error" in row)).length, failed: results.filter((row) => "error" in row).length });
}
