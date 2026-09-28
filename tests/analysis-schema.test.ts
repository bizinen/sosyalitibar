import { describe, expect, it } from "vitest";
import { analysisSchema } from "@/lib/llm";

describe("analysis schema", () => {
  it("accepts a bounded neutral result", () => {
    expect(analysisSchema.parse({
      target_match: true, target_confidence: 0.8, matched_target: "Örnek Hoca",
      sentiment: "neutral", category: "criticism", severity: 25,
      contains_insult: false, contains_threat: false, contains_claim: false,
      claim_text: null, needs_review: false, summary: "Normal eleştiri.",
    }).severity).toBe(25);
  });
  it("rejects severity above 100", () => {
    expect(() => analysisSchema.parse({
      target_match: false, target_confidence: 0, matched_target: null,
      sentiment: "negative", category: "other", severity: 101,
      contains_insult: false, contains_threat: false, contains_claim: false,
      claim_text: null, needs_review: false, summary: "x",
    })).toThrow();
  });
});
