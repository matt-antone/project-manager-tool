import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config-core";

export type { PoolClient };

types.setTypeParser(1082, (value) => value);

const globalForPg = globalThis as unknown as { pool?: Pool };

function getPool() {
  if (globalForPg.pool) {
    return globalForPg.pool;
  }

  const pool = new Pool({
    connectionString: config.databaseUrl(),
    max: 5,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000
  });

  globalForPg.pool = pool;

  return pool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return getPool().query<T>(text, values);
}

/**
 * Run a multi-statement DB transaction on a single pooled client.
 *
 * CAUTION: any helper invoked inside `fn` that uses the module-level `query()`
 * helper will run on a *different* connection and is NOT part of this
 * transaction. Pass `client` explicitly to repository functions that need to
 * participate in the transaction.
 *
 * Current legitimate callers:
 *   - createProject (atomic project + project_members insert)
 *
 * Add additional callers to this list as they are introduced.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      console.error("withTransaction rollback failed", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}
