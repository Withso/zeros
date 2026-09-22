// ──────────────────────────────────────────────────────────
// Postgres pool + transaction helpers.
//
// Every request handler runs inside `withUserTx`/`withSystemTx`, which
// opens a transaction, drops to the unprivileged `zeros_app` role, and
// sets the `app.user_id` / `app.system` GUCs the RLS policies key on
// (migrations/0002_rls.sql + 0004_rls_enforce.sql). The app-layer role
// checks in authz.ts are the PRIMARY lock; RLS is the enforced second one.
//
// Runtime credentials must be allowed to SET ROLE zeros_app. DDL credentials
// belong to the migration pool. SET LOCAL is transaction-scoped, so no role
// or request identity leaks across pooled requests.
// ──────────────────────────────────────────────────────────

import pg from "pg";
import {parseDatabaseTarget, validateMigrationRole} from "./database-target.js";
import { assertWorkOSProviderLockHeld } from "./workos-provider-lock-context.js";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// Drop superuser privileges for the rest of this transaction so RLS binds.
// Kept literal (not parameterized) because SET ROLE takes an identifier, not
// a value; `zeros_app` is a fixed migration-defined role, never user input.
const ENTER_APP_ROLE = "SET LOCAL ROLE zeros_app";
export const DATABASE_CONNECTION_LIFETIME_SECONDS = 600;

export class DatabaseConnectionLostError extends Error {
  readonly code = "database_connection_lost";
  constructor() {
    super("Database transaction connection was lost");
    this.name = "DatabaseConnectionLostError";
  }
}

function observeOwnedConnection(client: Tx) {
  let lost = false;
  const onLost = () => {
    lost = true;
  };
  // pg-pool only observes idle connections. While a callback awaits another
  // service, its checked-out connection still needs an error listener.
  client.on?.("error", onLost);
  client.once?.("end", onLost);
  return {
    get lost() {
      return lost;
    },
    assert() {
      if (lost) throw new DatabaseConnectionLostError();
      assertWorkOSProviderLockHeld();
    },
    release(discard: boolean) {
      client.removeListener?.("error", onLost);
      client.removeListener?.("end", onLost);
      client.release(discard || lost);
    },
  };
}

export function createPool(
  databaseUrl: string,
  options: { maxConnections?: number; applicationName?: string } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: parseDatabaseTarget(databaseUrl).toString(),
    // pg treats an empty string as absent and falls back to PGOPTIONS.
    // Explicit NONE retains the login's authority without ambient role choice.
    options: "-c role=none",
    max: options.maxConnections ?? 10,
    // Hosted PlanetScale connections require sslmode=verify-full. Honor the
    // validated URL so local PostgreSQL development remains supported.
    //
    // A hung query (full scan, lock wait) otherwise pins one of the 10 pool
    // slots indefinitely; 11 such queries wedge the whole backend. Cap every
    // statement at 30s and every new-connection wait at 10s so a slow DB
    // surfaces as errors instead of a silent hang.
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
    idle_in_transaction_session_timeout: 30_000,
    maxLifetimeSeconds: DATABASE_CONNECTION_LIFETIME_SECONDS,
    application_name: options.applicationName ?? "zeros-control-plane",
  });
  // pg evicts failed idle clients itself, but an unhandled pool error is a
  // process-level crash. Never log the driver error: it may contain SQL/data.
  pool.on("error", () => {
    console.error("[database] idle connection lost; pool will replace it");
  });
  return pool;
}

/** Rotating login authority is separate from the stable object owner. The
 * driver sends this validated role in startup options before any ledger DDL,
 * transaction, or owner check. Ambient PGOPTIONS never selects authority. */
export function createMigrationPool(
  databaseUrl: string,
  options: {maxConnections?: number; applicationName?: string; role?: string} = {},
): pg.Pool {
  const role = validateMigrationRole(options.role ?? process.env.DATABASE_MIGRATION_ROLE);
  const pool = new pg.Pool({
    connectionString: parseDatabaseTarget(databaseUrl).toString(),
    options: `-c role=${role ?? "none"}`,
    max: options.maxConnections ?? 1,
    application_name: options.applicationName ?? "zeros-migrator",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    maxLifetimeSeconds: DATABASE_CONNECTION_LIFETIME_SECONDS,
  });
  pool.on("error", () => console.error("[database] idle migration connection lost"));
  return pool;
}

/** Run `fn` in a transaction with the acting user's id bound for RLS. */
export async function withUserTx<T>(
  pool: pg.Pool,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertWorkOSProviderLockHeld();
  const client = await pool.connect();
  const connection = observeOwnedConnection(client);
  let discard = false;
  try {
    connection.assert();
    // Batch only static transaction setup. Identity values remain in a
    // separate parameterized statement, never interpolated into SQL.
    await client.query(`BEGIN; ${ENTER_APP_ROLE}`);
    // set_config with is_local=true scopes the GUC to this transaction.
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    connection.assert();
    const result = await fn(client);
    connection.assert();
    await client.query("COMMIT");
    connection.assert();
    return result;
  } catch (err) {
    if (!connection.lost)
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
    if (connection.lost) throw new DatabaseConnectionLostError();
    throw err;
  } finally {
    connection.release(discard);
  }
}

/** System-context transaction (no acting user): JIT signup, webhooks. */
export async function withSystemTx<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
  options: { consistentRead?: boolean } = {},
): Promise<T> {
  assertWorkOSProviderLockHeld();
  const client = await pool.connect();
  const connection = observeOwnedConnection(client);
  let discard = false;
  try {
    connection.assert();
    await client.query(`${options.consistentRead
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : "BEGIN"}; ${ENTER_APP_ROLE}; SELECT set_config('app.system', 'on', true)`);
    connection.assert();
    const result = await fn(client);
    connection.assert();
    await client.query("COMMIT");
    connection.assert();
    return result;
  } catch (err) {
    if (!connection.lost)
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
    if (connection.lost) throw new DatabaseConnectionLostError();
    throw err;
  } finally {
    connection.release(discard);
  }
}
