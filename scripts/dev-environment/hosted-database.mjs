import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { seedHostedFixture } from "./hosted-fixtures.mjs";

export function validateHostedDatabaseRequest(request) {
  if (!/^[a-f0-9]{24}$/.test(request?.owner ?? "") ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.generation ?? "") ||
      !["migrate", "seed", "drain", "verify", "repair-runtime-role"].includes(request.action) || !path.isAbsolute(request.buildRoot ?? "")) throw new Error("Invalid hosted Dev database operation");
  let target;
  for (const kind of ["migrate", "seed", "repair-runtime-role"].includes(request.action) ? ["runtime", "migration"] : ["runtime"]) {
    const role = request.roles?.[kind]; let url;
    try { url = new URL(role?.url); } catch { throw new Error("Missing Dev database role"); }
    if (url.protocol !== "postgresql:" || !url.hostname.endsWith(".pg.psdb.cloud") || url.port !== "5432" || url.pathname !== "/postgres" ||
        !url.password || url.hash || url.search !== "?sslmode=verify-full" || !/^pscale_api_[A-Za-z0-9_]+$/.test(role.baseUsername ?? "") ||
        decodeURIComponent(url.username) !== role.username || !role.username.startsWith(role.baseUsername + ".")) throw new Error("Invalid Dev database routing");
    const identity = `${url.host}/${url.username.split(".").at(-1)}`;
    if (target && identity !== target) throw new Error("Dev database roles target different branches"); target = identity;
  }
  if (["drain", "repair-runtime-role"].includes(request.action) && request.backendStopped !== true) throw new Error("Stop and confirm the owned backend before deleting its workers");
  return request;
}

export async function assertDatabaseOwner(pool, request) {
  const { rows } = await pool.query("SELECT owner, generation FROM zeros_development_identity");
  if (rows.length !== 1 || rows[0].owner !== request.owner || rows[0].generation !== request.generation) throw new Error("Dev database generation does not match its ownership receipt");
}

export async function grantHostedRuntimeAuthority(migration, role) {
  if (!/^pscale_api_[A-Za-z0-9_]+$/.test(role ?? "")) throw new Error("Invalid Dev runtime role");
  await migration.query(`GRANT zeros_app TO "${role}"`);
  // NOINHERIT logins read the marker and ledger before entering zeros_app.
  await migration.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await migration.query(`GRANT SELECT ON schema_migrations, zeros_development_identity TO "${role}"`);
  await migration.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await migration.query("REVOKE ALL ON zeros_development_identity FROM PUBLIC, zeros_app");
}

export async function repairHostedRuntimeAuthority(migration, request) {
  if (request.backendStopped !== true) throw new Error("Stop and confirm the owned backend before repairing cleanup authority");
  await assertDatabaseOwner(migration, request);
  await grantHostedRuntimeAuthority(migration, request.roles.runtime.baseUsername);
}

/** The backend is stopped and this database's owner marker is verified before
 * any VM or named snapshot is deleted. Failed provider calls leave its rows
 * available for the next archive attempt. */
export async function drainHostedWorkers({ pool, withSystemTx, provider, request }) {
  if (request.backendStopped !== true) throw new Error("The Dev backend must be stopped before draining workers");
  await assertDatabaseOwner(pool, request);
  const resources = await withSystemTx(pool, async tx => ({
    workspaces: (await tx.query("SELECT id,state,boat_sandbox_id FROM cloud_v2_workspaces WHERE state<>'deleted' ORDER BY id")).rows,
    builds: (await tx.query("SELECT id,state,builder_sandbox_id,snapshot_id FROM cloud_v2_computer_builds ORDER BY id")).rows,
    computers: (await tx.query("SELECT snapshot_name FROM cloud_v2_computers WHERE snapshot_name IS NOT NULL")).rows,
  }));
  if (resources.workspaces.some(row => row.state === "creating" && !row.boat_sandbox_id) ||
      resources.builds.some(row => row.state === "building" && !row.builder_sandbox_id))
    throw new Error("Dev allocation is unconfirmed; reconcile its provider result before archiving");
  await withSystemTx(pool, async tx => {
    await tx.query("DELETE FROM cloud_v2_tokens");
    await tx.query("UPDATE cloud_v2_workspaces SET worker_token_hash=NULL WHERE state<>'deleted'");
  });
  const sandboxes = new Set([...resources.workspaces.map(row => row.boat_sandbox_id), ...resources.builds.map(row => row.builder_sandbox_id)].filter(Boolean));
  for (const id of sandboxes) await provider.delete(id);
  const snapshots = new Set([...resources.builds.map(row => row.snapshot_id), ...resources.computers.map(row => row.snapshot_name)].filter(Boolean));
  for (const name of snapshots) await provider.deleteSnapshot(name);
  await withSystemTx(pool, async tx => {
    await tx.query("UPDATE cloud_v2_workspaces SET state='deleted',updated_at=clock_timestamp() WHERE state<>'deleted'");
    await tx.query("UPDATE cloud_v2_computers SET active_build_id=NULL,snapshot_name=NULL,updated_at=clock_timestamp()");
    await tx.query("UPDATE cloud_v2_computer_builds SET builder_sandbox_id=NULL,snapshot_id=NULL,state=CASE WHEN state IN ('queued','building') THEN 'cancelled' ELSE state END");
  });
  return { complete: true, pending: 0 };
}

export async function executeHostedDatabase(request) {
  validateHostedDatabaseRequest(request);
  const module = name => import(pathToFileURL(path.join(request.buildRoot, "apps/control-plane/dist", name)));
  const { createPool, createMigrationPool, withSystemTx } = await module("db.js");
  const { runMigrations, planMigrations, verifyMigrations } = await module("migrate.js");
  const runtime = createPool(request.roles.runtime.url, { maxConnections: 2 });
  try {
    if (request.action === "repair-runtime-role") {
      const migration = createMigrationPool(request.roles.migration.url, { role: "postgres" });
      try { await repairHostedRuntimeAuthority(migration, request); }
      finally { await migration.end(); }
    }
    if (request.action === "migrate") {
      const migration = createMigrationPool(request.roles.migration.url, { role: "postgres" });
      try {
        const exists = await migration.query("SELECT to_regclass('public.zeros_development_identity') AS marker");
        if (exists.rows[0]?.marker) await assertDatabaseOwner(migration, request);
        else {
          // A new empty branch is this launcher's only admissible unmarked DB.
          const tables = await migration.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
          if (tables.rows[0]?.n !== 0) throw new Error("Unmarked nonempty Dev database cannot be adopted");
          await migration.query("CREATE TABLE zeros_development_identity (owner text PRIMARY KEY, generation uuid NOT NULL)");
          await migration.query("INSERT INTO zeros_development_identity(owner,generation) VALUES ($1,$2)", [request.owner, request.generation]);
        }
        const plan = await planMigrations(migration);
        await runMigrations(migration, { env: { NODE_ENV: "production", CONTROL_PLANE_MIGRATION_APPROVALS: plan.controlledApprovals.join(",") } });
        await grantHostedRuntimeAuthority(migration, request.roles.runtime.baseUsername);
      } finally { await migration.end(); }
    }
    await assertDatabaseOwner(runtime, request);
    // Archive uses the exact previously stored operator artifact. A failed
    // subsequent migration must not prevent physical worker cleanup; the owner
    // marker and recorded resource IDs remain authoritative for destruction.
    if (!["drain", "repair-runtime-role"].includes(request.action)) await verifyMigrations(runtime);
    const authority = await runtime.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,pg_has_role(current_user,'postgres','MEMBER') AS admin,has_schema_privilege(current_user,'public','CREATE') AS ddl FROM pg_roles WHERE rolname=current_user");
    if (authority.rows.length !== 1 || Object.values(authority.rows[0]).some(Boolean)) throw new Error("Dev runtime role has elevated database authority");
    if (request.action === "seed") {
      const migration = createMigrationPool(request.roles.migration.url, { role: "postgres" });
      try {
        await assertDatabaseOwner(migration, request);
        return await seedHostedFixture({ runtime, migration, withSystemTx, module, request });
      } finally { await migration.end(); }
    }
    if (request.action !== "drain") return { verified: true };
    const { BoatApiClient } = await module("cloud/boat-client.js");
    const { BoatCloudV2Compute } = await module("cloud/boat.js");
    const client = new BoatApiClient({ apiKey: request.boat.apiKey, billingOrg: request.boat.billingOrg, timeoutMs: 30_000 });
    return await drainHostedWorkers({ pool: runtime, withSystemTx, provider: new BoatCloudV2Compute(client), request });
  } finally { await runtime.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 64 * 1024) throw new Error(); }
    const log = console.log; console.log = () => {};
    const result = await executeHostedDatabase(JSON.parse(input)); log(JSON.stringify(result));
  } catch { console.error("Hosted Dev database operation failed; credentials and SQL output were withheld. The ownership receipt was retained."); process.exitCode = 1; }
}
