import { auditLogs } from "@/db/schema";
import { db } from "@/lib/db";
import { clientIp, hashIdentifier } from "@/lib/security";

export async function audit(input: {
  request?: Request;
  actor?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}) {
  const ip = input.request ? clientIp(input.request) : null;
  await db.insert(auditLogs).values({
    actor: input.actor || "system",
    action: input.action,
    entityType: input.entityType || null,
    entityId: input.entityId || null,
    ipHash: ip ? hashIdentifier(ip) : null,
    metadata: input.metadata || {},
  });
}
