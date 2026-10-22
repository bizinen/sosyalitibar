import { eq } from "drizzle-orm";
import { db, type Transaction } from "@/lib/db";
import { alertSettings } from "@/db/schema";
import { env } from "@/lib/config";
import { decryptSecret } from "@/lib/crypto";

export async function getAlertSettings(connection: Transaction | typeof db = db) {
  const [row] = await connection.select().from(alertSettings).where(eq(alertSettings.id, "primary"));
  const defaults = env();
  const secret = row?.secretEncrypted ? decryptSecret(row.secretEncrypted) : row ? undefined : defaults.ALERT_WEBHOOK_SECRET;
  const endpoint = row ? row.webhookUrl || undefined : defaults.ALERT_WEBHOOK_URL;
  const enabled = row ? row.enabled : Boolean(endpoint && secret);
  return { ...defaults, ALERT_WEBHOOK_URL: enabled ? endpoint : undefined, ALERT_WEBHOOK_SECRET: enabled ? secret : undefined,
    ALERT_SEVERITY_THRESHOLD: row?.severityThreshold ?? defaults.ALERT_SEVERITY_THRESHOLD,
    ALERT_ON_THREAT: row?.onThreat ?? defaults.ALERT_ON_THREAT,
    alertSettingsRevision: row?.revision ?? 0, alertEnabled: enabled, alertEndpoint: endpoint ?? "", alertHasSecret: Boolean(secret),
  };
}
