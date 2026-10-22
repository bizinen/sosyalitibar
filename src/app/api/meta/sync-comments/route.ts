import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { syncAllConnections } from "@/lib/sync";
import { audit } from "@/lib/audit";

export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let connectionId: string | undefined;
  let retryFailed = false;
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const parsed = z.object({ connectionId: z.string().uuid().optional(), retryFailed: z.boolean().optional() }).safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    connectionId = parsed.data.connectionId;
    retryFailed = parsed.data.retryFailed ?? false;
    if (retryFailed && !connectionId) return NextResponse.json({ error: "connection_required" }, { status: 400 });
  }
  const results = await syncAllConnections(connectionId, false, retryFailed);
  await audit({ request: req, actor: "admin", action: "meta.sync.manual", metadata: { connectionId: connectionId ?? null, retryFailed, results: results.map((x) => ({ connectionId: x.connectionId, ok: x.ok, items: x.items })) } });
  return NextResponse.json({ results });
}
