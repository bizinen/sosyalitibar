import { describe, expect, it } from "vitest";
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPromptInput } from "@/lib/llm";

describe("LLM source-target context", () => {
  it("keeps only canonical targets explicitly mapped to the monitored source", () => {
    const built = buildAnalysisPromptInput({
      text: "Sen yine insanları yanlış yönlendiriyorsun.",
      targets: [
        { name: "Ahmet Hoca", aliases: ["Ahmet", "Ahmet Hoca"] },
        { name: "Başka Hoca", aliases: ["Başka"] },
      ],
      sourceTargets: ["Ahmet Hoca", "Uydurma Hedef", "Ahmet Hoca"],
      source: { platform: "instagram", accountUsername: "ahmethoca", itemType: "comment" },
    });

    expect(built.sourceTargets).toEqual(["Ahmet Hoca"]);
    expect(built.userObject.source_targets).toEqual(["Ahmet Hoca"]);
    expect(built.userObject.comment).toContain("Sen yine");
    expect(built.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats comment text as untrusted data in the system contract", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("GÜVENİLMEYEN VERİDİR");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("source_targets");
    expect(ANALYSIS_SYSTEM_PROMPT).toContain("isim geçmesi zorunlu değildir");
  });
});
