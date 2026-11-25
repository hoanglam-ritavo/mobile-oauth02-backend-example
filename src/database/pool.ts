import pg, { type Pool, type PoolClient } from "pg";

export function createPool(connectionString: string, options?: string): Pool {
  return new pg.Pool({
    connectionString,
    options,
    max: 10,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 3_000,
    idle_in_transaction_session_timeout: 5_000,
  });
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
