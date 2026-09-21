/** One URL grammar for runtime, migrations and privileged operator approvals.
 * pg accepts routing overrides in query parameters and ambient defaults. Reject
 * the former and materialize the port/login before handing a URL to the driver. */
export function parseDatabaseTarget(value: string, key = "DATABASE_URL"): URL {
  const invalid = (reason: string): never => {
    throw new Error(`Invalid environment: ${key} ${reason}`);
  };
  let url: URL, username: string, database: string;
  try {
    url = new URL(value);
    username = decodeURIComponent(url.username);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return invalid("must be a valid Postgres URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !username ||
    !database ||
    database.includes("/") ||
    url.hash ||
    /[\u0000-\u001f\u007f]/u.test(value + username + database) ||
    !/^(?:[a-z\d._-]+|\[[a-f\d:]+\])$/iu.test(url.hostname)
  )
    return invalid(
      "must be a valid Postgres URL with an explicit login and database",
    );
  // pg decodes database paths with decodeURI. Encoded URI delimiters remain
  // literal there; interpreting them with decodeURIComponent would approve a
  // different database. Raw delimiters retain their existing driver meaning.
  if (decodeURI(url.pathname.slice(1)) !== database)
    return invalid("contains an ambiguous encoded database delimiter");
  const routing = new Set([
    "host",
    "hostaddr",
    "port",
    "user",
    "password",
    "database",
    "dbname",
    "connectionstring",
    "options",
  ]);
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    const normalized = name.toLowerCase();
    if (routing.has(normalized) || seen.has(normalized))
      return invalid("must not override or duplicate connection parameters");
    seen.add(normalized);
  }
  url.hostname = url.hostname.toLowerCase();
  url.port ||= "5432";
  if (Number(url.port) < 1 || Number(url.port) > 65535)
    return invalid("must specify a valid Postgres port");
  if (url.port === "6432")
    return invalid(
      "must use direct primary connections; transaction pooling cannot hold provider locks",
    );
  url.username = encodeURIComponent(username);
  url.pathname = "/" + encodeURI(database);
  if (url.hostname.endsWith(".psdb.cloud")) {
    if (url.port !== "5432" || username.includes("|"))
      return invalid("must use the direct PlanetScale primary on port 5432");
    const separator = username.lastIndexOf("."),
      branch = username.slice(separator + 1);
    if (separator < 1 || !/^[a-z\d]+$/iu.test(branch))
      return invalid("must include a PlanetScale role and branch identifier");
    if (url.searchParams.get("sslmode") !== "verify-full")
      return invalid("requires sslmode=verify-full for PlanetScale");
    const allowed = new Set(["sslmode", "application_name", "connect_timeout"]);
    for (const name of url.searchParams.keys())
      if (!allowed.has(name))
        return invalid("contains an unsupported PlanetScale driver parameter");
  }
  return url;
}

/** Role identifiers are fixed operator configuration, never interpolated input
 * from an API request. Startup role selection owns all migration transactions. */
export function validateMigrationRole(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value) || value === "zeros_app")
    throw new Error(
      "DATABASE_MIGRATION_ROLE must be one explicit migration owner role",
    );
  return value;
}
