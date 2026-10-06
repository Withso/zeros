import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseDatabaseTarget } from "../../apps/control-plane/src/database-target.ts";
import { diagnosticPhases } from "../../apps/control-plane/src/cloud-workspaces/cloud-diagnostics.ts";
import { privateFile } from "./template-setup-repro.mjs";

export const PERF_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const PERF_RESOURCE = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
export const perfCheck = (condition, code) => { if (!condition) throw new Error(code); };
const root = fileURLToPath(new URL("../../", import.meta.url));
const states = new Set(["requested", "provisioning", "setting_up", "ready", "busy", "waking", "stopping", "stopped",
  "archiving", "archived", "deleting", "deleted", "failed", "queued", "observing", "dispatching", "succeeded",
  "superseded", "running", "starting", "revoked", "cancelled"]);
const state = value => states.has(value) ? value : "other";
const uuid = value => PERF_UUID.test(value ?? "") ? value : null;
const number = value => value != null && value !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const timestamp = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const phase = value => diagnosticPhases.includes(value) ? value : "other";
const installerStages = new Set(["validate_input", "lock", "check_space", "check_cache", "download", "verify_archive", "verify_manifest",
  "extract", "verify_tree", "publish_receipt", "switch_pointer", "start_host", "run_setup", "done", "verify", "sanitize", "resume"]);
export const elapsed = (start, end) => {
  const a = timestamp(start), b = timestamp(end);
  return a && b && Date.parse(b) >= Date.parse(a) ? Date.parse(b) - Date.parse(a) : null;
};

export function perfDatabaseConfig(values) {
  try {
    const database = parseDatabaseTarget(values.ZEROS_PERF_ALPHA_DATABASE_URL);
    perfCheck(database.hostname.endsWith(".psdb.cloud") &&
      values.ZEROS_PLANETSCALE_ALPHA_DATABASE === "zeros-control-plane-alpha", "input_invalid");
    return { databaseUrl: database.toString() };
  } catch { throw new Error("input_invalid"); }
}

export function perfPool(config) {
  const { Pool } = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000,
    application_name: "zeros-v2-test-perf", options: "-c role=none -c default_transaction_read_only=on" });
  pool.on("error", () => {});
  return pool;
}

export async function perfRead(pool, read) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('app.system', 'on', true)");
    return await read(client);
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
}

/** Closed projection, including when supplied driver rows contain extra fields.
 * These intervals overlap and are not additive. Retried operations include all
 * attempts; first dispatch/claim and last heartbeat are not per-stage spans. */
export function perfTimeline(rows) {
  return {
    schema: "zeros.workspace-perf-timeline/v1",
    workspaceId: uuid(rows.workspace?.id), generation: number(rows.workspace?.current_generation),
    status: state(rows.workspace?.status),
    intents: rows.intents.slice(0, 32).map(row => ({ id: uuid(row.id), generation: number(row.generation),
      operation: ["create", "wake", "stop", "archive", "delete"].includes(row.operation) ? row.operation : "other",
      state: state(row.state), attempts: number(row.attempt_count), createdAt: timestamp(row.created_at),
      noOpWakeCandidate: row.operation === "wake" && row.state === "succeeded" && number(row.attempt_count) === 0,
      dispatchedAt: timestamp(row.dispatched_at), completedAt: timestamp(row.completed_at),
      queueToFirstDispatchMs: elapsed(row.created_at, row.dispatched_at),
      dispatchToCompletionMs: elapsed(row.dispatched_at, row.completed_at) })),
    setups: rows.setups.slice(0, 32).map(row => ({ id: uuid(row.id), generation: number(row.generation),
      attempt: number(row.attempt), claims: number(row.claim_count), state: state(row.state),
      createdAt: timestamp(row.created_at), startedAt: timestamp(row.started_at), completedAt: timestamp(row.completed_at),
      queueToStartMs: elapsed(row.created_at, row.started_at), executionMs: elapsed(row.started_at, row.completed_at) })),
    engines: rows.engines.slice(0, 32).map(row => ({ id: uuid(row.id), generation: number(row.generation),
      setupRunId: uuid(row.setup_run_id), state: state(row.state), protocolVersion: number(row.protocol_version),
      createdAt: timestamp(row.created_at), registeredAt: timestamp(row.registered_at),
      lastHeartbeatAt: timestamp(row.last_heartbeat_at), registrationMs: elapsed(row.created_at, row.registered_at) })),
    actors: rows.actors.slice(0, 32).map(row => ({ id: uuid(row.id), generation: number(row.generation),
      engineId: uuid(row.engine_instance_id), createdAt: timestamp(row.created_at), consumedAt: timestamp(row.consumed_at),
      admissionToConsumptionMs: elapsed(row.created_at, row.consumed_at) })),
    providerCreates: rows.providerCreates.slice(0, 32).map(row => ({ generation: number(row.generation),
      dispatchedAt: timestamp(row.dispatched_at), rejectedAt: timestamp(row.rejected_at) })),
    setupStageTimings: {
      // Successful stage spans are not persisted by the released helper.
      // Incident events are failure observations, not start/end stage spans.
      availability: "not_persisted",
      failureEvents: (rows.setupDiagnostics ?? []).slice(0, 128).map(row => ({
        incidentId: uuid(row.id), generation: number(row.generation), setupRunId: uuid(row.setup_run_id),
        phase: phase(row.phase), setupPhase: phase(row.setup_phase),
        installerStage: installerStages.has(row.installer_stage) ? row.installer_stage : null,
        firstObservedAt: timestamp(row.first_at), lastObservedAt: timestamp(row.last_at),
        reportedElapsedMs: number(row.elapsed_ms),
      })),
    },
    unmeasured: ["boat_api_duration", "vm_restore", "lazy_hydration", "verify_tree", "containment_smoke",
      "run_setup_probe", "publish_proof", "checkout", "node_sqlite_containment_start", "first_heartbeat",
      "bridge_connected_probe", "renderer_paint"],
  };
}

/** Read-only on any explicitly selected Alpha workspace, including historical
 * generations. Never reads grants, hashes, auth sessions, setup output or logs. */
export async function readPerfTimeline(pool, workspaceId) {
  perfCheck(PERF_UUID.test(workspaceId), "input_invalid");
  return perfRead(pool, async client => {
    const query = async sql => (await client.query(sql, [workspaceId])).rows;
    const [workspace] = await query("SELECT id,current_generation,status FROM cloud_workspaces WHERE id=$1");
    perfCheck(workspace, "workspace_unavailable");
    const intents = await query(`SELECT id,generation,operation,state,attempt_count,created_at,dispatched_at,completed_at
      FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 32`);
    const setups = await query(`SELECT id,generation,attempt,claim_count,state,created_at,started_at,completed_at
      FROM cloud_workspace_setup_runs WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 32`);
    const engines = await query(`SELECT id,generation,setup_run_id,state,protocol_version,created_at,registered_at,last_heartbeat_at
      FROM cloud_workspace_engine_instances WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 32`);
    const actors = await query(`SELECT id,generation,engine_instance_id,created_at,consumed_at
      FROM cloud_workspace_actor_sessions WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 32`);
    const providerCreates = await query(`SELECT generation,dispatched_at,rejected_at
      FROM cloud_workspace_provider_create_attempts WHERE workspace_id=$1 ORDER BY dispatched_at DESC LIMIT 32`);
    const setupDiagnostics = await query(`SELECT incident.id,incident.generation,incident.operation_id AS setup_run_id,
      event.value->>'firstAt' AS first_at,event.value->>'lastAt' AS last_at,
      event.value#>>'{diagnostic,phase}' AS phase,event.value#>>'{diagnostic,setup,phase}' AS setup_phase,
      event.value#>>'{diagnostic,setup,installer,stage}' AS installer_stage,
      event.value#>>'{diagnostic,elapsedMs}' AS elapsed_ms
      FROM (SELECT id,generation,operation_id,events FROM cloud_workspace_diagnostic_incidents
        WHERE workspace_id=$1 AND operation_kind='setup' ORDER BY last_at DESC,id DESC LIMIT 32) incident
      CROSS JOIN LATERAL jsonb_array_elements(incident.events) event(value)
      ORDER BY event.value->>'lastAt' DESC,incident.id LIMIT 128`);
    return perfTimeline({ workspace, intents, setups, engines, actors, providerCreates, setupDiagnostics });
  });
}

export function readPerfEnvironment() { return parseEnv(privateFile(path.join(root, ".env.agent"))); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const args = process.argv.slice(2);
    perfCheck(args.length === 2 && args[0] === "--inspect" && PERF_UUID.test(args[1]), "input_invalid");
    const pool = perfPool(perfDatabaseConfig(readPerfEnvironment()));
    try { process.stdout.write(JSON.stringify(await readPerfTimeline(pool, args[1])) + "\n"); }
    finally { await pool.end(); }
  };
  main().catch(() => { process.stderr.write('{"schema":"zeros.workspace-perf-error/v1","code":"inspection_failed"}\n'); process.exitCode = 1; });
}
