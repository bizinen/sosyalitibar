import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL gerekli");
const sql = postgres(url, { max: 1, prepare: false });
const migrationDir = path.resolve("migrations");

try {
  await sql`create table if not exists _app_migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`;
  await sql`select pg_advisory_lock(hashtext('sosyal_itibar_migrations'))`;
  const names = (await fs.readdir(migrationDir)).filter((x) => /^\d+.*\.sql$/.test(x)).sort();
  for (const name of names) {
    const body = await fs.readFile(path.join(migrationDir, name), "utf8");
    const checksum = crypto.createHash("sha256").update(body).digest("hex");
    const [applied] = await sql`select checksum from _app_migrations where name = ${name}`;
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`Migration checksum değişti: ${name}`);
      continue;
    }
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into _app_migrations (name, checksum) values (${name}, ${checksum})`;
    });
    console.log(`applied ${name}`);
  }
} finally {
  try { await sql`select pg_advisory_unlock(hashtext('sosyal_itibar_migrations'))`; } catch {}
  await sql.end();
}
