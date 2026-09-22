import type pg from "pg";

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
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, field) {
              if (field === "query")
                return async (...args: unknown[]) => {
                  if (
                    !intercepted &&
                    typeof args[0] === "string" &&
                    query.test(args[0])
                  ) {
                    intercepted = true;
                    await expire(connection);
                  }
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
