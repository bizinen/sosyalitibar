import { z } from "zod";

export const reviewStatusSchema = z.enum(["new", "reviewed", "ignored", "escalated"]);
export const humanAssessmentSchema = z.object({
  verdict: z.enum(["attack", "criticism", "uncertain"]),
  category: z.enum(["criticism", "insult", "accusation", "threat", "mockery", "spam", "support", "other"]),
  severity: z.number().int().min(0).max(100),
  targetMatch: z.boolean(),
  matchedTarget: z.string().trim().min(2).max(120).nullable(),
  reason: z.string().trim().min(3).max(2000),
}).strict().refine((value) => value.targetMatch === Boolean(value.matchedTarget), "Hedef eşleşmesi ve hedef adı tutarlı olmalı")
  .refine((value) => value.verdict !== "attack" || value.targetMatch, "Onaylanan saldırı izlenen kişi veya kurumla eşleşmeli");

export type HumanAssessment = z.infer<typeof humanAssessmentSchema>;
