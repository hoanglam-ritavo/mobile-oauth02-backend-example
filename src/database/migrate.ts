import { ConfigError, readDatabaseUrl } from "../config.ts";
import { createPool } from "./pool.ts";
import { migrateSchema } from "./schema.ts";

try {
  const pool = createPool(readDatabaseUrl(process.env));
  pool.on("error", () => {});
  try {
    await migrateSchema(pool);
    console.info("Database migrations applied.");
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "Database migration failed.");
  process.exitCode = 1;
}
