import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { db } from "@/lib/db";
import { auditLogs, youtubeSettings } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { readResponseBody } from "@/lib/http-body";

const schema = z.object({ apiKey: z.string().trim().min(1).max(4096).refine(key => !/\s/.test(key)), revision: z.number().int().min(0) }).strict();

export async function PUT(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 8192))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_youtube_settings'))`);
      const [current] = await tx.select().from(youtubeSettings).where(eq(youtubeSettings.id, "primary")).for("update");
      if ((current?.revision ?? 0) !== parsed.data.revision) return false;
      const fields = { apiKeyEncrypted: encryptSecret(parsed.data.apiKey), revision: parsed.data.revision + 1, updatedAt: new Date() };
      if (current) await tx.update(youtubeSettings).set(fields).where(eq(youtubeSettings.id, "primary"));
      else await tx.insert(youtubeSettings).values({ id: "primary", ...fields });
      await tx.insert(auditLogs).values({ actor: "admin", action: "youtube.settings_updated", entityType: "youtube_settings", entityId: "primary", metadata: { revision: fields.revision } });
      return true;
    });
    return result ? NextResponse.json({ saved: true, revision: parsed.data.revision + 1 }) : NextResponse.json({ error: "conflict" }, { status: 409 });
  } catch { return NextResponse.json({ error: "settings_save_failed" }, { status: 500 }); }
}
