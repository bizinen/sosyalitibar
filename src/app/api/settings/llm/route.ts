import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { db } from "@/lib/db";
import { auditLogs, llmSettings } from "@/db/schema";
import { env } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { readResponseBody } from "@/lib/http-body";
import { llmProviderId } from "@/lib/llm-providers";

const schema = z.object({
  provider: z.enum(["openai", "gemini", "openrouter", "runware", "custom"]).optional(),
  baseUrl: z.string().trim().url().max(500),
  model: z.string().trim().min(1).max(200).refine((v) => v !== "local-not-configured"),
  apiKey: z.string().trim().max(4096).refine((key) => !/\s/.test(key)).optional(),
  revision: z.number().int().min(0),
}).strict();

export async function PUT(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 8192))); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const value = parsed.data;
  const url = new URL(value.baseUrl);
  const providerId = llmProviderId(value.baseUrl);
  if (value.provider && value.provider !== providerId) return NextResponse.json({ error: "invalid_provider_url" }, { status: 400 });
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.protocol === "http:" && !loopback)) return NextResponse.json({ error: "invalid_provider_url" }, { status: 400 });
  try {
    const result = await db.transaction(async (tx) => {
      // Serialize first creation and subsequent updates across app instances.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_llm_settings'))`);
      const [current] = await tx.select().from(llmSettings).where(eq(llmSettings.id, "primary")).for("update");
      if ((current?.revision ?? 0) !== value.revision) return "conflict";
      const previousUrl = current?.baseUrl || env().LLM_BASE_URL;
      const profileId = providerId === "custom" ? null : `provider:${providerId}`;
      const [profile] = profileId ? await tx.select().from(llmSettings).where(eq(llmSettings.id, profileId)).for("update") : [];
      const sameEndpoint = new URL(previousUrl).toString().replace(/\/+$/, "") === url.toString().replace(/\/+$/, "");
      const sameEnvironmentEndpoint = new URL(env().LLM_BASE_URL).toString().replace(/\/+$/, "") === url.toString().replace(/\/+$/, "");
      const storedKey = sameEndpoint && current ? current.apiKeyEncrypted : profile && llmProviderId(profile.baseUrl) === providerId ? profile.apiKeyEncrypted : undefined;
      if (!value.apiKey && !storedKey && !sameEnvironmentEndpoint) return "provider_key_required";
      const key = value.apiKey || (storedKey ? decryptSecret(storedKey) : sameEnvironmentEndpoint ? env().LLM_API_KEY : "");
      if (!key || key === "local-not-configured") return "api_key_required";
      const fields = { baseUrl: url.toString().replace(/\/+$/, ""), model: value.model, apiKeyEncrypted: encryptSecret(key), revision: value.revision + 1, updatedAt: new Date() };
      const previousProvider = llmProviderId(previousUrl);
      if (previousProvider !== "custom" && previousProvider !== providerId && current) {
        await tx.insert(llmSettings).values({ ...current, id: `provider:${previousProvider}` }).onConflictDoNothing();
      }
      if (profileId) await tx.insert(llmSettings).values({ id: profileId, ...fields }).onConflictDoUpdate({ target: llmSettings.id, set: fields });
      if (current) await tx.update(llmSettings).set(fields).where(and(eq(llmSettings.id, "primary"), eq(llmSettings.revision, value.revision)));
      else await tx.insert(llmSettings).values({ id: "primary", ...fields });
      await tx.insert(auditLogs).values({ actor: "admin", action: "llm.settings_updated", entityType: "llm_settings", entityId: "primary", metadata: { model: value.model, provider: providerId, providerHost: url.hostname, revision: fields.revision, keyChanged: Boolean(value.apiKey) } });
      return "saved";
    });
    return result === "saved" ? NextResponse.json({ saved: true, revision: value.revision + 1 }) : NextResponse.json({ error: result }, { status: result === "conflict" ? 409 : 400 });
  } catch { return NextResponse.json({ error: "settings_save_failed" }, { status: 500 }); }
}
