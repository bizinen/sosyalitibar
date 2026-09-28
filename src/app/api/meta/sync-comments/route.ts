import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { syncAllConnections } from "@/lib/sync";
import { audit } from "@/lib/audit";

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let connectionId: string | undefined;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const parsed = z.object({ connectionId: z.string().uuid().optional() }).safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    connectionId = parsed.data.connectionId;
  }
  const results = await syncAllConnections(connectionId);
  await audit({ request: req, actor: "admin", action: "meta.sync.manual", metadata: { connectionId: connectionId ?? null, results: results.map((x) => ({ connectionId: x.connectionId, ok: x.ok, items: x.items })) } });
  return NextResponse.json({ results });
}
