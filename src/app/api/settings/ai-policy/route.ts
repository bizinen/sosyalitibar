import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { db } from "@/lib/db";
import { aiPolicy, auditLogs } from "@/db/schema";
import { aiPolicySchema } from "@/lib/triage-contract";
import { readResponseBody } from "@/lib/http-body";

export async function PUT(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 320000))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = z.object({ policy: aiPolicySchema, revision: z.number().int().min(0) }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const saved = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_ai_policy'))`);
      const [current] = await tx.select().from(aiPolicy).where(eq(aiPolicy.id, "primary")).for("update");
      if ((current?.revision ?? 0) !== parsed.data.revision) return false;
      const fields = { settings: parsed.data.policy, revision: parsed.data.revision + 1, updatedAt: new Date() };
      await tx.insert(aiPolicy).values({ id: "primary", ...fields }).onConflictDoUpdate({ target: aiPolicy.id, set: fields });
      await tx.insert(auditLogs).values({ actor: "admin", action: "ai.policy_updated", entityType: "ai_policy", entityId: "primary", metadata: { ...fields, previous: current?.settings ?? null } });
      return true;
    });
    return saved ? NextResponse.json({ saved: true, revision: parsed.data.revision + 1 }) : NextResponse.json({ error: "conflict" }, { status: 409 });
  } catch { return NextResponse.json({ error: "settings_save_failed" }, { status: 500 }); }
}
