import type pg from "pg";

/** Wraps a pool so a test can take the database away and give it back.
 * While down, a new connection fails like a refused TCP connect and a
 * checked-out connection fails like a terminated backend, so production code
 * sees the same codes as in a real outage. Statement text and values still
 * reach PostgreSQL unchanged while up. */
export function faultInjectingPool(base: pg.Pool) {
  let down = false;
  const failures = { connects: 0, queries: 0 };
  const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const terminated = () => Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
  const wrapClient = (client: pg.PoolClient) => new Proxy(client, { get(target, key) {
    if (key === "query") return async (...args: unknown[]) => {
      if (down) { failures.queries++; throw terminated(); }
      return Reflect.apply(target.query, target, args);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const pool = new Proxy(base, { get(target, key) {
    if (key === "connect") return async () => {
      if (down) { failures.connects++; throw refused(); }
      return wrapClient(await target.connect());
    };
    if (key === "query") return async (...args: unknown[]) => {
      if (down) { failures.queries++; throw refused(); }
      return Reflect.apply(target.query, target, args);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return {
    pool,
    failures,
    down() { down = true; },
    up() { down = false; },
  };
}
