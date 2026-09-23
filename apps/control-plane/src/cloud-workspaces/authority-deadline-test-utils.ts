import pg from "pg";

/** Observe every query a pool's checked-out clients send, before it is sent.
 * The hook may await to hold a real transaction at that statement. */
export function interceptQueries(
  pool: pg.Pool,
  onQuery: (sql: string, client: pg.PoolClient) => Promise<void> | void,
): pg.Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, field) {
              if (field === "query")
                return async (...args: unknown[]) => {
                  const sql =
                    typeof args[0] === "string"
                      ? args[0]
                      : String((args[0] as { text?: unknown } | null)?.text ?? "");
                  await onQuery(sql, connection);
                  return Reflect.apply(connection.query, connection, args);
                };
              const value = Reflect.get(connection, field);
              return typeof value === "function"
                ? value.bind(connection)
                : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Pause a real transaction at its authority-lock boundary. The callback moves
 * a deadline past wall time after BEGIN, without sleeps or clock mocks. This
 * models the elapsed time of a contended lock while retaining PostgreSQL's
 * original transaction timestamp. */
export function withAuthorityDeadlineBarrier(
  pool: pg.Pool,
  query: RegExp,
  expire: (client: pg.PoolClient) => Promise<unknown>,
): pg.Pool {
  let intercepted = false;
  return interceptQueries(pool, async (sql, client) => {
    if (intercepted || !query.test(sql)) return;
    intercepted = true;
    await expire(client);
  });
}

/** Run `fn` while another transaction holds a workspace and its engine row in
 * `mode`. `fn` receives a one-connection pool that gives up on any lock after
 * 250 ms, so a request that must wait fails with 55P03 instead of hanging. */
export async function withHeldEngineRows<T>(
  pool: pg.Pool,
  rows: { workspaceId: string; engineInstanceId: string },
  mode: "SHARE" | "UPDATE",
  fn: (lockPool: pg.Pool) => Promise<T>,
): Promise<T> {
  const held = await pool.connect();
  const lockPool = new pg.Pool({
    connectionString: (pool as unknown as { options: pg.PoolConfig }).options.connectionString,
    max: 1,
    options: "-c lock_timeout=250ms",
  });
  try {
    await held.query("BEGIN");
    await held.query(`SELECT id FROM cloud_workspaces WHERE id = $1 FOR ${mode}`, [rows.workspaceId]);
    await held.query(`SELECT id FROM cloud_workspace_engine_instances WHERE id = $1 FOR ${mode}`, [rows.engineInstanceId]);
    return await fn(lockPool);
  } finally {
    await held.query("ROLLBACK").catch(() => undefined);
    held.release();
    await lockPool.end();
  }
}

/** A barrier that holds one transaction just before a matching statement. */
export function pauseBeforeQuery(pool: pg.Pool, query: RegExp) {
  let reached!: () => void;
  let release!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let paused = false;
  const controlled = interceptQueries(pool, async (sql) => {
    if (paused || !query.test(sql)) return;
    paused = true;
    reached();
    await released;
  });
  return { pool: controlled, atBarrier, release };
}
