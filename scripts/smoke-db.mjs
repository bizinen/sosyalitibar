import postgres from "postgres";
import crypto from "node:crypto";
import fs from "node:fs/promises";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL gerekli");

const sql = postgres(url, { max: 1, prepare: false });

function assert(condition, message) {
  if (!condition) throw new Error(`DB smoke failed: ${message}`);
}

try {
  const expectedTables = [
    "monitoring_targets",
    "meta_auth_accounts",
    "social_connections",
    "connection_targets",
    "oauth_nonces",
    "webhook_events",
    "social_items",
    "social_analyses",
    "alert_outbox",
    "auth_rate_limits",
    "audit_logs",
    "llm_settings",
    "meta_settings",
    "alert_settings",
    "worker_heartbeats",
    "item_review_events",
    "item_translations",
    "watched_videos",
    "ai_policy",
  ];

  const tables = await sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
  `;
  const tableNames = new Set(tables.map((row) => row.table_name));
  for (const table of expectedTables) assert(tableNames.has(table), `eksik tablo: ${table}`);

  const migrations = await sql`select name, checksum from _app_migrations order by name`;
  const expectedMigrations = (await fs.readdir("migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  assert(expectedMigrations.length > 0, "migration dosyaları bulunamadı");
  for (const name of expectedMigrations) {
    const applied = migrations.find((migration) => migration.name === name);
    const checksum = crypto.createHash("sha256").update(await fs.readFile(`migrations/${name}`)).digest("hex");
    assert(applied?.checksum === checksum, `migration eksik veya checksum farklı: ${name}`);
  }

  const columns = await sql`select table_name, column_name from information_schema.columns
    where table_schema = 'public' and (table_name, column_name) in
    (('social_items', 'analysis_revision'), ('social_items', 'source_read_version'), ('social_items', 'source_checked_at'), ('social_items', 'source_unavailable_at'), ('alert_outbox', 'analysis_revision'), ('alert_outbox', 'dispatch_started_at'), ('alert_outbox', 'receiver_key'),
     ('social_analyses', 'triage_label'), ('item_translations', 'prompt_hash'), ('ai_policy', 'settings'), ('ai_policy', 'revision'),
     ('watched_videos', 'provider'), ('watched_videos', 'progress_encrypted'), ('watched_videos', 'poll_minutes'), ('watched_videos', 'lock_id'))`;
  assert(columns.length === 15, "source/analysis/dispatch/triage/policy/video columns eksik");
  const contracts = await sql`select conname from pg_constraint where contype = 'c' and convalidated
    and ((conrelid = 'public.social_analyses'::regclass and conname = 'social_analyses_triage_contract')
      or (conrelid = 'public.watched_videos'::regclass and conname = 'watched_videos_apify_platform_check'))`;
  assert(contracts.length === 2, "triage veya video provider CHECK contract eksik");

  const [fk] = await sql`
    select rc.delete_rule
    from information_schema.referential_constraints rc
    join information_schema.table_constraints tc
      on tc.constraint_catalog = rc.constraint_catalog
     and tc.constraint_schema = rc.constraint_schema
     and tc.constraint_name = rc.constraint_name
    where tc.table_schema = 'public'
      and tc.table_name = 'social_items'
      and tc.constraint_name = 'social_items_connection_id_fkey'
  `;
  assert(fk?.delete_rule === "SET NULL", `social_items connection FK SET NULL değil: ${fk?.delete_rule ?? "yok"}`);

  const extensions = await sql`select extname from pg_extension where extname in ('pgcrypto','pg_trgm')`;
  const extensionNames = new Set(extensions.map((row) => row.extname));
  assert(extensionNames.has("pgcrypto"), "pgcrypto extension eksik");
  assert(extensionNames.has("pg_trgm"), "pg_trgm extension eksik");

  const indexes = await sql`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'social_items_text_trgm_idx',
        'social_items_parent_idx',
        'social_items_ingested_id_idx',
        'social_items_analysis_queue_idx',
        'webhook_events_queue_received_idx',
        'alert_outbox_queue_created_idx',
        'social_connections_sync_attempt_idx',
        'social_connections_sync_claim_idx',
        'social_items_source_check_idx',
        'item_review_events_item_idx',
        'item_translations_revision_uidx',
        'watched_videos_queue_idx',
        'social_analyses_triage_idx'
      )
  `;
  assert(indexes.length === 13, `beklenen kritik index sayısı 13, bulunan ${indexes.length}`);

  const [connectionTargetsUnique] = await sql`
    select count(*)::int as count
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'connection_targets_connection_target_uidx'
  `;
  assert(connectionTargetsUnique?.count === 1, "connection_targets unique index eksik");

  console.log(JSON.stringify({
    ok: true,
    migrations: migrations.length,
    tables: expectedTables.length,
    extensions: [...extensionNames].sort(),
    criticalIndexes: indexes.length,
  }));
} finally {
  await sql.end();
}
