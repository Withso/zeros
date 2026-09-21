import {parseDatabaseTarget} from "./database-target.js";

/** Validate driver-facing DSNs without ever including credentials in errors.
 * WorkOS uses session advisory locks, so the current runtime needs direct
 * connections even when LISTEN has its own connection pool. */
export function validateDatabaseConnections(input: {
  DATABASE_URL: string;
  DATABASE_LISTEN_URL?: string | undefined;
  DATABASE_MIGRATION_URL?: string | undefined;
  DATABASE_POOL_MAX: number;
}): void {
  const minimum = input.DATABASE_LISTEN_URL ? 2 : 3;
  if (input.DATABASE_POOL_MAX < minimum) {
    throw new Error(
      `Invalid environment: DATABASE_POOL_MAX must be at least ${minimum} to reserve lock, callback and listener capacity`,
    );
  }
  const invalid = (key: string, reason: string): never => { throw new Error(`Invalid environment: ${key} ${reason}`); };
  const parse = (key: string, value: string) => {
    const url = parseDatabaseTarget(value, key);
    const username = decodeURIComponent(url.username);
    return {host: url.hostname, database: decodeURIComponent(url.pathname.slice(1)),
      planetScale: url.hostname.endsWith('.psdb.cloud'), branch: username.slice(username.lastIndexOf('.') + 1)};
  };
  const runtime = parse("DATABASE_URL", input.DATABASE_URL);
  for (const key of [
    "DATABASE_LISTEN_URL",
    "DATABASE_MIGRATION_URL",
  ] as const) {
    const value = input[key];
    if (!value) continue;
    const other = parse(key, value);
    if (
      runtime.database !== other.database ||
      ((runtime.planetScale || other.planetScale) &&
        (runtime.host !== other.host || runtime.branch !== other.branch))
    ) {
      invalid(
        key,
        "must target the same database and PlanetScale branch as DATABASE_URL",
      );
    }
  }
}
