import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { BoatApiClient, BOAT_RESOURCE_ID_PATTERN } from "../../apps/control-plane/src/cloud-workspaces/boat-client.ts";
import { RuntimeBaseStatusSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-contract.ts";
import { templateSetupReproConfig, privateFile, newTemplateSetupJournal, templateSetupForkBody,
  recoverFork, cleanupTemplateSetupFork, readTemplateSetupSource, templateSetupErrorDiagnostic } from "./template-setup-repro.mjs";
import { sanitizeEngineConnectProbe } from "./engine-connect-probe.mjs";
import { pythonProbe } from "./boat-image/runtime-base-v4.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const root = fileURLToPath(new URL("../../", import.meta.url));
const check = (ok, code = "source_invalid") => { if (!ok) throw new Error(code); };
const pause = () => new Promise(resolve => setTimeout(resolve, 5000));
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const select = (value, allowed) => allowed.includes(value) ? value : "other";
const STATES = ["requested", "provisioning", "setting_up", "ready", "busy", "stopping", "stopped", "archiving", "archived",
  "deleting", "deleted", "failed", "error", "running", "queued", "observing", "dispatching", "succeeded", "superseded",
  "starting", "revoked", "delivered", "cancelled"];

/** Only public identity, state, timestamps and explicit booleans leave the
 * read-only transaction. No grants, hashes, payloads or audit subjects are read. */
export async function readEngineConnectSource(pool, workspaceId) {
  check(UUID.test(workspaceId), "input_invalid");
  const client = await pool.connect();
  let row, timeline;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.system', 'on', true)");
    row = (await client.query(`SELECT w.org_id,w.status,w.desired_state,w.current_generation,
      b.provider_resource_id,g.runtime_id,g.runtime_base_image_id,g.runtime_base_compatibility_id,
      g.architecture,g.cpu_millicores,g.memory_mib,g.storage_mib,
      t.provider_resource_id AS template_resource_id
      FROM cloud_workspaces w JOIN cloud_workspace_generations g ON g.workspace_id=w.id AND g.generation=w.current_generation
      JOIN cloud_workspace_provider_bindings b ON b.workspace_id=g.workspace_id AND b.generation=g.generation AND b.provider='boat'
      LEFT JOIN cloud_workspace_computer_sources s ON s.workspace_id=g.workspace_id AND s.generation=g.generation
      LEFT JOIN cloud_computer_templates t ON t.build_id=s.template_id AND t.org_id=w.org_id
      WHERE w.id=$1 AND w.deleted_at IS NULL`, [workspaceId])).rows[0];
    check(row && UUID.test(row.org_id) && BOAT_RESOURCE_ID_PATTERN.test(row.provider_resource_id) &&
      /^r1-[a-f0-9]{64}$/.test(row.runtime_id) && row.runtime_base_image_id?.startsWith("zeros-v2-test-"));
    const scope = [workspaceId, row.current_generation];
    const engines = (await client.query(`SELECT id,state,protocol_version,created_at,registered_at,last_heartbeat_at,lease_expires_at,revoked_at
      FROM cloud_workspace_engine_instances WHERE workspace_id=$1 AND generation=$2 ORDER BY created_at DESC LIMIT 16`, scope)).rows;
    const intents = (await client.query(`SELECT id,operation,state,created_at,dispatched_at,completed_at,
      requested_by IS NULL AS system_requested,idempotency_key LIKE 'system:idle:%' AS idle_requested
      FROM cloud_workspace_lifecycle_intents WHERE workspace_id=$1 AND generation=$2 ORDER BY created_at DESC LIMIT 32`, scope)).rows;
    const checkpoints = (await client.query(`SELECT id,reason,state,created_at,completed_at,idle_engine_instance_id IS NOT NULL AS idle_requested
      FROM workspace_checkpoint_requests WHERE workspace_id=$1 AND generation=$2 ORDER BY created_at DESC LIMIT 32`, scope)).rows;
    const access = (await client.query(`SELECT DISTINCT revocation_reason FROM cloud_workspace_client_access_grants
      WHERE workspace_id=$1 AND generation=$2 AND revocation_reason IS NOT NULL LIMIT 16`, scope)).rows;
    const actors = (await client.query(`SELECT id,created_at,consumed_at,last_renewed_at,admission_expires_at,session_expires_at,revoked_at,actor_role
      FROM cloud_workspace_actor_sessions WHERE workspace_id=$1 AND generation=$2 ORDER BY created_at DESC LIMIT 64`, scope)).rows;
    const rowView = value => ({ id: UUID.test(value.id) ? value.id : null, state: select(value.state, STATES),
      createdAt: timestamp(value.created_at), completedAt: timestamp(value.completed_at) });
    timeline = { workspace: { status: select(row.status, STATES), desiredState: select(row.desired_state, STATES) },
      engines: engines.map(value => ({ ...rowView(value), protocolVersion: Number(value.protocol_version),
        registeredAt: timestamp(value.registered_at), heartbeatAt: timestamp(value.last_heartbeat_at),
        leaseExpiresAt: timestamp(value.lease_expires_at), revokedAt: timestamp(value.revoked_at) })),
      intents: intents.map(value => ({ ...rowView(value), operation: select(value.operation, ["start", "stop", "archive", "delete", "rebuild", "fork"]),
        dispatchedAt: timestamp(value.dispatched_at), systemRequested: value.system_requested === true, idleRequested: value.idle_requested === true })),
      checkpoints: checkpoints.map(value => ({ ...rowView(value), reason: select(value.reason,
        ["before_stop", "before_archive", "before_delete", "before_fork", "before_rebuild", "manual"]), idleRequested: value.idle_requested === true })),
      actors: actors.map(value => ({ id: UUID.test(value.id) ? value.id : null, createdAt: timestamp(value.created_at),
        consumedAt: timestamp(value.consumed_at), renewedAt: timestamp(value.last_renewed_at), revokedAt: timestamp(value.revoked_at),
        admissionExpiresAt: timestamp(value.admission_expires_at), sessionExpiresAt: timestamp(value.session_expires_at),
        role: select(value.actor_role, ["viewer", "prompter", "developer", "manager", "owner"]) })),
      accessRetirements: access.map(value => select(value.revocation_reason, ["workspace_stop_requested", "workspace_archive_requested",
        "workspace_delete_requested", "provider_not_running", "lifecycle_superseded", "generation_superseded", "generation_replacement_requested",
        "generation_candidate_rejected", "generation_replaced", "paid_authority_revoked", "provider_authority_revoked", "provider_operation_failed",
        "engine_unavailable", "setup_failed"])) };
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
  let computer;
  if (row.template_resource_id) computer = await readTemplateSetupSource(pool,
    newTemplateSetupJournal(workspaceId, row.current_generation, row.template_resource_id));
  return { workspaceId, organizationId: row.org_id, generation: row.current_generation,
    sourceId: row.provider_resource_id, runtimeId: row.runtime_id, baseCompatibilityId: row.runtime_base_compatibility_id,
    protocolVersion: timeline.engines[0]?.protocolVersion ?? 20, timeline,
    ...(computer ? { computer: computer.computer, repository: computer.repository } : {}),
    image: { resources: { architecture: row.architecture, cpuMillicores: row.cpu_millicores,
      memoryMiB: row.memory_mib, storageMiB: Number(row.storage_mib) } } };
}

export function engineConnectProgram(source, material) {
  const data = gzipSync(JSON.stringify({ source, material })).toString("base64");
  return `import base64,gzip,json,os,subprocess,sys
try:
 data=json.loads(gzip.decompress(base64.b64decode(${JSON.stringify(data)})))
 node=os.path.realpath('/opt/zeros/current/bin/node')
 program=data['source']+chr(10)+'process.stdout.write(JSON.stringify(await engineConnectProbe('+json.dumps(data['material'])+')));'
 result=subprocess.run([node,'--input-type=module','-'],input=program.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,env={'PATH':'/usr/bin:/bin','HOME':'/root'})
 if result.returncode!=0 or len(result.stdout)>65536: raise ValueError()
 sys.stdout.buffer.write(result.stdout)
except Exception:
 print(json.dumps({'schema':'zeros.engine-connect-error/v1','code':'probe_failed'}))
 sys.exit(1)
`;
}

export async function runEngineConnectRepro(journal, material, billingOrg, deps) {
  deps.save(journal);
  try {
    const source = (await deps.request(`/sandboxes/${journal.templateId}`)).sandbox;
    check(source?.id === material.sourceId && source.id === journal.templateId && source.team?.id?.toLowerCase() === billingOrg.toLowerCase());
    if (source.state === "running") {
      journal.phase = "probe";
      journal.probe = sanitizeEngineConnectProbe(await deps.probe(source.id, { ...material, fork: false }));
    } else {
      check(source.state === "archived" && source.snapshotAvailable === true && source.lastSnapshotStatus === "completed");
      journal.forkBody = templateSetupForkBody(material);
      journal.phase = "fork"; journal.createAttempted = true; deps.save(journal);
      await recoverFork(journal, deps);
      await deps.request(`/sandboxes/${journal.childId}`, { method: "PATCH", body: { name: `zeros-v2-test-engine-connect-${journal.id}` } });
      journal.phase = "bootstrap"; deps.save(journal);
      await deps.ready(journal, material);
      journal.phase = "probe"; deps.save(journal);
      journal.probe = sanitizeEngineConnectProbe(await deps.probe(journal.childId, { ...material, fork: true }));
      if (!journal.probe.serve?.ready || !journal.probe.serve.socket?.workspaceResponse)
        journal.failedChecks.push("engine_connection_failed");
      if (!journal.probe.retired) journal.failedChecks.push("engine_retirement_failed");
    }
  } catch (error) {
    deps.diagnose(journal.phase, error);
    journal.failedChecks.push("probe_failed");
  } finally {
    try { await cleanupTemplateSetupFork(journal, deps); }
    catch (error) { deps.diagnose("cleanup", error); journal.failedChecks.push("cleanup_pending"); }
    deps.save(journal);
  }
  return journal;
}

async function main() {
  const args = process.argv.slice(2), cleanup = args[0] === "--cleanup";
  check(args.length === (cleanup ? 2 : 3) && (cleanup ? UUID.test(args[1]) : args[0] === "--run" && args[1] === "--workspace" && UUID.test(args[2])), "input_invalid");
  const config = templateSetupReproConfig(parseEnv(privateFile(path.join(root, ".env.agent"))));
  const directory = path.join(root, ".context/zeros-v2-test-engine-connect");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const boat = new BoatApiClient({ apiKey: config.apiKey, billingOrg: config.billingOrg, timeoutMs: 30000, diagnostics: () => {} });
  const { Pool } = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 10000,
    statement_timeout: 15000, idle_in_transaction_session_timeout: 15000,
    application_name: "zeros-v2-test-engine-connect", options: "-c role=none -c default_transaction_read_only=on" });
  const diagnose = (phase, error) => process.stderr.write(JSON.stringify(templateSetupErrorDiagnostic(phase, error)) + "\n");
  pool.on("error", error => diagnose("source", error));
  try {
    const material = cleanup ? null : await readEngineConnectSource(pool, args[2]);
    const journal = cleanup ? JSON.parse(privateFile(path.join(directory, `${args[1]}.json`))) :
      { ...newTemplateSetupJournal(material.workspaceId, material.generation, material.sourceId), timeline: material.timeline };
    check(journal.schema === "zeros.template-setup-repro/v1" && UUID.test(journal.id) && UUID.test(journal.workspaceId) &&
      BOAT_RESOURCE_ID_PATTERN.test(journal.templateId) && Array.isArray(journal.failedChecks), "input_invalid");
    const save = value => {
      const target = path.join(directory, `${journal.id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, target);
    };
    const deps = { request: boat.request.bind(boat), save, diagnose,
      ready: async (journal, material) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          try {
            const source = (await boat.request(`/sandboxes/${journal.childId}`)).sandbox;
            check(source?.id === journal.childId && source.team?.id?.toLowerCase() === config.billingOrg.toLowerCase() &&
              (source.sourceSandboxId === undefined || source.sourceSandboxId === journal.templateId), "child_invalid");
            const reply = await boat.request(`/sandboxes/${journal.childId}/commands`, { method: "POST", body: {
              command: "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py status", timeoutSeconds: 20 } });
            const parsed = RuntimeBaseStatusSchema.safeParse(JSON.parse(reply.stdout));
            if (reply.success === true && reply.exitCode === 0 && !reply.timedOut && !reply.stdoutTruncated && parsed.success &&
              parsed.data.baseCompatibilityId === material.baseCompatibilityId && ["idle", "waiting_for_runtime"].includes(parsed.data.hostState)) return;
          } catch (error) { diagnose("bootstrap", error); }
          await pause();
        }
        throw new Error("bootstrap_timeout");
      },
      probe: async (id, material) => {
        const source = readFileSync(new URL("./engine-connect-probe.mjs", import.meta.url), "utf8");
        const reply = await boat.request(`/sandboxes/${id}/commands`, { method: "POST", timeoutMs: 140000,
          body: { command: pythonProbe(engineConnectProgram(source, material), "verify"), timeoutSeconds: 130 } });
        check(reply.success === true && reply.exitCode === 0 && !reply.timedOut && !reply.stdoutTruncated &&
          typeof reply.stdout === "string" && Buffer.byteLength(reply.stdout) <= 65536, "probe_invalid");
        return JSON.parse(reply.stdout);
      } };
    if (cleanup) await cleanupTemplateSetupFork(journal, deps);
    else await runEngineConnectRepro(journal, material, config.billingOrg, deps);
    // The journal stores only sanitized probe output and selected database fields.
    process.stdout.write(JSON.stringify({ runId: journal.id, sourceId: journal.templateId, childId: journal.childId,
      cleanup: journal.cleanup, cleanupStorageStage: journal.cleanupStorageStage, failedChecks: journal.failedChecks,
      timeline: cleanup ? undefined : journal.timeline, probe: cleanup ? undefined : journal.probe }) + "\n");
    process.exitCode = journal.cleanup === "pending" || journal.failedChecks.length ? 1 : 0;
  } finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { process.stderr.write(JSON.stringify(templateSetupErrorDiagnostic("top_level", error)) + "\n"); process.exitCode = 1; });
