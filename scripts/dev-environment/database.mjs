import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { databaseUrl } from "./postgres.mjs";

export function validateDatabaseRequest(request) {
  if (!/^[a-f0-9]{24}$/.test(request?.owner ?? "") || !Number.isInteger(request.port) || request.port < 1024 || request.port > 65535 ||
      !["plan", "migrate", "verify", "inventory"].includes(request.action)) throw new Error("Invalid local development database operation");
  for (const [role, value] of [["migration", request.migrationUrl], ["runtime", request.runtimeUrl]]) {
    let url; try { url = new URL(value); } catch { throw new Error("Invalid local development database connection"); }
    if (!/^[a-f0-9]{64}$/.test(url.password)) throw new Error("Invalid local development database credential");
    const workspace = { state: { database: { name: `zeros_dev_${request.owner}`, [`${role}Password`]: url.password } } };
    if (value !== databaseUrl(workspace, request.port, role)) throw new Error("Refusing a database outside this local development workspace");
  }
  return request;
}

async function execute(request) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const require = createRequire(path.join(root, "apps/control-plane/package.json"));
  const { Pool } = require("pg");
  const { runMigrations, planMigrations, verifyMigrations } = await import(pathToFileURL(path.join(root, "apps/control-plane/dist/migrate.js")));
  const migration = new Pool({ connectionString: request.migrationUrl, options: "-c role=none", max: 1 });
  const runtime = new Pool({ connectionString: request.runtimeUrl, options: "-c role=none", max: 1 });
  try {
    if (request.action === "plan") return await planMigrations(migration);
    if (request.action === "migrate") {
      const plan = await planMigrations(migration);
      // The launcher holds this checkout's lock, stops its API, and backs up
      // the database before running the exact release migration runner.
      await runMigrations(migration, { env: { NODE_ENV: "production", CONTROL_PLANE_MIGRATION_APPROVALS: plan.controlledApprovals.join(",") } });
    }
    await verifyMigrations(runtime);
    const roles = await runtime.query("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, pg_has_role(current_user, 'zeros_dev_migrator', 'MEMBER') AS migrator FROM pg_roles WHERE rolname = current_user");
    if (Object.values(roles.rows[0] ?? { missing: true }).some(Boolean)) throw new Error("Dev API role has elevated privileges");
    const permissions = await runtime.query("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ddl");
    if (permissions.rows[0]?.ddl !== false) throw new Error("Dev API role has schema-changing authority");
    if (request.action === "inventory") {
      const c = await runtime.connect();
      try {
        await c.query("BEGIN"); await c.query("SET LOCAL ROLE zeros_app"); await c.query("SELECT set_config('app.system', 'true', true)");
        const result = await c.query("SELECT count(*)::int AS count FROM cloud_workspaces WHERE status <> 'deleted'");
        await c.query("ROLLBACK"); return { remainingWorkspaces: result.rows[0].count };
      } finally { c.release(); }
    }
    return { verified: true };
  } finally { await Promise.all([migration.end(), runtime.end()]); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) throw new Error("Oversized development database request"); }
    const result = await execute(validateDatabaseRequest(JSON.parse(input)));
    console.log(JSON.stringify(result));
  } catch (error) {
    // SQL and driver errors may embed user data and credentials.
    const { migrationFailureDiagnostic } = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/control-plane/dist/migrate.js")));
    console.error(migrationFailureDiagnostic(error)); process.exitCode = 1;
  }
}
