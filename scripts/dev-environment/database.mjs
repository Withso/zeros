import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadControlPlaneDependency, DevEnvironmentError, devEnvironmentDiagnostic } from "./dependency-preflight.mjs";
import { databaseUrl } from "./postgres.mjs";
import { seedLocalFixture } from "./local-fixtures.mjs";

export function validateDatabaseRequest(request) {
  if (!/^[a-f0-9]{24}$/.test(request?.owner ?? "") || !Number.isInteger(request.port) || request.port < 1024 || request.port > 65535 ||
      !["plan", "migrate", "verify", "inventory", "seed", "drain"].includes(request.action)) throw new Error("Invalid local development database operation");
  if ((["seed", "drain"].includes(request.action) || request.instanceId !== undefined) &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.instanceId ?? ""))
    throw new Error("Local cloud operations require the instance receipt");
  if (request.action === "drain" && request.backendStopped !== true) throw new Error("Stop the local backend before deleting its cloud resources");
  for (const [role, value] of [["migration", request.migrationUrl], ["runtime", request.runtimeUrl]]) {
    let url; try { url = new URL(value); } catch { throw new Error("Invalid local development database connection"); }
    if (!/^[a-f0-9]{64}$/.test(url.password)) throw new Error("Invalid local development database credential");
    const workspace = { state: { database: { name: `zeros_dev_${request.owner}`, [`${role}Password`]: url.password } } };
    if (value !== databaseUrl(workspace, request.port, role)) throw new Error("Refusing a database outside this local development workspace");
  }
  return request;
}

export async function assertLocalDatabaseOwner(pool, request) {
  const { rows } = await pool.query("SELECT owner,instance_id FROM public.zeros_cloud_local_identity");
  if (rows.length !== 1 || rows[0].owner !== request.owner || rows[0].instance_id !== request.instanceId)
    throw new Error("The local database belongs to another instance; existing resources were preserved");
}

export async function inventoryLocalWorkspaces(runtime, withSystemTx) {
  return withSystemTx(runtime, async tx => {
    const result = await tx.query("SELECT count(*)::int AS count FROM cloud_v2_workspaces WHERE state <> 'deleted'");
    return { remainingWorkspaces: result.rows[0].count };
  });
}

async function recordLocalDatabaseOwner(migration, request) {
  // This infrastructure marker is local-only, outside the release migration
  // ladder. The launcher already checked the data-directory owner and roles;
  // validateDatabaseRequest also pins both URLs to that loopback database.
  await migration.query(`CREATE TABLE IF NOT EXISTS zeros_cloud_local_identity(
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),owner text NOT NULL,instance_id uuid NOT NULL)`);
  await migration.query("INSERT INTO zeros_cloud_local_identity(owner,instance_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [request.owner, request.instanceId]);
  await assertLocalDatabaseOwner(migration, request);
  await migration.query("REVOKE ALL ON zeros_cloud_local_identity FROM PUBLIC,zeros_app; GRANT SELECT ON zeros_cloud_local_identity TO zeros_dev_runtime");
}

async function execute(request) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { Pool } = loadControlPlaneDependency("pg", root);
  const module = name => import(pathToFileURL(path.join(root, "apps/control-plane/dist", name)));
  const { runMigrations, planMigrations, verifyMigrations } = await import(pathToFileURL(path.join(root, "apps/control-plane/dist/migrate.js")));
  const migration = new Pool({ connectionString: request.migrationUrl, options: "-c role=none", max: 1 });
  const runtime = new Pool({ connectionString: request.runtimeUrl, options: "-c role=none", max: 1 });
  try {
    if (request.action === "plan") return await planMigrations(migration);
    if (request.instanceId && ["migrate", "verify"].includes(request.action)) await recordLocalDatabaseOwner(migration, request);
    if (["seed", "drain"].includes(request.action)) await assertLocalDatabaseOwner(runtime, request);
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
    const { withSystemTx } = await module("db.js");
    if (request.action === "seed") {
      if (!/^[A-Za-z0-9_-]{43}$/.test(request.encryptionKey ?? "")) throw new Error("Invalid local vault key");
      const { DatabaseCloudAgentCredentialService } = await module("agent-credentials/agent-credentials.js");
      const { cloudAgentModels } = await module("agent-credentials/agent-models.js");
      const vault = new DatabaseCloudAgentCredentialService(runtime, { keys: { 1: request.encryptionKey }, currentKeyVersion: 1 });
      return await seedLocalFixture({ runtime, migration, withSystemTx, request, vault, models: cloudAgentModels });
    }
    if (request.action === "drain") {
      const { drainLocalCloudResources } = await import("./local-cleanup.mjs");
      const { BoatApiClient } = await module("cloud/boat-client.js");
      const client = new BoatApiClient({ apiKey: request.boat?.apiKey, billingOrg: request.boat?.billingOrg, timeoutMs: 30_000 });
      const { cloudV2SnapshotName, cloudV2SandboxName } = await module("cloud/resource-names.js");
      return await drainLocalCloudResources({ runtime, withSystemTx, request, provider: client,
        snapshotName: (org, version) => cloudV2SnapshotName("development", org, version, request.owner),
        sandboxName: (kind, id) => cloudV2SandboxName("development", kind, id, request.owner) });
    }
    if (request.action === "inventory") {
      return inventoryLocalWorkspaces(runtime, withSystemTx);
    }
    return { verified: true };
  } finally { await Promise.all([migration.end(), runtime.end()]); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 96 * 1024) throw new Error("Oversized development database request"); }
    const result = await execute(validateDatabaseRequest(JSON.parse(input)));
    console.log(JSON.stringify(result));
  } catch (error) {
    // SQL and driver errors may embed user data and credentials.
    if (error instanceof DevEnvironmentError) console.error(JSON.stringify(devEnvironmentDiagnostic(error)));
    else {
      try {
        const { migrationFailureDiagnostic } = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps/control-plane/dist/migrate.js")));
        console.error(migrationFailureDiagnostic(error));
      } catch { console.error(JSON.stringify(devEnvironmentDiagnostic(error))); }
    }
    process.exitCode = 1;
  }
}
