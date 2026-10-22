import { and, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alertOutbox, socialAnalyses, socialItems } from "@/db/schema";
import type { Transaction } from "@/lib/db";

// Readers share this lock only while taking a context snapshot or committing a result.
export async function lockAnalysisContext(tx: Transaction, write = false) {
  await tx.execute(write
    ? sql`select pg_advisory_xact_lock(1936289380, 1)`
    : sql`select pg_advisory_xact_lock_shared(1936289380, 1)`);
}

export async function invalidateAnalyses(tx: Transaction, filter?: SQL) {
  const condition = and(isNull(socialItems.deletedAt), isNull(socialItems.sourceUnavailableAt), filter)!;
  const changed = await tx.execute(sql`
    with locked as materialized (
      select id from social_items where ${condition} order by id for update
    ), changed as (
      update social_items set analysis_status = case when analysis_excluded then 'complete' else 'pending' end, analysis_attempts = 0,
        analysis_available_at = now(), analysis_locked_at = null, analysis_lock_id = null,
        analysis_error = null, review_status = 'new', analysis_revision = analysis_revision + 1, updated_at = now()
      from locked where social_items.id = locked.id returning social_items.id
    ) select count(*)::int as count from changed
  `);
  const items = tx.select({ id: socialItems.id }).from(socialItems).where(condition);
  await tx.delete(socialAnalyses).where(inArray(socialAnalyses.itemId, items));
  await tx.update(alertOutbox).set({
    status: "cancelled", lockedAt: null, lockId: null,
    lastError: "analysis context changed", updatedAt: new Date(),
  }).where(and(inArray(alertOutbox.itemId, items), sql`(${alertOutbox.status} in ('pending', 'retry', 'dead') or (${alertOutbox.status} = 'processing' and ${alertOutbox.dispatchStartedAt} is null))`));
  return Number(changed[0]?.count ?? 0);
}
