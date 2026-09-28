import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { checkAllConnections } from "@/lib/connection-health";
import { audit } from "@/lib/audit";

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const results = await checkAllConnections();
  await audit({ request: req, actor: "admin", action: "meta.health.checked", metadata: { count: results.length, degraded: results.filter((x) => x.status !== "active").length } });
  return NextResponse.json({ results });
}
