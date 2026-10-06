import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoatApiClient } from "../../apps/control-plane/src/cloud-workspaces/boat-client.ts";
import { RuntimeBaseStatusSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-contract.ts";
import { templateSetupReproConfig, privateFile, newTemplateSetupJournal, readTemplateSetupSource,
  runTemplateSetupRepro, runTemplateSetupProbe, cleanupTemplateSetupFork, templateSetupErrorDiagnostic } from "./template-setup-repro.mjs";
import { sanitizeProbeReport } from "./template-setup-probe.mjs";
import { PERF_UUID, PERF_RESOURCE, perfCheck, perfPool, perfRead, readPerfEnvironment } from "./workspace-perf-timeline.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const STATUS = "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py status";
const name = journal => `zeros-v2-test-perf-${journal.id}`;
const providerReady = state => ["ready", "idle", "running"].includes(state);
const BOOT_DETAILS = "/usr/bin/sudo -n /usr/bin/python3 -I - <<'PY_PERF'\n" +
  readFileSync(new URL("./workspace-perf-bootstrap.py", import.meta.url), "utf8") + "\nPY_PERF";
const unitStates = new Set(["active", "activating", "inactive", "deactivating", "failed", "reloading"]);
const unitSubstates = new Set(["dead", "start", "start-pre", "start-post", "running", "exited", "failed", "auto-restart", "stop", "stop-sigterm", "stop-sigkill"]);
const unitResults = new Set(["success", "exit-code", "signal", "timeout", "resources", "start-limit-hit", "core-dump", "watchdog", "oom-kill"]);
const unitTimes = ["ExecMainStartTimestampMonotonic", "ExecMainExitTimestampMonotonic", "ActiveEnterTimestampMonotonic"];
const boundedInteger = (value, maximum = 10 ** 15) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
export function parsePerfBootstrapDetails(value) {
  if (value?.schema !== "zeros.workspace-perf-bootstrap/v1") return { availability: "invalid_response" };
  return { schema: value.schema, observedMonotonicUs: boundedInteger(value.observedMonotonicUs),
    hydrationDone: value.hydrationDone === true, activeDescriptorPresent: value.activeDescriptorPresent === true,
    units: (Array.isArray(value.units) ? value.units : []).slice(0, 2).filter(unit => ["zeros-boot.service", "zeros-host.service"].includes(unit?.unit))
      .map(unit => ({ unit: unit.unit, active: unitStates.has(unit.active) ? unit.active : "unknown",
        sub: unitSubstates.has(unit.sub) ? unit.sub : "unknown", result: unitResults.has(unit.result) ? unit.result : "unknown",
        exitCode: boundedInteger(unit.exitCode, 255), ...Object.fromEntries(unitTimes.map(key => [key, boundedInteger(unit[key])])) })),
    hydrationEvents: (Array.isArray(value.hydrationEvents) ? value.hydrationEvents : []).slice(-8)
      .filter(event => ["persistence_hydration_wait", "persistence_hydration_ready", "persistence_hydration_timeout"].includes(event?.event))
      .map(event => ({ event: event.event, waitedSeconds: boundedInteger(event.waitedSeconds, 600), observedMonotonicUs: boundedInteger(event.observedMonotonicUs) })),
  };
}
const bootstrapStages = new Set(["validate_input", "lock", "check_space", "check_cache", "download", "verify_archive", "verify_manifest",
  "extract", "verify_tree", "publish_receipt", "switch_pointer", "start_host", "run_setup", "done"]);
const bootstrapChecks = new Set(["input_schema", "input_too_large", "artifact_host", "artifact_expired", "insufficient_space", "cache_conflict",
  "http_status", "download_truncated", "archive_digest", "archive_size", "manifest_digest", "manifest_schema", "bootstrap_protocol",
  "archive_paths", "archive_member_type", "file_inventory", "file_digest", "file_mode", "symlink_escape", "root_ownership", "hard_link",
  "pointer_publish", "host_start", "setup_exit", "timeout", "process_signal", "diagnostic_missing", "lock_busy", "base_compatibility",
  "cgroup_retired", "uid_map", "apparmor", "cgroup_controllers"]);

// Preserve the rejection reason, never the response, stderr or unrecognized
// diagnostic text. Status polling is observational; it cannot restart a host
// or bypass any readiness/identity check.
function observeBootstrap(response, expectedBase, timings) {
  let value;
  if (typeof response?.stdout === "string" && Buffer.byteLength(response.stdout) <= 16_384 && /^[^\r\n]+\n?$/.test(response.stdout)) {
    try { value = JSON.parse(response.stdout); } catch { /* Closed invalid_response below. */ }
  }
  if (value?.schema === "zeros.diagnostic/v1" && value.component === "bootstrap" && Array.isArray(value.failedChecks)) {
    timings.lastBootstrapDiagnostic = {
      stage: bootstrapStages.has(value.stage) ? value.stage : "unknown",
      failedChecks: [...new Set(value.failedChecks.filter(check => bootstrapChecks.has(check)))].slice(0, 32),
    };
  }
  if (response?.timedOut) return "command_timeout";
  if (response?.stdoutTruncated) return "command_overflow";
  if (response?.exitCode !== 0) return "command_nonzero";
  if (response?.success !== true) return "command_unsuccessful";
  const parsed = RuntimeBaseStatusSchema.safeParse(value);
  if (!parsed.success) return "invalid_response";
  if (parsed.data.baseCompatibilityId !== expectedBase) return "base_mismatch";
  return ["idle", "waiting_for_runtime"].includes(parsed.data.hostState) ? "ready" : `host_${parsed.data.hostState}`;
}

export async function inspectPerfVmSource(pool, workspaceId, templateId, billingOrg, request, materialReader = readTemplateSetupSource) {
  perfCheck(PERF_UUID.test(workspaceId) && PERF_RESOURCE.test(templateId), "input_invalid");
  const rows = await perfRead(pool, async client => (await client.query(`SELECT workspace.id,workspace.current_generation,workspace.status,
    source.build_id,template.provider_resource_id AS pinned_template_id,
    source.workspace_id IS NOT NULL AS source_present,build.state='succeeded' AS build_succeeded,
    template.state='ready' AS template_ready,template.stopped_at IS NOT NULL AS template_stopped,
    octet_length(template.protected_contract_digest)=32 AS protected_digest,
    source.template_id=source.build_id AS source_matches_build,
    gen.image_ref='boat-template:'||template.provider_resource_id AS image_matches_template,
    repo.repository_id IS NOT NULL AS repository_present,base.base_image_id IS NOT NULL AS base_present,
    build.base_image_id LIKE 'zeros-v2-test-%' AS base_test_named,build.runtime_id=gen.runtime_id AS same_runtime
    FROM cloud_workspaces workspace
    LEFT JOIN cloud_workspace_generations gen ON gen.workspace_id=workspace.id AND gen.org_id=workspace.org_id AND gen.generation=workspace.current_generation
    LEFT JOIN cloud_workspace_computer_sources source ON source.workspace_id=gen.workspace_id AND source.generation=gen.generation AND source.org_id=gen.org_id
    LEFT JOIN cloud_computer_v2_builds build ON build.id=source.build_id AND build.config_id=source.config_id AND build.org_id=source.org_id
    LEFT JOIN cloud_computer_templates template ON template.build_id=source.template_id AND template.org_id=source.org_id
    LEFT JOIN cloud_runtime_base_images base ON base.base_image_id=build.base_image_id AND base.provider='boat'
    LEFT JOIN cloud_workspace_setup_specs spec ON spec.workspace_id=gen.workspace_id AND spec.generation=gen.generation AND spec.org_id=gen.org_id
    LEFT JOIN cloud_computer_v2_config_repositories repo ON repo.config_id=source.config_id AND repo.org_id=source.org_id
      AND repo.repository_owner=lower(spec.repository_owner) AND repo.repository_name=lower(spec.repository_name)
    WHERE workspace.id=$1 LIMIT 2`, [workspaceId])).rows);
  const row = rows[0];
  perfCheck(row?.id === workspaceId, "workspace_unavailable");
  const checks = Object.fromEntries(["source_present", "build_succeeded", "template_ready", "template_stopped", "protected_digest",
    "source_matches_build", "image_matches_template", "repository_present", "base_present", "base_test_named"].map(key => [key, row[key] === true]));
  checks.requestedTemplateMatchesPin = row.pinned_template_id === templateId;
  checks.sourceRowUnique = rows.length === 1;
  let materialError = null;
  if (Object.values(checks).every(Boolean)) {
    try { await materialReader(pool, { workspaceId, generation: row.current_generation, templateId }); }
    catch (error) { materialError = templateSetupErrorDiagnostic("source", error); }
  }
  let provider = null, providerError = null;
  try {
    const { sandbox } = await request(`/sandboxes/${templateId}`);
    provider = { idMatches: sandbox?.id === templateId, walletMatches: sandbox?.team?.id?.toLowerCase() === billingOrg.toLowerCase(),
      archived: sandbox?.state === "archived", snapshotAvailable: sandbox?.snapshotAvailable === true,
      snapshotCompleted: sandbox?.lastSnapshotStatus === "completed" };
  } catch (error) { providerError = templateSetupErrorDiagnostic("source", error); }
  return { schema: "zeros.workspace-perf-source/v1", workspaceId, generation: row.current_generation,
    workspaceStatus: ["ready", "busy", "stopped", "archived", "setting_up", "waking", "failed"].includes(row.status) ? row.status : "other",
    requestedTemplateId: templateId, pinnedTemplateId: PERF_RESOURCE.test(row.pinned_template_id ?? "") ? row.pinned_template_id : null,
    buildId: PERF_UUID.test(row.build_id ?? "") ? row.build_id : null, currentRuntimeMatchesTemplate: row.same_runtime === true,
    checks, materialError, provider, providerError,
    eligible: Object.values(checks).every(Boolean) && materialError === null && provider !== null && Object.values(provider).every(Boolean) };
}

function retainDiagnostic(journal, phase, error) {
  const diagnostics = journal.perf.diagnostics ??= [];
  if (diagnostics.length < 8) diagnostics.push(templateSetupErrorDiagnostic(phase, error));
}

/** Reuse the qualified fork/probe/cleanup boundary, changing only the
 * diagnostic resource namespace. Never pass arbitrary methods to the source. */
export function perfVmRequest(journal, billingOrg, request, now = performance.now.bind(performance)) {
  return async (pathname, input = {}) => {
    const method = input.method ?? "GET";
    const source = `/sandboxes/${journal.templateId}`, child = `/sandboxes/${journal.childId}`;
    perfCheck(
      method === "GET" && pathname === source ||
      method === "POST" && pathname === `${source}/fork` ||
      journal.childId && journal.childId !== journal.templateId && (
        pathname === child && ["GET", "PATCH", "DELETE"].includes(method) ||
        method === "POST" && ["commands", "stop", "resume"].some(action => pathname === `${child}/${action}`)) ||
      method === "GET" && /^bdop_[a-f0-9]{32}$/.test(journal.deletionId ?? "") && pathname === `/deletion-operations/${journal.deletionId}`,
      "request_scope_invalid");
    if (method === "PATCH") input = { ...input, body: { name: name(journal) } };
    if (input.idempotencyKey) input = { ...input, idempotencyKey: input.idempotencyKey.replace(`zeros-v2-test-s1-${journal.id}`, name(journal)) };
    if (method === "DELETE") {
      const { sandbox } = await request(child);
      // The qualified fork receipt binds childId. Cleanup must still work if
      // naming that child failed; a mutable provider name is not authority.
      perfCheck(sandbox?.id === journal.childId &&
        (sandbox.sourceSandboxId === undefined || sandbox.sourceSandboxId === journal.templateId) &&
        sandbox.team?.id?.toLowerCase() === billingOrg.toLowerCase(), "cleanup_scope_invalid");
    }
    const operation = pathname.endsWith("/fork") ? "fork" : pathname.endsWith("/resume") ? "resume" :
      pathname.endsWith("/commands") ? "command" : pathname.endsWith("/stop") ? "stop" : method === "PATCH" ? "rename" : method === "DELETE" ? "delete" : "inspect";
    const phase = ["source", "fork", "bootstrap", "probe", "cleanup"].includes(journal.phase) ? journal.phase : "source";
    const metric = `${journal.perf.cycle}_${phase}_${operation}`, started = now(); let ok = false;
    try { const result = await request(pathname, input); ok = true; return result; }
    finally {
      const ms = Math.max(0, Math.round(now() - started));
      const sample = journal.perf.api[metric] ??= { count: 0, failed: 0, totalMs: 0, maxMs: 0 };
      sample.count++; if (!ok) sample.failed++; sample.totalMs += ms; sample.maxMs = Math.max(sample.maxMs, ms);
    }
  };
}

export function perfProbeStages(value) {
  const probe = sanitizeProbeReport(value);
  return { checksPassed: probe.checks.every(check => check.ok),
    attester: probe.checks.flatMap(check => check.attester?.stages ?? []),
    later: (probe.later ?? []).map(stage => ({ stage: stage.stage, outcome: stage.outcome, durationMs: stage.durationMs })) };
}

export async function runPerfVm(journal, config, deps) {
  const { request, load, probe, save, wait = pause, now = performance.now.bind(performance) } = deps;
  let cycleStarted = now();
  const inspectBootstrap = async timings => {
    try {
      const response = await request(`/sandboxes/${journal.childId}/commands`, { method: "POST", body: { command: BOOT_DETAILS, timeoutSeconds: 20 } });
      timings.bootstrapDetails = response.success === true && response.exitCode === 0 && !response.timedOut && !response.stdoutTruncated &&
        typeof response.stdout === "string" && Buffer.byteLength(response.stdout) <= 16_384 ? parsePerfBootstrapDetails(JSON.parse(response.stdout)) : { availability: "unavailable" };
    } catch { timings.bootstrapDetails = { availability: "unavailable" }; }
    save(journal);
  };
  const ready = async (_journal, material) => {
    const deadline = now() + 600_000;
    const timings = journal.perf[journal.perf.cycle];
    const observations = timings.bootstrapObservations ??= {};
    let pollMs = 250;
    while (now() < deadline) {
      let observation = "provider_pending";
      try {
        const { sandbox } = await request(`/sandboxes/${journal.childId}`);
        perfCheck(sandbox?.id === journal.childId && sandbox.team?.id?.toLowerCase() === config.billingOrg.toLowerCase() &&
          (sandbox.sourceSandboxId === undefined || sandbox.sourceSandboxId === journal.templateId), "child_invalid");
        if (providerReady(sandbox.state)) {
          timings.providerReadyObservedMs ??= Math.round(now() - cycleStarted);
          const response = await request(`/sandboxes/${journal.childId}/commands`, { method: "POST", body: { command: STATUS, timeoutSeconds: 20 } });
          observation = observeBootstrap(response, material.computer.template.baseCompatibilityId, timings);
          if (observation === "ready") {
            observations.ready = (observations.ready ?? 0) + 1;
            timings.baseReadyObservedMs = Math.round(now() - cycleStarted);
            await inspectBootstrap(timings); return;
          }
        }
      } catch { observation = "request_failed"; }
      observations[observation] = (observations[observation] ?? 0) + 1;
      timings.bootstrapPollMaxMs = pollMs;
      save(journal);
      await wait(Math.min(pollMs, Math.max(0, deadline - now())));
      // Leave the initial ready probe fast; bound pressure on a boot that is
      // persistently unavailable. Each failed loop previously spawned Python
      // and inspected the provider again after only 250 ms.
      pollMs = Math.min(5_000, pollMs * 2);
    }
    await inspectBootstrap(timings);
    throw new Error("bootstrap_timeout");
  };
  await runTemplateSetupRepro(journal, config.billingOrg, {
    request, save, ready, diagnose: (phase, error) => retainDiagnostic(journal, phase, error), wait: () => wait(5_000), attempts: 120,
    load: async () => { const material = await load(journal); cycleStarted = now(); return material; },
    probe: async (_journal, material) => {
      const createProbe = await probe(journal.childId, material);
      journal.perf.create.stages = perfProbeStages(createProbe); save(journal);
      perfCheck(journal.perf.create.stages.checksPassed && !journal.perf.create.stages.later.some(stage => stage.outcome === "failed"), "probe_failed");
      // Only this journal's disposable child is stopped/resumed. The source
      // workspace/template retains its compute, credentials and delegations.
      journal.perf.cycle = "stop"; save(journal);
      await request(`/sandboxes/${journal.childId}/stop`, { method: "POST", body: {} });
      const stopDeadline = now() + 600_000;
      let stopped = false;
      while (now() < stopDeadline) {
        const { sandbox } = await request(`/sandboxes/${journal.childId}`);
        if (sandbox?.id === journal.childId && sandbox.state === "archived" && sandbox.snapshotAvailable === true && sandbox.lastSnapshotStatus === "completed") { stopped = true; break; }
        await wait(1_000);
      }
      perfCheck(stopped, "stop_timeout");
      journal.perf.cycle = "wake"; journal.phase = "bootstrap"; cycleStarted = now(); save(journal);
      await request(`/sandboxes/${journal.childId}/resume`, { method: "POST", body: { ttlSeconds: 1800 },
        idempotencyKey: `${name(journal)}.resume` });
      await ready(journal, material);
      journal.phase = "probe";
      const wakeProbe = await probe(journal.childId, material);
      journal.perf.wake.stages = perfProbeStages(wakeProbe); save(journal);
      return wakeProbe;
    },
  });
}

async function main() {
  const args = process.argv.slice(2), cleanup = args[0] === "--cleanup", inspect = args[0] === "--inspect-source";
  perfCheck(inspect ? args.length === 5 && args[1] === "--workspace" && PERF_UUID.test(args[2]) && args[3] === "--template" && PERF_RESOURCE.test(args[4]) :
    cleanup ? args.length === 2 && PERF_UUID.test(args[1]) : args.length === 6 && args[0] === "--run" &&
    ["before", "after"].includes(args[1]) && args[2] === "--workspace" && PERF_UUID.test(args[3]) && args[4] === "--template" && PERF_RESOURCE.test(args[5]), "input_invalid");
  const env = readPerfEnvironment();
  const config = templateSetupReproConfig({ ...env, ZEROS_S1_ALPHA_DATABASE_URL: env.ZEROS_PERF_ALPHA_DATABASE_URL });
  const pool = perfPool(config), boat = new BoatApiClient({ apiKey: config.apiKey, billingOrg: config.billingOrg, timeoutMs: 30_000, diagnostics: () => {} });
  if (inspect) {
    try { process.stdout.write(JSON.stringify(await inspectPerfVmSource(pool, args[2], args[4], config.billingOrg, boat.request.bind(boat))) + "\n"); }
    finally { await pool.end(); }
    return;
  }
  const directory = path.join(root, ".context", "zeros-v2-test-perf-vm"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = cleanup ? args[1] : randomUUID(), file = path.join(directory, `${id}.json`);
  const generation = cleanup ? null : await perfRead(pool, async client =>
    (await client.query("SELECT current_generation FROM cloud_workspaces WHERE id=$1", [args[3]])).rows[0]?.current_generation);
  const journal = cleanup ? JSON.parse(privateFile(file)) : { ...newTemplateSetupJournal(args[3], generation, args[5], id),
    perf: { label: args[1], cycle: "create", api: {}, create: {}, wake: {} } };
  perfCheck(journal.id === id && PERF_UUID.test(id) && PERF_UUID.test(journal.workspaceId) && PERF_RESOURCE.test(journal.templateId) &&
    (journal.childId === null || PERF_RESOURCE.test(journal.childId) && journal.childId !== journal.templateId) &&
    ["before", "after"].includes(journal.perf?.label) && ["create", "stop", "wake"].includes(journal.perf?.cycle) &&
    ["pending", "verified", "not_created"].includes(journal.cleanup) &&
    [null, undefined, "waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"].includes(journal.cleanupStorageStage) &&
    Array.isArray(journal.failedChecks) && journal.failedChecks.every(code =>
      ["verification_failed", "probe_failed", "cleanup_pending"].includes(code)), "journal_invalid");
  const save = value => {
    const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  };
  const request = perfVmRequest(journal, config.billingOrg, boat.request.bind(boat));
  const deps = { request, save, load: () => readTemplateSetupSource(pool, journal),
    probe: (child, material) => runTemplateSetupProbe(child, material, { request, diagnose: (phase, error) => retainDiagnostic(journal, phase, error) }) };
  try {
    if (cleanup) await cleanupTemplateSetupFork(journal, { request, save, diagnose: () => {} });
    else await runPerfVm(journal, config, deps);
    process.stdout.write(JSON.stringify({ schema: "zeros.workspace-perf-vm/v1", runId: id, childId: journal.childId,
      metrics: cleanup ? undefined : journal.perf, cleanup: journal.cleanup, storagePending: journal.cleanupStorageStage,
      failedChecks: journal.failedChecks.filter(code => ["verification_failed", "probe_failed", "cleanup_pending"].includes(code)),
      isolatedProbe: true, controlPlaneSetupAndActorAdmission: "not_measured", readinessPollMs: 250, readinessPollMaxMs: 5_000 }) + "\n");
    process.exitCode = journal.cleanup === "pending" || !cleanup && journal.failedChecks.length ? 1 : 0;
  } finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { process.stderr.write('{"schema":"zeros.workspace-perf-error/v1","code":"vm_run_failed_retain_cleanup_journal"}\n'); process.exitCode = 1; });
