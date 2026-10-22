import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiPolicy } from "@/db/schema";
import { aiPolicySchema, defaultAiPolicy } from "@/lib/triage-contract";

export async function getAiPolicy() {
  const [row] = await db.select().from(aiPolicy).where(eq(aiPolicy.id, "primary"));
  return { policy: row ? aiPolicySchema.parse(row.settings) : defaultAiPolicy, policyRevision: row?.revision ?? 0 };
}
