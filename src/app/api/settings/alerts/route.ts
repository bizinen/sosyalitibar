import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { z } from "zod";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertOutbox, alertSettings, auditLogs } from "@/db/schema";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { encryptSecret } from "@/lib/crypto";
import { env } from "@/lib/config";
import { readResponseBody } from "@/lib/http-body";

const schema = z.object({ enabled: z.boolean(), webhookUrl: z.string().trim().max(2048),
  secret: z.string().trim().max(4096).refine((value) => !value || value.length >= 32).optional(),
  severityThreshold: z.number().int().min(0).max(100), onThreat: z.boolean(), revision: z.number().int().min(0),
}).strict();

export async function PUT(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 8192))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const value = parsed.data;
  if (value.webhookUrl) {
    try { const url = new URL(value.webhookUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid_url");
    } catch { return NextResponse.json({ error: "https_endpoint_required" }, { status: 400 }); }
  }
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_alert_settings'))`);
      const [current] = await tx.select().from(alertSettings).where(eq(alertSettings.id, "primary")).for("update");
      if ((current?.revision ?? 0) !== value.revision) return "conflict";
      const [inFlight] = await tx.select({ id: alertOutbox.id }).from(alertOutbox).where(eq(alertOutbox.status, "processing")).limit(1);
      if (inFlight) return "delivery_in_progress";
      const endpoint = value.webhookUrl || null;
      const previousEndpoint = current ? current.webhookUrl : env().ALERT_WEBHOOK_URL;
      if (endpoint && endpoint !== previousEndpoint && !value.secret) return "new_receiver_secret_required";
      const encrypted = value.secret ? encryptSecret(value.secret) : current ? current.secretEncrypted
        : env().ALERT_WEBHOOK_SECRET ? encryptSecret(env().ALERT_WEBHOOK_SECRET!) : null;
      if (value.enabled && (!endpoint || !encrypted)) return "connection_required";
      if (previousEndpoint) await tx.update(alertOutbox).set({ receiverKey: crypto.createHash("sha256").update(previousEndpoint).digest("hex") })
        .where(and(isNull(alertOutbox.receiverKey), inArray(alertOutbox.status, ["pending", "retry", "dead"])));
      const fields = { enabled: value.enabled, webhookUrl: endpoint, secretEncrypted: encrypted,
        severityThreshold: value.severityThreshold, onThreat: value.onThreat, revision: value.revision + 1, updatedAt: new Date() };
      if (current) await tx.update(alertSettings).set(fields).where(eq(alertSettings.id, "primary"));
      else await tx.insert(alertSettings).values({ id: "primary", ...fields });
      await tx.insert(auditLogs).values({ actor: "admin", action: "alerts.settings_updated", entityType: "alert_settings", entityId: "primary",
        metadata: { enabled: value.enabled, revision: fields.revision, secretChanged: Boolean(value.secret), severityThreshold: value.severityThreshold, onThreat: value.onThreat } });
      return "saved";
    });
    return result === "saved" ? NextResponse.json({ saved: true, revision: value.revision + 1 })
      : NextResponse.json({ error: result }, { status: result === "conflict" || result === "delivery_in_progress" ? 409 : 400 });
  } catch { return NextResponse.json({ error: "settings_save_failed" }, { status: 500 }); }
}
