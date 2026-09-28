import postgres from "postgres";

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
  ];

  const tables = await sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
  `;
  const tableNames = new Set(tables.map((row) => row.table_name));
  for (const table of expectedTables) assert(tableNames.has(table), `eksik tablo: ${table}`);

  const migrations = await sql`select name from _app_migrations order by name`;
  assert(migrations.length >= 6, `beklenen migration sayısı >= 6, bulunan ${migrations.length}`);

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
        'social_items_ingested_id_idx',
        'social_items_analysis_queue_idx',
        'webhook_events_queue_received_idx',
        'alert_outbox_queue_created_idx',
        'social_connections_sync_attempt_idx',
        'social_connections_sync_claim_idx'
      )
  `;
  assert(indexes.length === 7, `beklenen kritik index sayısı 7, bulunan ${indexes.length}`);

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
