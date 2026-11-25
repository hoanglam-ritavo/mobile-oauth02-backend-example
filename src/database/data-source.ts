import { DataSource } from "typeorm";
import { entities } from "./entities.ts";

export function createDataSource(
  url: string,
  { synchronize = false, schema, onIdleError = () => {} }: {
    synchronize?: boolean;
    schema?: string;
    onIdleError?: () => void;
  } = {},
): DataSource {
  return new DataSource({
    type: "postgres",
    url,
    entities,
    synchronize,
    schema,
    installExtensions: false,
    poolSize: 10,
    connectTimeoutMS: 3_000,
    poolErrorHandler: onIdleError,
    extra: {
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
      statement_timeout: 3_000,
      idle_in_transaction_session_timeout: 5_000,
    },
  });
}

export async function assertSchema(dataSource: DataSource): Promise<void> {
  const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
  if (upQueries.length) throw new Error("Database schema is not ready");
}
