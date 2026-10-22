export const LLM_PROVIDERS = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", modelHint: "OpenAI model kimliği" },
  { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", modelHint: "Gemini model kimliği" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelHint: "yayıncı/model kimliği" },
  { id: "runware", name: "Runware", baseUrl: "https://api.runware.ai/v1", modelHint: "Runware AIR model kimliği" },
] as const;

export type LlmProviderId = typeof LLM_PROVIDERS[number]["id"] | "custom";
export type LlmProviderProfile = { provider: LlmProviderId; model: string; hasKey: boolean };

export function llmProviderId(baseUrl: string): LlmProviderId {
  const normalized = new URL(baseUrl).toString().replace(/\/+$/, "");
  return LLM_PROVIDERS.find((provider) => provider.baseUrl === normalized)?.id ?? "custom";
}

export function llmRequestOptions(baseUrl: string, tokenLimit: number, temperature: number) {
  const provider = llmProviderId(baseUrl);
  return {
    ...(provider === "openai" || provider === "runware"
      ? { max_completion_tokens: Math.max(tokenLimit, 8192) }
      : { max_tokens: provider === "custom" ? tokenLimit : Math.max(tokenLimit, 8192) }),
    ...(provider === "custom" ? { temperature } : {}),
    ...(provider === "openrouter" ? { provider: { require_parameters: true } } : {}),
  };
}
