import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const monitoringTargets = pgTable(
  "monitoring_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("monitoring_targets_name_uidx").on(t.name), index("monitoring_targets_enabled_idx").on(t.enabled)],
);

/** OAuth owner. One Meta login can manage multiple Facebook Pages / IG accounts. */
export const metaAuthAccounts = pgTable(
  "meta_auth_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    metaUserId: text("meta_user_id").notNull(),
    metaUserName: text("meta_user_name"),
    encryptedUserAccessToken: text("encrypted_user_access_token").notNull(),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    tokenLastCheckedAt: timestamp("token_last_checked_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // active | degraded | revoked
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("meta_auth_accounts_user_uidx").on(t.metaUserId), index("meta_auth_accounts_status_idx").on(t.status)],
);

/** A concrete source we monitor. Facebook Page and Instagram account are separate rows. */
export const socialConnections = pgTable(
  "social_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authAccountId: uuid("auth_account_id").references(() => metaAuthAccounts.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // facebook | instagram
    externalAccountId: text("external_account_id").notNull(),
    displayName: text("display_name").notNull(),
    username: text("username"),
    parentPageId: text("parent_page_id"),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // active | degraded | revoked | disabled
    lastError: text("last_error"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    webhookSubscribed: boolean("webhook_subscribed").notNull().default(false),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncAttemptedAt: timestamp("sync_attempted_at", { withTimezone: true }),
    syncLockedAt: timestamp("sync_locked_at", { withTimezone: true }),
    syncLockId: text("sync_lock_id"),
    syncState: jsonb("sync_state").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_connections_platform_external_uidx").on(t.platform, t.externalAccountId),
    index("social_connections_auth_idx").on(t.authAccountId),
    index("social_connections_status_idx").on(t.status),
  ],
);

/** Explicitly maps a monitored source account to one or more reputation targets.
 * This lets second-person comments on an owned/official profile (e.g. “sen ...”)
 * be analyzed against the correct target even when the person's name is absent. */
export const connectionTargets = pgTable(
  "connection_targets",
  {
    connectionId: uuid("connection_id").notNull().references(() => socialConnections.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull().references(() => monitoringTargets.id, { onDelete: "cascade" }),
    relation: text("relation").notNull().default("owned_profile"), // owned_profile | monitored_source
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("connection_targets_connection_target_uidx").on(t.connectionId, t.targetId),
    index("connection_targets_target_idx").on(t.targetId),
    index("connection_targets_connection_idx").on(t.connectionId),
  ],
);

/** One-time OAuth nonce storage prevents replay of an otherwise-valid signed state. */
export const oauthNonces = pgTable(
  "oauth_nonces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nonceHash: text("nonce_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("oauth_nonces_hash_uidx").on(t.nonceHash), index("oauth_nonces_expiry_idx").on(t.expiresAt)],
);

/** Durable webhook queue. HTTP webhook handler only validates + enqueues. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull().default("meta"),
    objectType: text("object_type"),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | retry | processed | dead
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockId: text("lock_id"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_events_dedupe_uidx").on(t.dedupeKey),
    index("webhook_events_queue_idx").on(t.status, t.availableAt),
    index("webhook_events_lock_idx").on(t.lockedAt),
  ],
);

export const socialItems = pgTable(
  "social_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id").references(() => socialConnections.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    parentExternalId: text("parent_external_id"),
    rootExternalId: text("root_external_id"),
    itemType: text("item_type").notNull().default("comment"), // comment | reply | mention
    authorId: text("author_id"),
    authorName: text("author_name"),
    text: text("text").notNull(),
    permalink: text("permalink"),
    sourceCreatedAt: timestamp("source_created_at", { withTimezone: true }),
    reviewStatus: text("review_status").notNull().default("new"), // new | reviewed | ignored | escalated
    analysisStatus: text("analysis_status").notNull().default("pending"), // pending | processing | retry | complete | dead
    analysisAttempts: integer("analysis_attempts").notNull().default(0),
    analysisAvailableAt: timestamp("analysis_available_at", { withTimezone: true }).notNull().defaultNow(),
    analysisLockedAt: timestamp("analysis_locked_at", { withTimezone: true }),
    analysisLockId: text("analysis_lock_id"),
    analysisError: text("analysis_error"),
    raw: jsonb("raw"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_items_platform_external_uidx").on(t.platform, t.externalId),
    index("social_items_connection_idx").on(t.connectionId),
    index("social_items_ingested_idx").on(t.ingestedAt),
    index("social_items_review_idx").on(t.reviewStatus),
    index("social_items_analysis_idx").on(t.analysisStatus),
  ],
);

export const socialAnalyses = pgTable(
  "social_analyses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id").notNull().references(() => socialItems.id, { onDelete: "cascade" }),
    targetMatch: boolean("target_match").notNull().default(false),
    targetConfidence: real("target_confidence").notNull().default(0),
    matchedTarget: text("matched_target"),
    sentiment: text("sentiment").notNull(),
    category: text("category").notNull(),
    severity: integer("severity").notNull().default(0),
    containsInsult: boolean("contains_insult").notNull().default(false),
    containsThreat: boolean("contains_threat").notNull().default(false),
    containsClaim: boolean("contains_claim").notNull().default(false),
    claimText: text("claim_text"),
    needsReview: boolean("needs_review").notNull().default(false),
    summary: text("summary").notNull(),
    provider: text("provider").notNull().default("openai-compatible"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    latencyMs: integer("latency_ms"),
    raw: jsonb("raw"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_analyses_item_uidx").on(t.itemId),
    index("social_analyses_severity_idx").on(t.severity),
    index("social_analyses_sentiment_idx").on(t.sentiment),
    index("social_analyses_review_idx").on(t.needsReview),
  ],
);

export const alertOutbox = pgTable(
  "alert_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    itemId: uuid("item_id").notNull().references(() => socialItems.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    ruleKey: text("rule_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | retry | delivered | dead | cancelled
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockId: text("lock_id"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("alert_outbox_dedupe_uidx").on(t.dedupeKey),
    index("alert_outbox_queue_idx").on(t.status, t.availableAt),
    index("alert_outbox_item_idx").on(t.itemId),
    index("alert_outbox_created_idx").on(t.createdAt),
  ],
);

/** Persistent login throttling so multiple app instances share the same limits. */
export const authRateLimits = pgTable("auth_rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actor: text("actor").notNull().default("system"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    ipHash: text("ip_hash"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_created_idx").on(t.createdAt), index("audit_logs_action_idx").on(t.action)],
);
