import type { Pool } from "pg";
import { initialSchema } from "./migrations/0001-initial.ts";
import { inTransaction } from "./pool.ts";

const migrations = [{ version: 1, sql: initialSchema }];
const knownVersions = migrations.map(migration => migration.version);

function validPrefix(versions: number[]): boolean {
  return versions.every((version, index) => version === knownVersions[index]);
}

export async function migrateSchema(pool: Pool): Promise<void> {
  await inTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('mobile-schema'))");
    await client.query("CREATE TABLE IF NOT EXISTS mobile_schema_migrations (version integer PRIMARY KEY)");
    const result = await client.query<{ version: number }>("SELECT version FROM mobile_schema_migrations ORDER BY version");
    const versions = result.rows.map(row => row.version);
    if (!validPrefix(versions)) throw new Error("Unsupported database schema version");
    for (const migration of migrations.slice(versions.length)) {
      await client.query(migration.sql);
      await client.query("INSERT INTO mobile_schema_migrations (version) VALUES ($1)", [migration.version]);
    }
  });
}

export async function assertSchema(pool: Pool): Promise<void> {
  const result = await pool.query<{ version: number }>("SELECT version FROM mobile_schema_migrations ORDER BY version");
  if (result.rows.length !== migrations.length || !validPrefix(result.rows.map(row => row.version))) {
    throw new Error("Database schema is not ready");
  }
}
