import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { checkAllConnections } from "@/lib/connection-health";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!safeEqual(auth, `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ results: await checkAllConnections() });
}
