import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { syncAllConnections } from "@/lib/sync";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!safeEqual(auth, `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await syncAllConnections();
  return NextResponse.json({ results });
}
