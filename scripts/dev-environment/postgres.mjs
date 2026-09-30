import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { run } from "./processes.mjs";
import { privateDirectory, saveWorkspace, systemEnvironment, writePrivateFile } from "./state.mjs";
import { portFree } from "../dev-ports.mjs";

export async function databaseCommand(workspace, ports, repositoryRoot, action) {
  const input = { action, owner: workspace.state.owner, port: ports.database,
    migrationUrl: databaseUrl(workspace, ports.database, "migration"), runtimeUrl: databaseUrl(workspace, ports.database) };
  const output = await run(process.execPath, [path.join(repositoryRoot, "scripts/dev-environment/database.mjs")], {
    cwd: repositoryRoot, env: systemEnvironment(), input: JSON.stringify(input), timeout: 180_000, label: `Development database ${action}`,
  });
  try { return JSON.parse(output.split("\n").at(-1)); }
  catch { throw new Error("Invalid development database result"); }
}

export async function migratePostgres(workspace, profile, ports, repositoryRoot) {
  const plan = await databaseCommand(workspace, ports, repositoryRoot, "plan");
  if (plan.pendingMigrations.length) {
    const directory = privateDirectory(workspace.directory, "backups");
    const file = path.join(directory, `before-migrate-${Date.now()}.dump`);
    // Libpq reads the connection from this child's environment, never argv.
    await run(path.join(postgresBinaries(profile), "pg_dump"), ["--format=custom", "--file", file], {
      env: { ...systemEnvironment(), PGDATABASE: databaseUrl(workspace, ports.database, "migration") }, label: "Pre-migration backup",
    });
    fs.chmodSync(file, 0o600);
    await databaseCommand(workspace, ports, repositoryRoot, "migrate");
  }
  return databaseCommand(workspace, ports, repositoryRoot, "verify");
}

const ROLES = { admin: "zeros_dev_admin", migration: "zeros_dev_migrator", runtime: "zeros_dev_runtime" };

export function postgresBinaries(profile = {}) {
  const candidates = [profile.postgresBin, "/opt/homebrew/opt/postgresql@18/bin", "/usr/local/opt/postgresql@18/bin", "/usr/lib/postgresql/18/bin", "/usr/pgsql-18/bin"].filter(Boolean);
  for (const directory of candidates) if (fs.existsSync(path.join(directory, "initdb")) && fs.existsSync(path.join(directory, "pg_ctl"))) return directory;
  throw new Error("PostgreSQL 18 is required. On macOS run brew install postgresql@18; otherwise set postgresBin in the private Dev profile.");
}

export async function pickServicePorts() {
  // Dynamic listeners use private per-workspace configuration. Probe all ports
  // independently; readiness rejects a raced bind instead of using that server.
  const chosen = new Set(), ports = {};
  for (const name of ["database", "api", "web", "tunnelMetrics"]) {
    let selected;
    for (let attempt = 0; attempt < 400; attempt++) {
      const port = 20000 + Math.floor(Math.random() * 35000);
      if (!chosen.has(port) && await portFree(port)) { selected = port; chosen.add(port); break; }
    }
    if (!selected) throw new Error("No free local development port was found");
    ports[name] = selected;
  }
  return ports;
}

export function databaseUrl(workspace, port, role = "runtime") {
  if (!ROLES[role] || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid development database connection");
  const password = workspace.state.database[`${role}Password`];
  return `postgresql://${ROLES[role]}:${password}@127.0.0.1:${port}/${workspace.state.database.name}`;
}

export function validateDatabaseUrl(value, workspace, port, role = "runtime") {
  if (value !== databaseUrl(workspace, port, role)) throw new Error("Refusing a connection outside this workspace's local development database");
  return value;
}

export async function startPostgres(workspace, profile, ports, repositoryRoot) {
  const bin = postgresBinaries(profile);
  const env = systemEnvironment();
  const version = await run(path.join(bin, "postgres"), ["--version"], { env, label: "PostgreSQL version check" });
  if (!/\b18\./.test(version)) throw new Error("The Dev database must use PostgreSQL 18; existing data was preserved");
  const data = path.join(workspace.directory, "postgres");
  if (fs.existsSync(data) && fs.lstatSync(data).isSymbolicLink()) throw new Error("Refusing a linked development database directory");
  if (fs.existsSync(path.join(data, "postmaster.pid"))) {
    const pid = Number(fs.readFileSync(path.join(data, "postmaster.pid"), "utf8").split("\n")[0]);
    let dead = false;
    try { if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid PostgreSQL PID"); process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") dead = true; }
    if (!dead) throw new Error("This workspace's PostgreSQL cluster is already running or needs recovery. Run pnpm dev:stop before restarting.");
  }
  if (!fs.existsSync(path.join(data, "PG_VERSION"))) {
    if (fs.existsSync(data) && fs.readdirSync(data).length) throw new Error("Incomplete PostgreSQL initialization; existing data was preserved");
    const passwordFile = path.join(workspace.directory, "postgres-init-password");
    writePrivateFile(passwordFile, workspace.state.database.adminPassword);
    try {
      await run(path.join(bin, "initdb"), ["-D", data, "-U", ROLES.admin, "--encoding=UTF8", "--locale=C", "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", `--pwfile=${passwordFile}`], { env, label: "PostgreSQL initialization" });
    } finally { fs.rmSync(passwordFile, { force: true }); }
  }
  if (fs.readFileSync(path.join(data, "PG_VERSION"), "utf8").trim() !== "18") throw new Error("Existing PostgreSQL data requires its matching major version");
  // PostgreSQL's socket path limit is much shorter than macOS Application
  // Support paths. TCP is loopback-only and requires a generated password.
  writePrivateFile(path.join(data, "postgresql.auto.conf"), [
    "listen_addresses = '127.0.0.1'", `port = ${ports.database}`,
    "unix_socket_directories = ''", "max_connections = 40", "shared_buffers = '32MB'",
    "log_statement = 'none'", "log_min_error_statement = 'panic'", "log_parameter_max_length_on_error = 0", "",
  ].join("\n"));
  const log = path.join(workspace.directory, "postgres.log");
  if (!fs.existsSync(log)) writePrivateFile(log, "");
  await run(path.join(bin, "pg_ctl"), ["-D", data, "-l", log, "-w", "-t", "30", "start"], { env, label: "PostgreSQL startup", timeout: 35_000 });
  workspace.state.ports = ports; saveWorkspace(workspace);
  const stop = async () => {
    await run(path.join(bin, "pg_ctl"), ["-D", data, "-w", "-t", "20", "-m", "fast", "stop"], { env, label: "PostgreSQL shutdown", timeout: 25_000 });
  };
  try {
    const require = createRequire(path.join(repositoryRoot, "apps/control-plane/package.json"));
    const { Client } = require("pg");
    const admin = new Client({ host: "127.0.0.1", port: ports.database, user: ROLES.admin,
      password: workspace.state.database.adminPassword, database: "postgres", connectionTimeoutMillis: 5000 });
    await admin.connect();
    try {
      const actual = await admin.query("SHOW data_directory");
      if (fs.realpathSync(actual.rows[0].data_directory) !== fs.realpathSync(data)) throw new Error("PostgreSQL ownership mismatch");
      const roles = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [["zeros_app", ROLES.migration, ROLES.runtime]]);
      const names = new Set(roles.rows.map(row => row.rolname));
      if (!names.has("zeros_app")) await admin.query("CREATE ROLE zeros_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
      for (const kind of ["migration", "runtime"]) {
        if (!names.has(ROLES[kind])) {
          const statement = await admin.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql", [ROLES[kind], workspace.state.database[`${kind}Password`]]);
          await admin.query(statement.rows[0].sql);
        }
      }
      await admin.query("GRANT zeros_app TO zeros_dev_migrator WITH ADMIN OPTION");
      await admin.query("GRANT zeros_app TO zeros_dev_runtime");
      const unsafe = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1) AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)", [["zeros_app", ROLES.migration, ROLES.runtime]]);
      if (unsafe.rowCount) throw new Error("Dev database role authority has changed");
      const db = await admin.query("SELECT datname FROM pg_database WHERE datname = $1", [workspace.state.database.name]);
      if (!db.rowCount) {
        const statement = await admin.query("SELECT format('CREATE DATABASE %I OWNER zeros_dev_migrator', $1::text) AS sql", [workspace.state.database.name]);
        await admin.query(statement.rows[0].sql);
      }
    } finally { await admin.end(); }
    return { stop, bin, data, runtimeUrl: databaseUrl(workspace, ports.database), migrationUrl: databaseUrl(workspace, ports.database, "migration") };
  } catch {
    await stop().catch(() => {});
    throw new Error("Development database role or ownership verification failed; existing data was preserved");
  }
}
