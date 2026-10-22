import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { collectWatchedVideos } from "@/lib/watched-videos";

export async function POST(req: Request) {
  if (!safeEqual(req.headers.get("authorization") ?? "", `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ results: await collectWatchedVideos() });
}
