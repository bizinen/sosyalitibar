import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { webhookEvents } from "@/db/schema";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { audit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await params;
  const [row] = await db.update(webhookEvents).set({
    status: "pending",
    attempts: 0,
    availableAt: new Date(),
    lockedAt: null,
    lockId: null,
    error: null,
    processedAt: null,
  }).where(and(eq(webhookEvents.id, id), eq(webhookEvents.status, "dead"))).returning({ id: webhookEvents.id });
  if (!row) return NextResponse.json({ error: "not_dead" }, { status: 409 });
  await audit({ request: req, actor: "admin", action: "dead_letter.webhook_requeue", entityType: "webhook_event", entityId: id });
  return NextResponse.json({ ok: true });
}
