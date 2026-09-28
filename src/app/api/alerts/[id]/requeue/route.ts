import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { alertOutbox } from "@/db/schema";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { audit } from "@/lib/audit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await params;
  const [row] = await db.update(alertOutbox).set({
    status: "pending",
    attempts: 0,
    availableAt: new Date(),
    lockedAt: null,
    lockId: null,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(eq(alertOutbox.id, id), inArray(alertOutbox.status, ["dead", "retry"]))).returning({ id: alertOutbox.id });
  if (!row) return NextResponse.json({ error: "not_requeueable" }, { status: 409 });
  await audit({ request: req, actor: "admin", action: "alert.requeue", entityType: "alert_outbox", entityId: id });
  return NextResponse.json({ ok: true });
}
