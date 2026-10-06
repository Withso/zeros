import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoatApiClient } from "../../apps/control-plane/src/cloud-workspaces/boat-client.ts";
import { RuntimeBaseStatusSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-contract.ts";
import { templateSetupReproConfig, privateFile, newTemplateSetupJournal, readTemplateSetupSource,
  runTemplateSetupRepro, runTemplateSetupProbe, cleanupTemplateSetupFork } from "./template-setup-repro.mjs";
import { sanitizeProbeReport } from "./template-setup-probe.mjs";
import { PERF_UUID, PERF_RESOURCE, perfCheck, perfPool, perfRead, readPerfEnvironment } from "./workspace-perf-timeline.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const STATUS = "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py status";
const name = journal => `zeros-v2-test-perf-${journal.id}`;
const providerReady = state => ["ready", "idle", "running"].includes(state);

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
  const ready = async (_journal, material) => {
    const deadline = now() + 600_000;
    while (now() < deadline) {
      try {
        const { sandbox } = await request(`/sandboxes/${journal.childId}`);
        perfCheck(sandbox?.id === journal.childId && sandbox.team?.id?.toLowerCase() === config.billingOrg.toLowerCase() &&
          (sandbox.sourceSandboxId === undefined || sandbox.sourceSandboxId === journal.templateId), "child_invalid");
        if (providerReady(sandbox.state)) {
          const timings = journal.perf[journal.perf.cycle];
          timings.providerReadyObservedMs ??= Math.round(now() - cycleStarted);
          const response = await request(`/sandboxes/${journal.childId}/commands`, { method: "POST", body: { command: STATUS, timeoutSeconds: 20 } });
          const parsed = RuntimeBaseStatusSchema.safeParse(JSON.parse(response.stdout));
          if (response.success === true && response.exitCode === 0 && !response.timedOut && !response.stdoutTruncated && parsed.success &&
            parsed.data.baseCompatibilityId === material.computer.template.baseCompatibilityId && ["idle", "waiting_for_runtime"].includes(parsed.data.hostState)) {
            timings.baseReadyObservedMs = Math.round(now() - cycleStarted); save(journal); return;
          }
        }
      } catch { /* Bounded readiness retry; raw provider data never leaves. */ }
      await wait(250);
    }
    throw new Error("bootstrap_timeout");
  };
  await runTemplateSetupRepro(journal, config.billingOrg, {
    request, save, ready, diagnose: () => {}, wait: () => wait(5_000), attempts: 120,
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
  const args = process.argv.slice(2), cleanup = args[0] === "--cleanup";
  perfCheck(cleanup ? args.length === 2 && PERF_UUID.test(args[1]) : args.length === 6 && args[0] === "--run" &&
    ["before", "after"].includes(args[1]) && args[2] === "--workspace" && PERF_UUID.test(args[3]) && args[4] === "--template" && PERF_RESOURCE.test(args[5]), "input_invalid");
  const env = readPerfEnvironment();
  const config = templateSetupReproConfig({ ...env, ZEROS_S1_ALPHA_DATABASE_URL: env.ZEROS_PERF_ALPHA_DATABASE_URL });
  const pool = perfPool(config), boat = new BoatApiClient({ apiKey: config.apiKey, billingOrg: config.billingOrg, timeoutMs: 30_000, diagnostics: () => {} });
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
    probe: (child, material) => runTemplateSetupProbe(child, material, { request, diagnose: () => {} }) };
  try {
    if (cleanup) await cleanupTemplateSetupFork(journal, { request, save, diagnose: () => {} });
    else await runPerfVm(journal, config, deps);
    process.stdout.write(JSON.stringify({ schema: "zeros.workspace-perf-vm/v1", runId: id, childId: journal.childId,
      metrics: cleanup ? undefined : journal.perf, cleanup: journal.cleanup, storagePending: journal.cleanupStorageStage,
      failedChecks: journal.failedChecks.filter(code => ["verification_failed", "probe_failed", "cleanup_pending"].includes(code)),
      isolatedProbe: true, controlPlaneSetupAndActorAdmission: "not_measured", readinessPollMs: 250 }) + "\n");
    process.exitCode = journal.cleanup === "pending" || !cleanup && journal.failedChecks.length ? 1 : 0;
  } finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { process.stderr.write('{"schema":"zeros.workspace-perf-error/v1","code":"vm_run_failed_retain_cleanup_journal"}\n'); process.exitCode = 1; });
