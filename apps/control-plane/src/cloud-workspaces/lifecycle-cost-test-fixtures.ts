import type pg from "pg";

/** Real query-port observations for bounded lifecycle performance regressions.
 * Elapsed wall time includes local PostgreSQL/transport; it is not database CPU.
 * No SQL, bindings, resource identity or provider output enters the receipt. */
export function lifecycleDatabaseCost(base: pg.Pool, afterQuery?: (sql: string, client: pg.PoolClient) => Promise<void>) {
  const started = performance.now();
  let checkouts = 0, checkedOut = 0, maximumCheckedOut = 0, roundTrips = 0, statements = 0;
  let queryMs = 0, poolWaitMs = 0, heldMs = 0, supportedGenerationReads = 0, timeOnlyReads = 0;
  const pool = new Proxy(base, { get(target, key) {
    if (key === "connect") return async () => {
      const waiting = performance.now(), client = await target.connect(), acquired = performance.now();
      poolWaitMs += acquired - waiting;
      checkouts++; checkedOut++; maximumCheckedOut = Math.max(maximumCheckedOut, checkedOut);
      let released = false;
      return new Proxy(client, { get(target, key) {
        if (key === "query") return async (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string }).text ?? "";
          if (text.startsWith("SELECT runtime_id,runtime_manifest_sha256,runtime_base_image_id,")) supportedGenerationReads++;
          if (text === "SELECT clock_timestamp() AS now") timeOnlyReads++;
          roundTrips++;
          const began = performance.now();
          try {
            const result = await Reflect.apply(target.query, target, args) as pg.QueryResult | pg.QueryResult[];
            statements += Array.isArray(result) ? result.length : 1;
            await afterQuery?.(text, target);
            return result;
          } finally { queryMs += performance.now() - began; }
        };
        if (key === "release") return (...args: unknown[]) => {
          if (!released) { released = true; checkedOut--; heldMs += performance.now() - acquired; }
          return Reflect.apply(target.release, target, args);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const snapshot = () => Object.freeze({ checkouts, checkedOut, maximumCheckedOut, roundTrips, statements,
    elapsedMs: performance.now() - started, queryMs, poolWaitMs, heldMs, supportedGenerationReads, timeOnlyReads });
  return { pool, snapshot };
}
