import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { perfDatabaseConfig, perfTimeline, elapsed, readPerfTimeline } from "../cloud-workspace-validation/workspace-perf-timeline.mjs";
import { cleanupPerfRun, newPerfJournal, ownPerfWorkspace, perfAlphaRequest, perfHandshake, runPerfLive, validatePerfJournal } from "../cloud-workspace-validation/workspace-perf-live.mjs";
import { inspectPerfVmSource, perfVmRequest, runPerfVm, parsePerfBootstrapDetails } from "../cloud-workspace-validation/workspace-perf-vm.mjs";
import { newTemplateSetupJournal } from "../cloud-workspace-validation/template-setup-repro.mjs";
import { CloudProviderError } from "../../apps/control-plane/src/cloud-workspaces/provider";

const account = "11111111-1111-4111-8111-111111111111", organizationId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333", deviceId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555", buildId = "66666666-6666-4666-8666-666666666666";
const token = `zwa_${"x".repeat(43)}`;
const config = { organizationId, testUserId: account, expectedSha: "a".repeat(40), repository: {} };
const admission = { version: 2, workspaceId, organizationId, generation: 1, grantToken: token,
  bridgeUrl: "wss://api-alpha.zeros.build/v1/cloud-workspaces/bridge" };

function fixture() {
  const journal = newPerfJournal(config, "before", runId);
  let created = false, revoked = false, deleted = false, status = "ready", time = 0;
  const row = () => ({ workspace_id: workspaceId, org_id: organizationId, owner_user_id: account, display_name: journal.name,
    template_sandbox_id: "bx_33333333", build_id: buildId, repository_revision: config.expectedSha,
    deleted_at: deleted ? "2026-01-01T00:00:00Z" : null, deletion_state: deleted ? "succeeded" : null,
    operations: [{ resource_id: "bx_22222222", deleted_at: deleted ? "2026-01-01T00:00:00Z" : null }] });
  const request = vi.fn(async (method: string, pathname: string) => {
    time += 5;
    if (pathname === "/v1/me") return { status: 200, body: { user: { id: account, staffRole: "developer" } } };
    if (pathname === "/v1/devices") return { status: 201, body: { device: { id: deviceId } } };
    if (pathname === `/v1/devices/${deviceId}`) { revoked = true; return { status: 200 }; }
    if (pathname.endsWith("/runtime/admission")) return method === "POST" ? { status: 201, body: admission } : { status: 204 };
    if (pathname.endsWith("/stop")) { status = "stopped"; return { status: 202 }; }
    if (pathname.endsWith("/wake")) { status = "ready"; return { status: 202 }; }
    if (method === "POST") { created = true; return { status: 202, body: { workspace: { id: workspaceId } } }; }
    if (method === "DELETE") { deleted = true; return { status: 202 }; }
    return { status: 200, body: { workspace: { id: workspaceId, status, generation: { number: 1 } } } };
  });
  const database = { active: vi.fn(async () => ({ build_id: buildId })), accepted: vi.fn(async () => created ? row() : null),
    device: vi.fn(async () => ({ id: deviceId, user_id: account, label: journal.name, revoked_at: revoked ? "now" : null })),
    timeline: vi.fn(async () => ({ schema: "zeros.workspace-perf-timeline/v1" })) };
  const deps = { request, database, save: vi.fn(), pause: vi.fn(async (ms: number) => { time += ms; }), now: () => time,
    handshake: vi.fn(async () => ({ upgradeMs: 7, connectedProbeMs: 9 })), nameResources: vi.fn(), cleanupAttempts: 3 };
  return { journal, deps, row };
}

afterEach(() => vi.useRealTimers());

describe("cloud performance measurement", () => {
  it("projects only closed timeline fields and never substitutes missing or negative times", () => {
    const rows = { workspace: { id: workspaceId, current_generation: 1, status: "ready", secret: "private" },
      intents: [{ id: runId, operation: "wake", state: "queued", created_at: "2026-01-01T00:00:00Z", dispatched_at: "2026-01-01T00:00:02Z", secret: "private" }],
      setups: [], engines: [], actors: [], providerCreates: [] };
    const result = perfTimeline(rows);
    expect(result.intents[0].queueToFirstDispatchMs).toBe(2_000);
    expect(result.intents[0].dispatchToCompletionMs).toBeNull();
    expect(result.intents[0].generation).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private");
    expect(elapsed(null, "2026-01-01")).toBeNull();
    expect(elapsed("2026-01-02", "2026-01-01")).toBeNull();
    expect(result.unmeasured).toContain("boat_api_duration");
    expect(result.setupStageTimings.availability).toBe("not_persisted");
  });

  it("rolls back read-only SQL even on failure and never selects secret-bearing documents", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT id,current_generation,status")) return { rows: [{ id: workspaceId }] };
      if (sql.includes("FROM cloud_workspace_setup_runs")) throw new Error("private SQL details");
      return { rows: [] };
    });
    const release = vi.fn();
    await expect(readPerfTimeline({ connect: async () => ({ query, release }) }, workspaceId)).rejects.toThrow();
    expect(query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => /SELECT \*|token_hash|log_excerpt|private_key/.test(sql))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports persisted failure observations without inventing successful stage spans", () => {
    const result = perfTimeline({ workspace: { id: workspaceId }, intents: [], setups: [], engines: [], actors: [], providerCreates: [],
      setupDiagnostics: [{ id: runId, setup_run_id: buildId, phase: "image_preflight", setup_phase: "image_preflight",
        installer_stage: "check_cache", elapsed_ms: "75", first_at: "2026-01-01T00:00:00Z", last_at: "2026-01-01T00:00:01Z", secret: "private" },
      { phase: "private_phase", installer_stage: "private_stage" }] });
    expect(result.setupStageTimings.availability).toBe("not_persisted");
    expect(result.setupStageTimings.failureEvents[0]).toMatchObject({ phase: "image_preflight", installerStage: "check_cache", reportedElapsedMs: 75 });
    expect(result.setupStageTimings.failureEvents[1]).toMatchObject({ phase: "other", installerStage: null, reportedElapsedMs: null });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects non-Alpha database configuration and foreign API destinations before I/O", async () => {
    const target = new URL("postgres://host.psdb.cloud/db?sslmode=verify-full");
    target.username = "reader.test";
    const databaseUrl = target.toString();
    expect(() => perfDatabaseConfig({ ZEROS_PLANETSCALE_ALPHA_DATABASE: "production", ZEROS_PERF_ALPHA_DATABASE_URL: databaseUrl })).toThrow("input_invalid");
    expect(perfDatabaseConfig({ ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-alpha", ZEROS_PERF_ALPHA_DATABASE_URL: databaseUrl })).toHaveProperty("databaseUrl");
    const fetcher = vi.fn();
    const request = perfAlphaRequest({ ...config, accessToken: "private" }, fetcher);
    await expect(request("GET", "https://untrusted.test")).rejects.toThrow("request_invalid");
    await expect(request("DELETE", `/v1/organizations/${organizationId}/cloud-workspaces/../cloud-computers`)).rejects.toThrow("request_invalid");
    await expect(request("POST", `/v1/organizations/${organizationId}/cloud-workspaces/${workspaceId}/archive`)).rejects.toThrow("request_invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("measures create and wake through a real actor-shaped handshake and cleans up only the recorded test resources", async () => {
    const { journal, deps } = fixture();
    await runPerfLive(config, journal, deps);
    expect(journal.failedChecks).toEqual([]);
    expect(journal.cleanup).toBe("verified"); expect(journal.deviceCleanup).toBe("revoked");
    expect(deps.handshake).toHaveBeenCalledTimes(2);
    expect(journal.samples.find(sample => sample.phase === "create_to_connected_with_operator_checks")?.ok).toBe(true);
    expect(journal.samples.find(sample => sample.phase === "wake_to_connected")?.ok).toBe(true);
    expect(journal.samples.find(sample => sample.phase === "wake_connectedProbeMs")?.durationMs).toBe(9);
    expect(JSON.stringify(journal)).not.toContain(token);
    expect(deps.request.mock.calls.filter(([method, pathname]) => method === "DELETE").every(([, pathname]) => pathname.includes(workspaceId) || pathname.includes(deviceId))).toBe(true);
  });

  it("rejects the wrong signed-in principal before creating anything", async () => {
    const { journal, deps } = fixture();
    deps.request.mockResolvedValueOnce({ status: 200, body: { user: { id: workspaceId, staffRole: "developer" } } });
    await runPerfLive(config, journal, deps);
    expect(deps.request).toHaveBeenCalledOnce();
    expect(journal.createAttempted).toBe(false); expect(journal.deviceAttempted).toBe(false);
    expect(journal.cleanup).toBe("not_created"); expect(journal.failedChecks).toEqual(["measurement_failed"]);
  });

  it("recovers cleanup after an ambiguous create without dispatching another allocation", async () => {
    const { journal, deps } = fixture();
    const request = deps.request.getMockImplementation()!;
    deps.request.mockImplementation(async (method, pathname) => {
      const result = await request(method, pathname);
      if (method === "POST" && pathname.endsWith("/cloud-workspaces")) throw new Error("private response");
      return result;
    });
    await runPerfLive(config, journal, deps);
    expect(journal.cleanup).toBe("verified"); expect(journal.deviceCleanup).toBe("revoked");
    expect(deps.request.mock.calls.filter(([method, pathname]) => method === "POST" && pathname.endsWith("/cloud-workspaces"))).toHaveLength(1);
    expect(JSON.stringify(journal)).not.toContain("private response");
  });

  it("will not delete a foreign workspace or certify ambiguous absent creates", async () => {
    const { journal, deps, row } = fixture();
    journal.createAttempted = true;
    deps.database.accepted.mockResolvedValue({ ...row(), owner_user_id: deviceId });
    await expect(cleanupPerfRun(journal, deps)).rejects.toThrow("cleanup_pending");
    expect(deps.request).not.toHaveBeenCalled();
    deps.database.accepted.mockResolvedValue(null);
    await expect(cleanupPerfRun(journal, deps)).rejects.toThrow("cleanup_pending");
    expect(journal.cleanup).toBe("pending");
    expect(() => ownPerfWorkspace(journal, { ...row(), operations: [{ resource_id: row().template_sandbox_id }] })).toThrow("ownership_mismatch");
    expect(() => validatePerfJournal({ ...journal, organizationId: account }, config, runId)).toThrow("journal_invalid");
    expect(() => validatePerfJournal({ ...journal, cleanup: "untrusted text" }, config, runId)).toThrow("journal_invalid");
  });

  it("sends CONNECTED first and measures usability only after a correlated workspace response", async () => {
    const socket = Object.assign(new EventEmitter(), { send: vi.fn(), terminate: vi.fn() });
    class Socket { constructor() { return socket; } }
    const pending = perfHandshake(admission, Socket);
    const finished = vi.fn(); void pending.then(finished);
    socket.emit("open");
    const frames = socket.send.mock.calls.map(([frame]) => JSON.parse(frame));
    expect(frames.map(frame => frame.type)).toEqual(["CONNECTED", "WORKSPACE_REQUEST"]);
    expect(frames[0]).not.toHaveProperty("authToken");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "ENGINE_READY" })));
    await Promise.resolve(); expect(finished).not.toHaveBeenCalled();
    socket.emit("message", Buffer.from(JSON.stringify({ type: "WORKSPACE_RESPONSE", requestId: frames[1].id, result: [] })));
    expect(await pending).toHaveProperty("connectedProbeMs");
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("profiles fork and resume only on its named disposable VM, then verifies cleanup", async () => {
    const source = "bx_33333333", child = "bx_22222222", billingOrg = `team_${organizationId}`;
    const baseCompatibilityId = `bc1-${"a".repeat(64)}`, deletionId = `bdop_${"b".repeat(32)}`;
    const journal = { ...newTemplateSetupJournal(workspaceId, 1, source, runId),
      perf: { label: "before", cycle: "create", api: {}, create: {}, wake: {} } };
    let deleted = false, stopped = false, name = "", time = 0, statusProbes = 0;
    const raw = vi.fn(async (pathname: string, input: any = {}) => {
      time += 5;
      if (pathname === `/sandboxes/${source}/fork`) return { sandboxId: child, sourceSandboxId: source };
      if (input.method === "PATCH") { name = input.body.name; return {}; }
      if (pathname.endsWith("/stop")) { stopped = true; return {}; }
      if (pathname.endsWith("/resume")) { stopped = false; return {}; }
      if (input.method === "DELETE") { deleted = true; return { operation: { id: deletionId, targetId: child } }; }
      if (pathname.startsWith("/deletion-operations/")) return { operation: { id: deletionId, targetId: child, kind: "sandbox", status: "completed", completedAt: "2026-01-01T00:00:00Z" } };
      if (pathname.endsWith("/commands") && statusProbes++ === 0) return { success: false, exitCode: 1,
        stderr: "private provider output", stdout: JSON.stringify({ schema: "zeros.diagnostic/v1", component: "bootstrap",
          stage: "validate_input", ok: false, exitCode: 1, timedOut: false, failedChecks: ["base_compatibility", "private_text"] }) };
      if (pathname.endsWith("/commands") && statusProbes === 2) return { success: true, exitCode: 0, stdout: JSON.stringify({ schema: "zeros.base-status/v1",
        baseCompatibilityId, bootId: runId, currentRuntimeId: `r1-${"b".repeat(64)}`, hostState: "failed" }) };
      if (pathname.endsWith("/commands")) return { success: true, exitCode: 0, stdout: JSON.stringify({ schema: "zeros.base-status/v1",
        baseCompatibilityId, bootId: runId, currentRuntimeId: `r1-${"b".repeat(64)}`, hostState: "idle" }) };
      if (deleted && pathname.endsWith(child)) throw new CloudProviderError("provider_not_found", "private error", false);
      return { sandbox: { id: pathname.split("/").at(-1), name, team: { id: billingOrg }, state: pathname.endsWith(source) || stopped ? "archived" : "running",
        snapshotAvailable: true, lastSnapshotStatus: "completed", sourceSandboxId: pathname.endsWith(child) ? source : undefined } };
    });
    const request = perfVmRequest(journal, billingOrg, raw, () => time);
    const probe = vi.fn(async () => ({ schema: "zeros.template-setup-probe/v1", paths: [], checks: [{ check: "image", ok: true,
      attester: { stages: [{ stage: "verify_tree", outcome: "passed", durationMs: 13, failedChecks: [] }] } }] }));
    await runPerfVm(journal, { billingOrg }, { request, probe, save: vi.fn(), now: () => time, wait: async (ms: number) => { time += ms; },
      load: async () => ({ templateId: source, billingOrg, baseImageId: "zeros-v2-test-base", computer: { template: { baseCompatibilityId } },
        image: { resources: { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 } } }) });
    expect(journal.failedChecks).toEqual([]); expect(journal.cleanup).toBe("verified");
    expect(probe).toHaveBeenCalledTimes(2);
    expect(journal.perf.create.stages.attester[0].durationMs).toBe(13);
    expect(journal.perf.wake.stages.attester[0].durationMs).toBe(13);
    expect(journal.perf.create.bootstrapObservations).toEqual({ command_nonzero: 1, host_failed: 1, ready: 1 });
    expect(journal.perf.create.lastBootstrapDiagnostic).toEqual({ stage: "validate_input", failedChecks: ["base_compatibility"] });
    expect(journal.perf.create.bootstrapPollMaxMs).toBe(500);
    expect(JSON.stringify(journal)).not.toContain("private");
    expect(name).toBe(`zeros-v2-test-perf-${runId}`);
    expect(raw.mock.calls.filter(([, input]) => input?.method === "DELETE").map(([pathname]) => pathname)).toEqual([`/sandboxes/${child}`]);
    expect(raw.mock.calls.find(([pathname]) => pathname.endsWith("/fork"))?.[1].idempotencyKey).toBe(name);
    // A naming failure must not strand the receipt-bound disposable child.
    deleted = false; name = "";
    await expect(request(`/sandboxes/${child}`, { method: "DELETE" })).resolves.toHaveProperty("operation");
    await expect(request(`/sandboxes/${source}`, { method: "DELETE" })).rejects.toThrow("request_scope_invalid");
    await expect(request("/sandboxes/bx_44444444/resume", { method: "POST" })).rejects.toThrow("request_scope_invalid");
  });

  it("projects only closed bootstrap unit and hydration observations", () => {
    const result = parsePerfBootstrapDetails({ schema: "zeros.workspace-perf-bootstrap/v1", observedMonotonicUs: 50_000_000,
      hydrationDone: true, activeDescriptorPresent: false,
      units: [{ unit: "zeros-boot.service", active: "active", sub: "exited", result: "success", exitCode: 0,
        ExecMainStartTimestampMonotonic: 1_000_000, ExecMainExitTimestampMonotonic: 38_000_000, ActiveEnterTimestampMonotonic: 38_001_000,
        text: "private" }], hydrationEvents: [{ event: "persistence_hydration_ready", waitedSeconds: 35, observedMonotonicUs: 36_000_000, text: "private" }] });
    expect(result.units[0].ExecMainExitTimestampMonotonic - result.units[0].ExecMainStartTimestampMonotonic).toBe(37_000_000);
    expect(result.hydrationEvents[0].waitedSeconds).toBe(35);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(parsePerfBootstrapDetails({ ...result, units: [{ unit: "private", active: "private" }],
      hydrationEvents: [{ event: "private", waitedSeconds: 2 }] }).units).toEqual([]);
  });
  it("filters journal messages on the VM before bootstrap diagnostics leave it", () => {
    const output = execFileSync("python3", ["-I", "-B", "-c", `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('perf','scripts/cloud-workspace-validation/workspace-perf-bootstrap.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps(module.project_events(sys.stdin.read())))
`], { encoding: "utf8", input: [
      { MESSAGE: "private output", __MONOTONIC_TIMESTAMP: "200" },
      { MESSAGE: JSON.stringify({ event: "persistence_hydration_ready", waitedSeconds: 38, ignored: "private" }), __MONOTONIC_TIMESTAMP: "40000000" },
      { MESSAGE: JSON.stringify({ event: "private", waitedSeconds: 12 }), __MONOTONIC_TIMESTAMP: "300" },
    ].map(value => JSON.stringify(value)).join("\n") });
    expect(JSON.parse(output)).toEqual([{ event: "persistence_hydration_ready", waitedSeconds: 38, observedMonotonicUs: 40000000 }]);
  });

  it("retains closed source-failure diagnostics before allocation without exposing error text", async () => {
    const journal = { ...newTemplateSetupJournal(workspaceId, 1, "bx_33333333", runId),
      perf: { label: "before", cycle: "create", api: {}, create: {}, wake: {} } };
    const request = vi.fn();
    await runPerfVm(journal, { billingOrg: `team_${organizationId}` }, { request, save: vi.fn(), probe: vi.fn(),
      load: async () => { throw Object.assign(new Error("private database details"), { code: "42P01" }); } });
    expect(request).not.toHaveBeenCalled();
    expect(journal.childId).toBeNull(); expect(journal.cleanup).toBe("not_created");
    expect(journal.perf.diagnostics).toEqual([{ schema: "zeros.template-setup-error/v1", phase: "source", name: "Error", sqlstate: "42P01" }]);
    expect(JSON.stringify(journal)).not.toContain("private database details");
  });

  it("inspects source pin mismatch read-only while allowing a stopped source workspace", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT workspace.id") ? [{
      id: workspaceId, current_generation: 1, status: "stopped", pinned_template_id: "bx_33333333", build_id: buildId,
      source_present: true, build_succeeded: true, template_ready: true, template_stopped: true, protected_digest: true,
      source_matches_build: true, image_matches_template: true, repository_present: true, base_present: true,
      base_test_named: true, same_runtime: true, secret: "private" }] : [] }));
    const release = vi.fn();
    const request = vi.fn(async () => ({ sandbox: { id: "bx_22222222", state: "archived", snapshotAvailable: true,
      lastSnapshotStatus: "completed", team: { id: `team_${organizationId}` } } }));
    const result = await inspectPerfVmSource({ connect: async () => ({ query, release }) }, workspaceId, "bx_22222222",
      `team_${organizationId}`, request);
    expect(result.workspaceStatus).toBe("stopped");
    expect(result.pinnedTemplateId).toBe("bx_33333333");
    expect(result.checks.requestedTemplateMatchesPin).toBe(false);
    expect(result.eligible).toBe(false);
    expect(query.mock.calls[0][0]).toContain("READ ONLY");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
    const valid = await inspectPerfVmSource({ connect: async () => ({ query, release }) }, workspaceId, "bx_33333333",
      `team_${organizationId}`, async () => ({ sandbox: { id: "bx_33333333", state: "archived", snapshotAvailable: true,
        lastSnapshotStatus: "completed", team: { id: `team_${organizationId}` } } }), async () => ({}));
    expect(valid.eligible).toBe(true);
    expect(valid.workspaceStatus).toBe("stopped");
  });
});
