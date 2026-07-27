// ──────────────────────────────────────────────────────────
// Postgres pool + transaction helpers.
//
// Every request handler runs inside `withUserTx`/`withSystemTx`, which
// opens a transaction, drops to the unprivileged `zeros_app` role, and
// sets the `app.user_id` / `app.system` GUCs the RLS policies key on
// (migrations/0002_rls.sql + 0004_rls_enforce.sql). The app-layer role
// checks in authz.ts are the PRIMARY lock; RLS is the enforced second one.
//
// The pool connects as Railway's superuser `postgres` (needed for DDL in
// runMigrations), but `SET LOCAL ROLE zeros_app` makes the CURRENT role
// non-superuser + non-owner for the duration of the transaction, so RLS
// actually binds. SET LOCAL is transaction-scoped — the connection reverts
// to postgres on COMMIT/ROLLBACK, so no role leaks across pooled requests.
// ──────────────────────────────────────────────────────────

import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// Drop superuser privileges for the rest of this transaction so RLS binds.
// Kept literal (not parameterized) because SET ROLE takes an identifier, not
// a value; `zeros_app` is a fixed migration-defined role, never user input.
const ENTER_APP_ROLE = "SET LOCAL ROLE zeros_app";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // Railway private-network Postgres doesn't need TLS; the public proxy
    // does. Honor sslmode in the URL rather than forcing either way.
    //
    // A hung query (full scan, lock wait) otherwise pins one of the 10 pool
    // slots indefinitely; 11 such queries wedge the whole backend. Cap every
    // statement at 30s and every new-connection wait at 10s so a slow DB
    // surfaces as errors instead of a silent hang.
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Run `fn` in a transaction with the acting user's id bound for RLS. */
export async function withUserTx<T>(
  pool: pg.Pool,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(ENTER_APP_ROLE);
    // set_config with is_local=true scopes the GUC to this transaction.
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** System-context transaction (no acting user): JIT signup, webhooks. */
export async function withSystemTx<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(ENTER_APP_ROLE);
    await client.query("SELECT set_config('app.system', 'on', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
