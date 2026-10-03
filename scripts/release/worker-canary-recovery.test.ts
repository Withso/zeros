import { describe, expect, it, vi } from "vitest";
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
