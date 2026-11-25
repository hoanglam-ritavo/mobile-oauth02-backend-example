import { ConfigError, readDatabaseUrl } from "../config.ts";
import { createDataSource } from "./data-source.ts";

try {
  const dataSource = createDataSource(readDatabaseUrl(process.env), { synchronize: true });
  await dataSource.initialize();
  await dataSource.destroy();
  console.info("Database schema synchronized.");
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : "Database schema synchronization failed.");
  process.exitCode = 1;
}
