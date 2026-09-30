import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { seedHostedFixture } from "./hosted-fixtures.mjs";
import { devBoatClient } from "./hosted-image.mjs";

export function validateHostedDatabaseRequest(request) {
  if (!/^[a-f0-9]{24}$/.test(request?.owner ?? "") ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.generation ?? "") ||
      !["migrate", "seed", "drain", "verify", "repair-runtime-role", "agents-inspect", "agents-enable"].includes(request.action) || !path.isAbsolute(request.buildRoot ?? "")) throw new Error("Invalid hosted Dev database operation");
  let target;
  for (const kind of ["migrate", "seed", "repair-runtime-role", "agents-enable"].includes(request.action) ? ["runtime", "migration"] : ["runtime"]) {
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

/** The Dev backend is already physically gone. A bound deletion receipt plus
 * a documented irreversible storage stage can outlive this disposable DB in
 * the encrypted registry. This never marks the product journal physically
 * deleted and never accepts a bare 404 as proof. */
export async function retireHostedWorkerStorage(record, boat) {
  if (!/^bx_[a-z0-9]+$/.test(record?.resourceId ?? "") || !record.deletionRequestedAt ||
      !/^bdop_[a-f0-9]{32}$/.test(record.deletionOperationId ?? "")) throw new Error("Missing bound Dev worker deletion receipt");
  const response = await boat("GET", `/deletion-operations/${record.deletionOperationId}`), operation = response.body?.operation;
  if (response.status !== 200 || operation?.id !== record.deletionOperationId || operation.targetId !== record.resourceId || operation.kind !== "sandbox") {
    throw new Error("Dev worker deletion receipt identity changed");
  }
  // A just-completed operation is closed by the normal journal on the next
  // pass. Active provider deletion also remains pending, without a transfer.
  if (operation.status !== "blocked") return null;
  if (!["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"].includes(operation.stage) ||
      operation.stage === "waiting_for_uploads" && !Number.isFinite(Date.parse(operation.expectedBy))) throw new Error("Unknown Dev worker storage retention stage");
  const sandbox = await boat("GET", `/sandboxes/${record.resourceId}`);
  if (sandbox.status !== 404) throw new Error("Retired Dev worker is still accessible or its absence is unconfirmed");
  return { id: record.resourceId, deletionOperationId: record.deletionOperationId, deleteRequested: true,
    retiredAt: new Date().toISOString(), deletionStage: operation.stage, deletionExpectedBy: operation.expectedBy ?? null };
}

export async function drainHostedWorkers({ pool, withSystemTx, provider, accountScope, request, retirePending }) {
  if (request.backendStopped !== true) throw new Error("The Dev backend must be stopped before draining workers");
  await assertDatabaseOwner(pool, request);
  // The API has been physically stopped. Supersede dispatchable intents before
  // asking the normal journal's absence rule to close unallocated generations.
  await withSystemTx(pool, tx => tx.query(`UPDATE cloud_workspace_lifecycle_intents SET state='superseded',
    completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE state NOT IN ('succeeded','failed','superseded')`));
  const records = await withSystemTx(pool, async tx => (await tx.query(`SELECT provider,account_scope,workspace_id,generation,resource_id
    FROM cloud_workspace_provider_operations WHERE deleted_at IS NULL AND lost_at IS NULL AND create_closed_at IS NULL
    ORDER BY workspace_id,generation`)).rows);
  if (records.some(row => row.provider !== "boat" || row.account_scope !== accountScope)) throw new Error("Dev database contains an unexpected provider account; cleanup stopped");
  let pending = 0; const retired = [];
  for (const row of records) {
    if (!row.resource_id) {
      if (!await provider.verifyAbsence({ workspaceId: row.workspace_id, generation: row.generation })) pending++;
    } else {
      try { await provider.delete(row.resource_id); }
      catch (error) {
        if (!["provider_deletion_pending", "provider_deletion_blocked"].includes(error?.code)) throw error;
        if (!retirePending) { if (error.code === "provider_deletion_blocked") throw error; pending++; continue; }
        const receipt = await retirePending(row);
        if (receipt) retired.push(receipt); else pending++;
      }
    }
  }
  return { complete: pending === 0, pending, ...(retirePending ? { retired } : {}) };
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
    // marker and the provider journal remain authoritative for destruction.
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
    if (["agents-inspect", "agents-enable"].includes(request.action)) {
      const { inspectDevAgents } = await module("dev-agent-qualification.js");
      if (request.agentRequest?.owner !== request.owner || request.agentRequest.generation !== request.generation) throw new Error("Dev agent operator identity mismatch");
      const status = await inspectDevAgents(runtime, request.agentRequest);
      if (request.action === "agents-inspect") return status;
      const change = request.agentChange;
      // inspectDevAgents revalidates this artifact against the exact fixture,
      // provider account, current base and fresh attestation before any approval.
      const organizationImage = request.agentRequest.organizationImage;
      const image = organizationImage ?? request.worker;
      const artifact = organizationImage && status.organizationImages?.find(row => row.id === organizationImage.id);
      if (!status.connections?.some(row => row.credentialId === request.agentConnection?.credentialId &&
          row.credentialRevision === request.agentConnection.credentialRevision && row.connectionRevision === request.agentConnection.connectionRevision) ||
          change?.actorUserId !== status.actorUserId || change.evidence?.imageRef !== `boat:${image.snapshotId}@sha256:${image.buildSha256}` ||
          change.evidence?.sourceCommit !== image.sourceCommit || organizationImage &&
          (!artifact || artifact.contractSha256 !== change.evidence?.runtimeContractSha256)) throw new Error("Dev agent connection or image changed before enablement");
      const { manageCloudAgentRuntime } = await module("manage-cloud-agent-runtime.js");
      const migration = createMigrationPool(request.roles.migration.url, { role: "postgres" });
      try {
        await assertDatabaseOwner(migration, request);
        const options = { databaseUrl: request.roles.migration.url, channel: "development" };
        const plan = await manageCloudAgentRuntime(migration, change, options);
        return await manageCloudAgentRuntime(migration, change, { ...options, execute: true, approval: plan.planSha256 });
      } finally { await migration.end(); }
    }
    if (request.action !== "drain") return { verified: true };
    const { DatabaseCloudProviderOperationStore } = await module("cloud-workspaces/provider-operation-store.js");
    const { BoatWorkspaceProvider } = await module("cloud-workspaces/boat-provider.js");
    const { BoatApiClient } = await module("cloud-workspaces/boat-client.js");
    const { BoatRuntimeAccessProvider } = await module("cloud-workspaces/boat-runtime-access.js");
    const { BoatRuntimeEndpointResolver } = await module("cloud-workspaces/boat-runtime-endpoint.js");
    const operations = new DatabaseCloudProviderOperationStore(runtime, "boat", request.boat.accountScope);
    const client = new BoatApiClient({ apiKey: request.boat.apiKey, billingOrg: request.boat.billingOrg, timeoutMs: 30_000 });
    const access = new BoatRuntimeAccessProvider({ pool: runtime, operations, enginePort: 39393,
      endpoint: new BoatRuntimeEndpointResolver({ client, operations, enginePort: 39393 }) });
    const provider = new BoatWorkspaceProvider({ apiKey: request.boat.apiKey, billingOrg: request.boat.billingOrg, timeoutMs: 30_000,
      imageRef: `boat:${request.worker.snapshotId}@sha256:${request.worker.buildSha256}`, qualifiedStorageMiB: request.worker.storageMiB, ttlSeconds: 900,
      operations, access });
    return await drainHostedWorkers({ pool: runtime, withSystemTx, provider, accountScope: request.boat.accountScope, request,
      retirePending: async row => {
        const record = await operations.get(row.resource_id);
        if (!record || record.workspaceId !== row.workspace_id || record.generation !== row.generation) throw new Error("Dev worker journal binding changed");
        const receipt = await retireHostedWorkerStorage(record, devBoatClient(request.boat));
        return receipt ? { ...receipt, accountScope: request.boat.accountScope, billingOrg: request.boat.billingOrg,
          devOwner: request.owner, devGeneration: request.generation, workspaceId: row.workspace_id, generation: row.generation } : null;
      } });
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
