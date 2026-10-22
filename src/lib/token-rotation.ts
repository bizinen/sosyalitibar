import { sql } from "drizzle-orm";
import { alertSettings, llmSettings, metaSettings, metaAuthAccounts, socialConnections, watchedVideos, youtubeSettings } from "@/db/schema";
import { db } from "@/lib/db";
import { currentSecretPrefix, decryptSecret, encryptSecret, secretNeedsRotation } from "@/lib/crypto";

export async function rotateStoredTokens() {
  const summary = { rotated: 0, failed: 0, remaining: 0 };
  const currentPattern = `${currentSecretPrefix()}%`;
  for (const [table, column] of [
    [metaAuthAccounts, metaAuthAccounts.encryptedUserAccessToken],
    [socialConnections, socialConnections.encryptedAccessToken],
    [llmSettings, llmSettings.apiKeyEncrypted],
    [youtubeSettings, youtubeSettings.apiKeyEncrypted],
    [watchedVideos, watchedVideos.apiKeyEncrypted],
    [watchedVideos, watchedVideos.progressEncrypted],
    [metaSettings, metaSettings.appSecretEncrypted],
    [metaSettings, metaSettings.verifyTokenEncrypted],
    [alertSettings, alertSettings.secretEncrypted],
  ] as const) {
    const rows = await db.execute(sql`
      select id, ${column} as ciphertext from ${table}
      where ${column} not like ${currentPattern} order by updated_at, id limit 100
    `);
    for (const row of rows) {
      const previous = String(row.ciphertext);
      if (!secretNeedsRotation(previous)) continue;
      try {
        const encrypted = encryptSecret(decryptSecret(previous));
        const changed = await db.execute(sql`
          update ${table} set ${sql.identifier(column.name)} = ${encrypted}, updated_at = now()
          where id = ${row.id} and ${column} = ${previous} returning id
        `);
        summary.rotated += changed.length;
      } catch {
        // Continue rotating other rows; never expose ciphertext or decrypted tokens in errors.
        summary.failed++;
      }
    }
    const remaining = await db.execute(sql`select count(*)::int as count from ${table} where ${column} not like ${currentPattern}`);
    summary.remaining += Number(remaining[0]?.count ?? 0);
  }
  const continuations = await db.execute(sql`
    select id, sync_state->>'continuation' as ciphertext from social_connections
    where sync_state->>'continuation' is not null and sync_state->>'continuation' not like ${currentPattern}
    order by updated_at, id limit 100
  `);
  for (const row of continuations) {
    const previous = String(row.ciphertext);
    try {
      const encrypted = encryptSecret(decryptSecret(previous));
      const changed = await db.execute(sql`
        update social_connections set sync_state = jsonb_set(sync_state, '{continuation}', to_jsonb(${encrypted}::text)), updated_at = now()
        where id = ${row.id} and sync_state->>'continuation' = ${previous} returning id
      `);
      summary.rotated += changed.length;
    } catch { summary.failed++; }
  }
  const pending = await db.execute(sql`select count(*)::int as count from social_connections
    where sync_state->>'continuation' is not null and sync_state->>'continuation' not like ${currentPattern}`);
  summary.remaining += Number(pending[0]?.count ?? 0);
  return summary;
}
