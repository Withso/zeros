import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { nativeAgentCanary } from "../dev-environment/native-agent-canary.mjs";
import { reconcileReleaseCanaryRetirements } from "./worker-canary-recovery";
import { releaseCanaryAdapter } from "./worker-canary";
import { workerOwner } from "./worker-admission";
import { workerExecutionConfig } from "./worker-config";
import { workerConnections, workerEnvironment } from "./worker-test-fixtures";

function fixture(current = false) {
  const { config } = workerExecutionConfig({ ...workerEnvironment(), GITHUB_RUN_ID: current ? "123" : "124" });
  const operationId = "11111111-1111-4111-8111-111111111111", deletionOperationId = `bdop_${"c".repeat(32)}`, now = Date.now();
  const job: any = { id: operationId, ...workerConnections()[0], qualificationProfile: "smoke", phase: "starting", startedAt: now, image: {
    snapshotId: "worker-test", sourceCommit: config.sourceSha, buildSha256: "b".repeat(64) } };
  const row: any = { purpose: "native-agent-qualification", agentQualificationId: operationId, sourceCommit: config.sourceSha,
    sourceImage: job.image.snapshotId, nativeDispatchStarted: true, builder: { id: "bx_test", deleteRequested: true, deleted: true, deletionOperationId,
      physicalCleanup: { version: 1, operationId, targetId: "bx_test", snapshotId: job.image.snapshotId, sourceCommit: config.sourceSha,
        buildSha256: job.image.buildSha256, creationIntentSha256: "d".repeat(64), accountBinding: "e".repeat(64), billingOrg: "test-wallet",
        operation: { id: deletionOperationId, kind: "sandbox", targetId: "bx_test", status: "completed",
          requestedAt: new Date(now - 20_000).toISOString(), completedAt: new Date(now - 10_000).toISOString() },
        operationObservedAt: new Date(now - 9000).toISOString(), unavailableObservedAt: new Date(now - 8000).toISOString() } } };
  const state: any = { owner: workerOwner(config.channel), lease: { token: "77777777-7777-4777-8777-777777777777", expiresAt: now + 60_000 },
    resources: { images: [row] }, releaseRuns: [{ runId: "123", sourceSha: config.sourceSha, actorUserId: workerEnvironment().RUNTIME_QUALIFICATION_ACTOR_USER_ID,
      qualificationProfile: "smoke", releaseCanaryBindings: workerConnections(), canaries: [job] }] };
  const lease = { state, signal: new AbortController().signal, fence: vi.fn(async () => {}), save: vi.fn(async () => {}) };
  const core = { retire: vi.fn(async () => {}), allocate: vi.fn(), start: vi.fn(), poll: vi.fn() }, reconcile = vi.fn(async () => {});
  return { config, job, row, state, lease, core, reconcile, actor: state.releaseRuns[0].actorUserId as string };
}

function deferredHistory(count = 4) {
  const test = fixture(), now = Date.now(), at = (age: number) => new Date(now - age).toISOString();
  const profile = { boat: { accountScope: "synthetic-account", billingOrg: "test-wallet" }, railway: { projectId: "synthetic-project" },
    planetscale: { organization: "synthetic-org", database: "synthetic-db" }, cloudflare: { accountId: "synthetic-account" } };
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const accountBinding = hash([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId,
    profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId]);
  const rows: any[] = [], jobs: any[] = [];
  test.state.releaseRuns = [];
  for (let index = 0; index < count; index++) {
    const job = structuredClone(test.job), row = structuredClone(test.row);
    job.id = `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
    row.agentQualificationId = job.id; row.builder.id = `bx_test${index}`;
    row.builder.deletionOperationId = `bdop_${index.toString(16).padStart(32, "0")}`;
    row.builderIntent = { key: job.id, at: now - 40_000, body: { from: job.image.snapshotId, noEnv: true, env: {}, snapshots: false } };
    row.snapshotPolicyVersion = 1;
    row.snapshotPolicyObserved = { version: 1, targetId: row.builder.id, snapshots: false, observedAt: at(30_000) };
    row.builder.storageRetirement = { ...row.builder.physicalCleanup, kind: "storage-pending", operationId: job.id, targetId: row.builder.id,
      accountBinding, creationIntentSha256: hash(row.builderIntent), snapshotsOff: row.snapshotPolicyObserved,
      operation: { id: row.builder.deletionOperationId, kind: "sandbox", targetId: row.builder.id, status: "blocked",
        stage: "waiting_for_restore", requestedAt: at(20_000), expectedBy: null } };
    delete row.builder.physicalCleanup;
    row.retired = true; row.deleted = false; row.builder.deleted = false; row.builder.retiredAt = at(8000);
    job.retired = true; job.auditRetired = { version: 2, operationId: job.id, deletionOperationId: row.builder.deletionOperationId, storagePending: true };
    rows.push(row); jobs.push(job);
    test.state.releaseRuns.push({ runId: String(110 + index), sourceSha: test.config.sourceSha, actorUserId: test.actor,
      qualificationProfile: "smoke", releaseCanaryBindings: workerConnections(), canaries: [job] });
  }
  test.state.resources.images = rows;
  const request = vi.fn(async (method: string, route: string) => {
    expect(method).toBe("GET");
    const row = rows.find(value => route === `/deletion-operations/${value.builder.deletionOperationId}`);
    if (row) return { status: 200, body: { operation: { ...row.builder.storageRetirement.operation, status: "processing", stage: "removing", expectedBy: null } } };
    if (rows.some(value => route === `/sandboxes/${value.builder.id}`)) return { status: 404, body: null };
    throw new Error("Unexpected synthetic history request");
  });
  const native = nativeAgentCanary(test.lease, profile, request, undefined,
    { strictCleanup: true, releaseStorageDeferral: true, cleanupTimeoutMs: 0 });
  const core = { ...native, retire: vi.fn(native.retire.bind(native)), allocate: vi.fn(), start: vi.fn() };
  const reconcile = vi.fn(async () => "storage-pending" as const);
  return { ...test, rows, jobs, core, request, reconcile, now };
}

describe("bounded acknowledged storage history", () => {
  it("observes one audited record per pass and rotates without dropping evidence or replaying DELETE", async () => {
    const test = deferredHistory(), originals = structuredClone(test.rows.map(row => row.builder.storageRetirement));
    let clock = test.now;
    const options = { maxRecords: 1, now: () => clock };
    for (let index = 0; index < test.jobs.length; index++) {
      await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile, options)).resolves.toBe(1);
      expect(test.core.retire.mock.calls[index][0]).toBe(test.jobs[index]);
      expect(test.rows[index].builder.lastReconcileAt).toBe(new Date(clock).toISOString());
      clock++;
    }
    expect(test.rows.map(row => row.builder.storageRetirement)).toEqual(originals);
    expect(test.rows.every(row => row.builder.deleted === false && row.deleted === false)).toBe(true);
    expect(test.jobs.every(job => job.auditRetired.version === 2 && job.retired)).toBe(true);
    expect(test.core.allocate).not.toHaveBeenCalled(); expect(test.core.start).not.toHaveBeenCalled();
    expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("leaves already-audited records queued when the remaining observation budget is exhausted", async () => {
    const test = deferredHistory(); let clock = test.now;
    test.reconcile.mockImplementation(async () => { clock += 14_950; return "storage-pending"; });
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile,
      { now: () => clock })).resolves.toBe(1);
    expect(test.core.retire).toHaveBeenCalledOnce();
    expect(test.rows.slice(1).every(row => row.builder.lastReconcileAt === undefined)).toBe(true);
  });
  it("settles unacknowledged cleanup before optional storage observations", async () => {
    const test = deferredHistory(); delete test.jobs[3].auditRetired; delete test.jobs[3].retired;
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile,
      { maxRecords: 1 })).resolves.toBe(1);
    expect(test.core.retire).toHaveBeenCalledExactlyOnceWith(test.jobs[3], expect.any(Function));
    expect(test.jobs[3].auditRetired.version).toBe(2);
  });
  it("still blocks when mandatory recovery exceeds the pass budget", async () => {
    const test = deferredHistory();
    for (const job of test.jobs.slice(2)) { delete job.auditRetired; delete job.retired; }
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile,
      { maxRecords: 1 })).rejects.toThrow("recovery budget exhausted");
    expect(test.core.retire.mock.calls.map(([job]) => job.id)).toEqual([test.jobs[2].id]);
    expect(test.jobs[3].auditRetired).toBeUndefined();
  });
  it.each(["retired row", "retired time", "deleted row"])("prioritizes an interrupted %s after audit acknowledgment", async boundary => {
    const test = deferredHistory(), row = test.rows[3];
    if (boundary === "retired row") delete row.retired;
    if (boundary === "retired time") delete row.builder.retiredAt;
    if (boundary === "deleted row") row.deleted = true;
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile,
      { maxRecords: 1 })).resolves.toBe(1);
    expect(test.core.retire.mock.calls.map(([job]) => job.id)).toEqual([test.jobs[3].id]);
  });
  it.each(["account", "creation", "snapshot policy", "ownership", "marker", "cursor"])("validates unvisited %s evidence before any request", async field => {
    const test = deferredHistory(), row = test.rows[3];
    if (field === "account") row.builder.storageRetirement.accountBinding = "f".repeat(64);
    if (field === "creation") row.builderIntent.at--;
    if (field === "snapshot policy") row.snapshotPolicyObserved.snapshots = true;
    if (field === "ownership") row.sourceCommit = "f".repeat(40);
    if (field === "marker") test.jobs[3].auditRetired.deletionOperationId = `bdop_${"f".repeat(32)}`;
    if (field === "cursor") row.builder.lastReconcileAt = "invalid";
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile,
      { maxRecords: 1 })).rejects.toThrow();
    expect(test.request).not.toHaveBeenCalled(); expect(test.reconcile).not.toHaveBeenCalled();
  });
  it.each(["lease cancellation", "provider uncertainty", "deadline", "save failure"])("keeps a selected %s blocking", async failure => {
    const test = deferredHistory(); let clock = test.now;
    if (failure === "lease cancellation") test.lease.signal = AbortSignal.abort();
    if (failure === "provider uncertainty") test.request.mockRejectedValueOnce(new Error("Synthetic provider uncertainty"));
    if (failure === "deadline") test.reconcile.mockImplementation(async () => { clock += 15_001; return "storage-pending"; });
    if (failure === "save failure") test.lease.save.mockRejectedValueOnce(new Error("Synthetic save failure"));
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile,
      { maxRecords: 1, now: () => clock })).rejects.toThrow();
    expect(test.rows.every(row => row.builder.lastReconcileAt === undefined && !row.builder.deleted)).toBe(true);
    expect(test.jobs.every(job => job.retired && job.auditRetired.version === 2)).toBe(true);
    expect(test.core.allocate).not.toHaveBeenCalled(); expect(test.core.start).not.toHaveBeenCalled();
  });
});

describe("bounded historical native recovery crash windows", () => {
  it("durably completes both local terminal fields when a save acknowledgment is lost after server settlement", async () => {
    const test = fixture(); let durable: any, saves = 0;
    test.lease.save.mockImplementation(async () => {
      durable = structuredClone(test.state);
      if (++saves === 2) throw new Error("Synthetic lost journal save acknowledgment");
    });
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile)).rejects.toThrow("lost journal");
    expect(test.reconcile).toHaveBeenCalledOnce();
    const saved = durable.releaseRuns[0].canaries[0];
    expect(saved.auditRetired).toEqual({ version: 1, operationId: test.job.id, deletionOperationId: test.row.builder.deletionOperationId });
    expect(saved.retired).toBe(true);
    durable.lease.token = "88888888-8888-4888-8888-888888888888";
    const recovered = { state: durable, signal: new AbortController().signal, fence: vi.fn(async () => {}), save: vi.fn(async () => {}) };
    expect(await reconcileReleaseCanaryRetirements(test.config, test.actor, recovered, test.core, test.reconcile)).toBe(0);
    expect(test.core.retire).toHaveBeenCalledOnce(); expect(test.reconcile).toHaveBeenCalledOnce();
    expect(test.core.allocate).not.toHaveBeenCalled(); expect(test.core.start).not.toHaveBeenCalled(); expect(test.core.poll).not.toHaveBeenCalled();
  });
  it("preserves the production save-job-before-allocation ordering for an exact current-run empty allocating job", async () => {
    const test = fixture(true); test.job.phase = "allocating"; test.state.resources.images = [];
    expect(await reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile)).toBe(0);
    expect(test.job).not.toHaveProperty("retired"); expect(test.lease.save).not.toHaveBeenCalled();
    expect(test.core.retire).not.toHaveBeenCalled(); expect(test.reconcile).not.toHaveBeenCalled();
    expect(test.core.allocate).not.toHaveBeenCalled(); expect(test.core.start).not.toHaveBeenCalled();
  });
  it("resumes the adapter's durably saved empty allocation using its original operation ID after an interrupted save", async () => {
    const test = fixture(true), run = test.state.releaseRuns[0], image = { ...test.job.image, architecture: "linux/amd64" as const, storageMiB: 4096 };
    run.canaries = []; test.state.resources.images = [];
    const credentials = new Map(workerConnections().map(connection => [connection.kind, connection]));
    const core = { ...test.core, ready: vi.fn() }; let durable: any;
    test.lease.save.mockImplementationOnce(async () => { durable = structuredClone(test.state); throw new Error("Synthetic interrupted allocation save"); });
    await expect(releaseCanaryAdapter(test.lease, run, credentials, core, { qualificationProfile: "smoke" }).qualify(image, "claude-setup-token"))
      .rejects.toThrow("interrupted allocation save");
    expect(core.allocate).not.toHaveBeenCalled(); expect(durable.releaseRuns[0].canaries).toHaveLength(1);
    const recovered = { state: durable, signal: new AbortController().signal, fence: vi.fn(async () => {}), save: vi.fn(async () => {}) };
    expect(await reconcileReleaseCanaryRetirements(test.config, test.actor, recovered, core, test.reconcile)).toBe(0);
    core.allocate.mockRejectedValueOnce(new Error("Synthetic resumed allocation boundary"));
    await expect(releaseCanaryAdapter(recovered, durable.releaseRuns[0], credentials, core, { qualificationProfile: "smoke" }).qualify(image, "claude-setup-token"))
      .rejects.toThrow("resumed allocation boundary");
    expect(core.allocate).toHaveBeenCalledExactlyOnceWith(durable.releaseRuns[0].canaries[0], image);
    expect(durable.releaseRuns[0].canaries).toHaveLength(1); expect(test.reconcile).not.toHaveBeenCalled();
    expect(core.start).not.toHaveBeenCalled(); expect(core.poll).not.toHaveBeenCalled(); expect(core.retire).not.toHaveBeenCalled();
  });
  it.each(["starting", "running", "completed"])("does not forgive missing allocation rows for %s jobs", async phase => {
    const test = fixture(true); test.job.phase = phase; test.state.resources.images = [];
    await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile)).rejects.toThrow("journal");
    expect(test.core.retire).not.toHaveBeenCalled(); expect(test.reconcile).not.toHaveBeenCalled();
  });
  it("preserves an active same-source current job for observation-only replay", async () => {
    const test = fixture(true); delete test.row.builder.deleteRequested; delete test.row.builder.deletionOperationId; delete test.row.builder.physicalCleanup;
    test.row.builder.deleted = false;
    expect(await reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile)).toBe(0);
    expect(test.core.retire).not.toHaveBeenCalled(); expect(test.reconcile).not.toHaveBeenCalled(); expect(test.core.start).not.toHaveBeenCalled();
  });
  it("does not skip mismatched-source or previously dispatched empty allocations", async () => {
    for (const change of [(test: any) => { test.state.releaseRuns[0].sourceSha = "f".repeat(40); },
      (test: any) => { test.job.admissionRequest = { recorded: true }; }, (test: any) => { test.job.prelaunchFailure = { version: 1 }; },
      (test: any) => { test.job.retired = false; }, (test: any) => { test.job.outcome = { success: true }; },
      (test: any) => { test.state.releaseRuns[0].actorUserId = "88888888-8888-4888-8888-888888888888"; },
      (test: any) => { test.job.credentialRevision = 2; }, (test: any) => { test.job.image.sourceCommit = "f".repeat(40); },
      (test: any) => { test.job.qualificationProfile = "full"; }, (test: any) => { test.job.id = "not-a-uuid"; },
      (test: any) => { test.state.releaseRuns[0].runId = "not-a-run"; }, (test: any) => { test.job.image.snapshotId = "../wrong-image"; },
      (test: any) => { test.job.image.buildSha256 = "not-a-digest"; }, (test: any) => { test.job.auditRetired = { version: 1 }; }]) {
      const test = fixture(true); test.job.phase = "allocating"; test.state.resources.images = []; change(test);
      await expect(reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.core, test.reconcile)).rejects.toThrow("journal");
      expect(test.reconcile).not.toHaveBeenCalled(); expect(test.core.allocate).not.toHaveBeenCalled();
    }
  });
});
