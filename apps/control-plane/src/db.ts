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
import { observeDatabaseTransaction, recordPoolWait, recordTransactionTiming } from "./request-timing.js";
import { SqlFragment } from "./sql-fragment.js";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// Drop superuser privileges for the rest of this transaction so RLS binds.
// Kept literal (not parameterized) because SET ROLE takes an identifier, not
// a value; `zeros_app` is a fixed migration-defined role, never user input.
const ENTER_APP_ROLE = "SET LOCAL ROLE zeros_app";
export const DATABASE_CONNECTION_LIFETIME_SECONDS = 600;

export class DatabaseAcquireTimeoutError extends Error {
  readonly code = "database_acquire_timeout";
  constructor() {
    super("Database capacity is temporarily unavailable");
    this.name = "DatabaseAcquireTimeoutError";
  }
}

export class DatabaseAcquireUnavailableError extends Error {
  readonly code = "database_acquire_unavailable";
  constructor() {
    super("Database connection is temporarily unavailable");
    this.name = "DatabaseAcquireUnavailableError";
  }
}

function acquireError(error: unknown): unknown {
  // These are pg-pool's queue and new-connection deadlines. Do not turn SQL,
  // authentication, or uncertain transaction failures into retryable acquires.
  if (error instanceof Error && (error.message === "timeout exceeded when trying to connect" ||
    error.message === "Connection terminated due to connection timeout")
  ) return new DatabaseAcquireTimeoutError();
  // Normalize transport errors only at acquisition, before a transaction
  // exists. An arbitrary application/provider error with an errno is not DB proof.
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code))
    return new DatabaseAcquireUnavailableError();
  return error;
}

/** Availability is not transaction retry permission. In particular, connection
 * loss may follow COMMIT: callers must re-observe durable state before writing. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string" && [
    "database_acquire_timeout", "database_acquire_unavailable", "database_connection_lost",
    "40001", "40P01", "55P03", "57014", "53300", "57P01", "57P02", "57P03",
    "08000", "08001", "08003", "08006", "08007",
  ].includes(error.code);
}

type ConnectCallback = Parameters<pg.Pool["connect"]>[0];
class DeadlinePool extends pg.Pool {
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    // Use pg-pool's own cancellation: it removes timed-out waiters and owns
    // late sockets. A Promise.race would leave work queued after the 503.
    if (callback) {
      super.connect((error, client, release) => callback(acquireError(error) as Error | undefined, client, release));
      return;
    }
    return super.connect().catch(error => { throw acquireError(error); });
  }
}

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
  options: { maxConnections?: number; applicationName?: string; keepAlive?: boolean;
    workload?: "api" | "worker" | "listener" | "retirement-lock" } = {},
): pg.Pool {
  const interactive = options.workload === "api";
  const Pool = interactive ? DeadlinePool : pg.Pool;
  const pool = new Pool({
    connectionString: parseDatabaseTarget(databaseUrl).toString(),
    // pg treats an empty string as absent and falls back to PGOPTIONS.
    // Explicit NONE retains the login's authority without ambient role choice.
    options: "-c role=none",
    max: options.maxConnections ?? (interactive ? 6 : options.workload === "retirement-lock" ? 1 : options.workload ? 2 : 10),
    // Hosted PlanetScale connections require sslmode=verify-full. Honor the
    // validated URL so local PostgreSQL development remains supported.
    //
    // API requests fail fast. Workers and operator callers retain their
    // existing deadlines; their independent capacity cannot consume API slots.
    statement_timeout: interactive ? 5_000 : 30_000,
    connectionTimeoutMillis: interactive ? 1_000 : 10_000,
    idle_in_transaction_session_timeout: 30_000,
    maxLifetimeSeconds: DATABASE_CONNECTION_LIFETIME_SECONDS,
    application_name: options.applicationName ?? "zeros-control-plane",
    // Transport probes keep an idle LISTEN socket observable without issuing
    // SQL or adding transactions to the shared database/egress budget.
    ...(options.keepAlive ? { keepAlive: true, keepAliveInitialDelayMillis: 30_000 } : {}),
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
  const started = performance.now();
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    recordPoolWait(performance.now() - started);
    throw acquireError(error);
  }
  const acquired = performance.now();
  const connection = observeOwnedConnection(client);
  const stopObserving = observeDatabaseTransaction(client);
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
    stopObserving?.();
    connection.release(discard);
    recordTransactionTiming(acquired - started, performance.now() - started);
  }
}

/** One-round-trip system transaction for a single statement: BEGIN, the same
 * role and RLS context as `withSystemTx`, the statement and COMMIT travel as
 * one simple-protocol batch. That protocol cannot bind parameters, so the
 * statement must be a `SqlFragment`, built only from template text and
 * validated literals. A failed batch costs one extra ROLLBACK. */
export async function withSystemStatement<R extends pg.QueryResultRow>(
  pool: pg.Pool,
  statement: SqlFragment,
): Promise<pg.QueryResult<R>> {
  assertWorkOSProviderLockHeld();
  if (!(statement instanceof SqlFragment)) throw new Error("system_statement_fragment_required");
  if (statement.text.includes(";")) throw new Error("system_statement_must_be_single");
  const started = performance.now();
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    recordPoolWait(performance.now() - started);
    throw acquireError(error);
  }
  const acquired = performance.now();
  const connection = observeOwnedConnection(client);
  const stopObserving = observeDatabaseTransaction(client);
  let discard = false;
  try {
    connection.assert();
    // The newline ends any trailing `--` comment before COMMIT.
    const results = await client.query(
      `BEGIN; ${ENTER_APP_ROLE}; SELECT set_config('app.system', 'on', true); ${statement.text}\n; COMMIT`,
    ) as unknown as pg.QueryResult<R>[];
    connection.assert();
    if (!Array.isArray(results) || results.length !== 5) throw new Error("system_statement_batch_invalid");
    return results[3]!;
  } catch (err) {
    if (!connection.lost)
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
    if (connection.lost) throw new DatabaseConnectionLostError();
    throw err;
  } finally {
    stopObserving?.();
    connection.release(discard);
    recordTransactionTiming(acquired - started, performance.now() - started);
  }
}

/** System-context transaction (no acting user): JIT signup, webhooks. */
export async function withSystemTx<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
  options: { consistentRead?: boolean; serializable?: boolean } = {},
): Promise<T> {
  assertWorkOSProviderLockHeld();
  const started = performance.now();
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    recordPoolWait(performance.now() - started);
    throw acquireError(error);
  }
  const acquired = performance.now();
  const connection = observeOwnedConnection(client);
  const stopObserving = observeDatabaseTransaction(client);
  let discard = false;
  try {
    connection.assert();
    await client.query(`${options.serializable
      ? `BEGIN ISOLATION LEVEL SERIALIZABLE${options.consistentRead ? " READ ONLY" : ""}`
      : options.consistentRead ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
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
    stopObserving?.();
    connection.release(discard);
    recordTransactionTiming(acquired - started, performance.now() - started);
  }
}
