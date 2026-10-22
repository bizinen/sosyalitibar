import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { llmSettings } from "@/db/schema";
import { env } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";
import { getAiPolicy } from "@/lib/ai-policy";
import { LLM_PROVIDERS, llmProviderId, type LlmProviderProfile } from "@/lib/llm-providers";

export async function getLlmSettings() {
  const [row] = await db.select().from(llmSettings).where(eq(llmSettings.id, "primary"));
  const defaults = env();
  const policy = await getAiPolicy();
  if (!row) return { ...defaults, ...policy, settingsRevision: 0 };
  const key = decryptSecret(row.apiKeyEncrypted);
  return { ...defaults, ...policy, LLM_BASE_URL: row.baseUrl, LLM_MODEL: row.model, LLM_API_KEY: key, settingsRevision: row.revision };
}

export async function getLlmProviderProfiles(): Promise<LlmProviderProfile[]> {
  const rows = await db.select({ id: llmSettings.id, baseUrl: llmSettings.baseUrl, model: llmSettings.model }).from(llmSettings);
  const defaults = env();
  return LLM_PROVIDERS.flatMap((provider) => {
    const row = rows.find((entry) => entry.id === `provider:${provider.id}` && llmProviderId(entry.baseUrl) === provider.id);
    if (row) return [{ provider: provider.id, model: row.model, hasKey: true }];
    return llmProviderId(defaults.LLM_BASE_URL) === provider.id && defaults.LLM_API_KEY !== "local-not-configured"
      ? [{ provider: provider.id, model: defaults.LLM_MODEL === "local-not-configured" ? "" : defaults.LLM_MODEL, hasKey: true }] : [];
  });
}
