import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeAgentCanary } from "../dev-environment/native-agent-canary.mjs";
import { releaseHostedAdmission, reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { releaseCanaryAdapter } from "./worker-canary";
import { reconcileReleaseCanaryRetirements, retireReleaseCanary } from "./worker-canary-recovery";
import { workerExecutionConfig } from "./worker-config";
import { workerOwner } from "./worker-admission";
import { workerConnections, workerEnvironment } from "./worker-test-fixtures";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected external fetch"); }));
  const { config } = workerExecutionConfig(workerEnvironment()), actor = workerEnvironment().RUNTIME_QUALIFICATION_ACTOR_USER_ID!;
  const profile = { boat: { accountScope: "test-account", billingOrg: "test-wallet", baseSnapshot: "test-base", builderBudgetHours: 0.25 },
    railway: { projectId: "test-project" }, planetscale: { organization: "test-org", database: "test-db" }, cloudflare: { accountId: "test-account" } };
  const bindings = workerConnections(), image = { snapshotId: "worker-test", sourceCommit: config.sourceSha, buildSha256: "b".repeat(64),
    architecture: "linux/amd64" as const, storageMiB: 4096 };
  const run: any = { runId: config.runId, sourceSha: config.sourceSha, actorUserId: actor, qualificationProfile: "smoke", releaseCanaryBindings: bindings, canaries: [] };
  const state: any = { version: 2, owner: workerOwner(config.channel), generation: randomUUID(), identity: hash(["release-worker", config.repository, config.channel]),
    createdAt: new Date().toISOString(), status: "provisioning", lease: { token: randomUUID(), expiresAt: Date.now() + 60_000 },
    resources: { images: [] }, releaseRuns: [run] };
  let ledger: any = { etag: "1", state: { version: 1, owner: "account-admission", reservations: [],
    account: hash([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId, profile.planetscale.organization,
      profile.planetscale.database, profile.cloudflare.accountId]) } }, revision = 1;
  const store = { list: async () => ({ records: [], quarantine: [] }), readAdmission: async () => structuredClone(ledger),
    writeAdmission: vi.fn(async (value: any, etag: string) => {
      expect(etag).toBe(ledger.etag); ledger = { state: structuredClone(value), etag: String(++revision) }; return ledger.etag;
    }) };
  const saves: any[] = [], lease = { state, signal: new AbortController().signal, fence: vi.fn(async () => {}),
    save: vi.fn(async () => { saves.push(structuredClone(state)); }) };
  const provider = { complete: false, available: true, loseDeleteResponse: false, rejectCreate: false, operation: undefined as any };
  const request = vi.fn(async (method: string, route: string, input?: any): Promise<any> => {
    if (method === "GET" && route.startsWith("/limits?")) return { status: 200, body: { creditUsedSeconds: 0 } };
    if (method === "POST" && route === "/sandboxes") {
      expect(input.body).toMatchObject({ from: image.snapshotId, noEnv: true, env: {}, snapshots: false });
      if (provider.rejectCreate) return { status: 403 };
      return { status: 201, body: { sandbox: { id: "bx_predispatch" } } };
    }
    if (method === "GET" && route === "/sandboxes/bx_predispatch") return provider.available
      ? { status: 200, body: { sandbox: { id: "bx_predispatch", team: { id: profile.boat.billingOrg }, state: "running", snapshots: false } } }
      : { status: 404 };
    if (method === "POST" && route === "/sandboxes/bx_predispatch/commands")
      return { status: 200, body: { exitCode: 0, stdout: JSON.stringify({ qualified: false }) } };
    if (method === "DELETE" && route === "/sandboxes/bx_predispatch") {
      provider.available = false;
      provider.operation = { id: `bdop_${"c".repeat(32)}`, kind: "sandbox", targetId: "bx_predispatch", status: "blocked", stage: "waiting_for_uploads",
        requestedAt: new Date().toISOString(), completedAt: null, expectedBy: new Date(Date.now() + 3_600_000).toISOString() };
      if (provider.loseDeleteResponse) throw new Error("Synthetic lost deletion response");
      return { status: 202, body: { operation: provider.operation } };
    }
    if (method === "GET" && route === `/deletion-operations/${provider.operation?.id}`) {
      if (provider.complete && provider.operation.status === "blocked") Object.assign(provider.operation, { status: "completed", stage: "completed", completedAt: new Date().toISOString() });
      return { status: 200, body: { operation: provider.operation } };
    }
    throw new Error("Unexpected synthetic provider request");
  });
  const native = nativeAgentCanary(lease, profile, request, {
    reserve: (job: any) => reserveHostedAdmission(store, state, profile, { kind: "builder", computeId: `canary:${job.id}` }),
    release: () => releaseHostedAdmission(store, lease, profile),
  }, { strictCleanup: true, cleanupTimeoutMs: 0, nativeDeadlineSeconds: 420, maxUsedHours: 2 });
  vi.spyOn(native, "allocate"); vi.spyOn(native, "start"); vi.spyOn(native, "poll"); vi.spyOn(native, "retire");
  const audit = vi.fn(async () => {}), core = { ...native, retire: vi.fn((job: any) => retireReleaseCanary(lease, native, audit, job)) };
  const adapter = releaseCanaryAdapter(lease, run, new Map(bindings.map(binding => [binding.kind, binding])), core,
    { qualificationProfile: "smoke", pause: async () => {} });
  const later = { ...config, runId: "124", sourceSha: "d".repeat(40) };
  const seedForeignHold = () => ledger.state.reservations.push({ kind: "builder", owner: "f".repeat(24), generation: randomUUID(),
    computeId: `canary:${randomUUID()}`, createdAt: new Date().toISOString() });
  const holdCount = () => ledger.state.reservations.filter((row: any) => row.kind === "builder" && !row.releasedAt).length;
  return { config, later, actor, profile, state, run, image, lease, store, native, core, audit, adapter, request, provider, saves,
    ledger: () => ledger, holdCount, seedForeignHold };
}

describe("production native preallocation and pre-dispatch retirement recovery", () => {
  it("preserves an authenticated superseded save-before-allocation job without blocking a later source", async () => {
    const test = fixture(); let durable: any;
    test.lease.save.mockImplementationOnce(async () => { durable = structuredClone(test.state); throw new Error("Synthetic process loss after committed job save"); });
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("process loss");
    expect(test.native.allocate).not.toHaveBeenCalled(); expect(test.request).not.toHaveBeenCalled();
    const recovered = { ...test.lease, state: durable, save: vi.fn(async () => {}) }, original = structuredClone(durable);
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, recovered, test.native, test.audit)).toBe(0);
    expect(durable).toEqual(original); expect(recovered.save).not.toHaveBeenCalled();
    expect(test.native.allocate).not.toHaveBeenCalled(); expect(test.native.retire).not.toHaveBeenCalled(); expect(test.audit).not.toHaveBeenCalled();
  });
  it("does not release a retained admission CAS when the resource-row save was never committed", async () => {
    const test = fixture(); let durable: any;
    test.lease.save.mockImplementation(async () => {
      if (test.state.resources.images.length) throw new Error("Synthetic process loss before committing the allocation row");
      durable = structuredClone(test.state);
    });
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("process loss");
    expect(test.holdCount()).toBe(1); expect(durable.resources.images).toEqual([]);
    const held = structuredClone(test.ledger()), recovered = { ...test.lease, state: durable, save: vi.fn(async () => {}) };
    const before = test.request.mock.calls.length;
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, recovered, test.native, test.audit)).toBe(0);
    expect(test.ledger()).toEqual(held); expect(test.request.mock.calls).toHaveLength(before);
    await expect(reserveHostedAdmission(test.store, { ...durable, generation: randomUUID() }, {
      boat: { accountScope: "test-account", billingOrg: "test-wallet" }, railway: { projectId: "test-project" },
      planetscale: { organization: "test-org", database: "test-db" }, cloudflare: { accountId: "test-account" },
    }, { kind: "builder", computeId: `canary:${randomUUID()}` })).rejects.toThrow("admission cap reached");
    expect(test.holdCount()).toBe(1); expect(test.request.mock.calls.filter(([method]) => method !== "GET")).toEqual([]);
    expect(test.audit).not.toHaveBeenCalled();
  });
  it("handles real admission denial and normal empty cleanup without releasing the unrelated hold or inventing audit", async () => {
    const test = fixture(); test.seedForeignHold();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("admission cap reached");
    expect(await test.adapter.cleanup()).toBe(true);
    expect(test.state.resources.images).toEqual([]); expect(test.run.canaries[0]).toMatchObject({ phase: "allocating", retired: true });
    const held = structuredClone(test.ledger()), before = test.request.mock.calls.length;
    for (const config of [test.config, test.later])
      expect(await reconcileReleaseCanaryRetirements(config, test.actor, test.lease, test.native, test.audit)).toBe(0);
    expect(test.ledger()).toEqual(held); expect(test.holdCount()).toBe(1); expect(test.request.mock.calls).toHaveLength(before);
    expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    expect(test.run.canaries[0].auditRetired).toBeUndefined(); expect(test.run.canaries[0].outcome).toBeUndefined(); expect(test.audit).not.toHaveBeenCalled();
  });
  it("never resurrects a retired empty allocation when admission becomes available again", async () => {
    const test = fixture(); test.seedForeignHold();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("admission cap reached");
    expect(await test.adapter.cleanup()).toBe(true);
    test.ledger().state.reservations = []; test.native.allocate.mockClear();
    const before = test.request.mock.calls.length;
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("retired");
    expect(test.native.allocate).not.toHaveBeenCalled(); expect(test.request.mock.calls).toHaveLength(before);
    expect(test.native.start).not.toHaveBeenCalled(); expect(test.native.poll).not.toHaveBeenCalled(); expect(test.audit).not.toHaveBeenCalled();
  });
  it("observes the original pre-dispatch deletion after completion and frees its compute hold without another DELETE or audit", async () => {
    const test = fixture();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("clone failed machine attestation");
    expect(await test.adapter.cleanup()).toBe(false); expect(test.holdCount()).toBe(1);
    const row = test.state.resources.images[0], job = test.run.canaries[0];
    expect(row.nativeDispatchStarted).toBeUndefined(); expect(row.builder.deletionOperationId).toBe(test.provider.operation.id);
    const before = test.request.mock.calls.length; test.provider.complete = true;
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).toBe(1);
    expect(test.request.mock.calls.slice(before).map(([method, route]) => [method, route])).toEqual([
      ["GET", `/deletion-operations/${test.provider.operation.id}`], ["GET", "/sandboxes/bx_predispatch"],
    ]);
    expect(row.builder).toMatchObject({ deleted: true, physicalCleanup: { operationId: job.id, operation: { status: "completed" } } });
    expect(test.holdCount()).toBe(0); expect(job.retired).toBe(true); expect(job.auditRetired).toBeUndefined(); expect(job.outcome).toBeUndefined();
    expect(test.native.allocate).toHaveBeenCalledOnce(); expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.native.start).not.toHaveBeenCalled(); expect(test.native.poll).not.toHaveBeenCalled(); expect(test.audit).not.toHaveBeenCalled();
    const completed = structuredClone(test.state), observed = test.request.mock.calls.length;
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit, { maxRecords: 1 })).toBe(0);
    expect(test.state).toEqual(completed); expect(test.request.mock.calls).toHaveLength(observed);
  });
  it("keeps exact denied creation as nonallocation without manufacturing physical cleanup or audit", async () => {
    const test = fixture(); test.provider.rejectCreate = true;
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("request failed (403)");
    expect(await test.adapter.cleanup()).toBe(true); expect(test.holdCount()).toBe(0);
    const row = test.state.resources.images[0], before = test.request.mock.calls.length;
    expect(row).toMatchObject({ builderCreate: { phase: "rejected" }, retired: true, deleted: true }); expect(row.builder).toBeUndefined();
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).toBe(0);
    expect(test.request.mock.calls).toHaveLength(before); expect(test.audit).not.toHaveBeenCalled();
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toEqual([]);
  });
  it("keeps a lost pre-dispatch DELETE response fenced even if the provider later finishes it", async () => {
    const test = fixture(); test.provider.loseDeleteResponse = true;
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("clone failed machine attestation");
    expect(await test.adapter.cleanup()).toBe(false); test.provider.complete = true;
    const row = test.state.resources.images[0], before = test.request.mock.calls.length;
    expect(row.builder).toMatchObject({ deleteRequested: true }); expect(row.builder.deletionOperationId).toBeUndefined();
    await expect(reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).rejects.toThrow("retained ownership and deletion operation");
    expect(test.holdCount()).toBe(1); expect(row.builder.physicalCleanup).toBeUndefined(); expect(row.builder.deleted).not.toBe(true);
    expect(test.request.mock.calls).toHaveLength(before); expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.audit).not.toHaveBeenCalled();
  });
  it("preserves current-run allocation recovery but fences historical allocations with no retained DELETE", async () => {
    const test = fixture();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("clone failed machine attestation");
    const before = test.request.mock.calls.length;
    expect(await reconcileReleaseCanaryRetirements(test.config, test.actor, test.lease, test.native, test.audit)).toBe(0);
    await expect(reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).rejects.toThrow("retained ownership and deletion operation");
    expect(test.request.mock.calls).toHaveLength(before); expect(test.holdCount()).toBe(1); expect(test.run.canaries[0].retired).toBeUndefined();
    expect(test.native.start).not.toHaveBeenCalled(); expect(test.audit).not.toHaveBeenCalled();
  });
  it.each(["pending", "operation-404", "wrong-operation", "wrong-target", "invalid-time", "still-available"])("withholds pre-dispatch completion for %s proof", async rejection => {
    const test = fixture();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("clone failed machine attestation");
    expect(await test.adapter.cleanup()).toBe(false);
    test.provider.complete = rejection !== "pending"; test.provider.available = rejection === "still-available";
    const original = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, input) => {
      const response = await original(method, route, input);
      if (route === `/deletion-operations/${test.provider.operation.id}`) {
        if (rejection === "operation-404") return { status: 404 };
        if (rejection === "wrong-operation") return { status: 200, body: { operation: { ...response.body.operation, id: `bdop_${"e".repeat(32)}` } } };
        if (rejection === "wrong-target") return { status: 200, body: { operation: { ...response.body.operation, targetId: "bx_foreign" } } };
        if (rejection === "invalid-time") return { status: 200, body: { operation: { ...response.body.operation, requestedAt: "not-a-time" } } };
      }
      return response;
    });
    await expect(reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).rejects.toThrow();
    const row = test.state.resources.images[0], job = test.run.canaries[0];
    expect(test.holdCount()).toBe(1); expect(row.builder.deleted).not.toBe(true); expect(row.builder.physicalCleanup).toBeUndefined();
    expect(job.retired).not.toBe(true); expect(job.outcome).toBeUndefined(); expect(job.auditRetired).toBeUndefined();
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.native.start).not.toHaveBeenCalled(); expect(test.native.poll).not.toHaveBeenCalled(); expect(test.audit).not.toHaveBeenCalled();
  });
  it("recovers persisted physical proof after compute release fails, then skips the completed history", async () => {
    const test = fixture();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("clone failed machine attestation");
    expect(await test.adapter.cleanup()).toBe(false); test.provider.complete = true;
    test.store.writeAdmission.mockRejectedValueOnce(new Error("Synthetic admission CAS loss"));
    await expect(reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).rejects.toThrow("admission CAS loss");
    const row = test.state.resources.images[0], job = test.run.canaries[0], before = test.request.mock.calls.length;
    expect(row.builder.deleted).toBe(true); expect(row.builder.physicalCleanup.operation.status).toBe("completed");
    expect(test.saves.some(saved => saved.resources.images[0]?.builder?.physicalCleanup && saved.resources.images[0].builder.deleted !== true)).toBe(true);
    expect(test.holdCount()).toBe(1); expect(job.retired).not.toBe(true);
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).toBe(1);
    expect(test.holdCount()).toBe(0); expect(job.retired).toBe(true); expect(test.request.mock.calls).toHaveLength(before);
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit, { maxRecords: 1 })).toBe(0);
    expect(test.request.mock.calls).toHaveLength(before); expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.audit).not.toHaveBeenCalled();
  });
  it("resumes exact persisted pre-dispatch proof after compute release succeeded but the job completion save was interrupted", async () => {
    const test = fixture();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("clone failed machine attestation");
    expect(await test.adapter.cleanup()).toBe(false); test.provider.complete = true;
    let durable: any;
    test.lease.save.mockImplementation(async () => {
      if (test.run.canaries[0].retired === true) throw new Error("Synthetic interrupted job completion save");
      durable = structuredClone(test.state);
    });
    await expect(reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).rejects.toThrow("interrupted job completion save");
    expect(test.holdCount()).toBe(0); expect(durable.releaseRuns[0].canaries[0].retired).toBeUndefined();
    expect(durable.resources.images[0].builder.physicalCleanup.operation.status).toBe("completed");
    const before = test.request.mock.calls.length, recovered = { state: durable, signal: new AbortController().signal,
      fence: vi.fn(async () => {}), save: vi.fn(async () => {}) };
    const native = nativeAgentCanary(recovered, test.profile, test.request,
      { release: () => releaseHostedAdmission(test.store, recovered, test.profile) }, { strictCleanup: true, cleanupTimeoutMs: 0 });
    vi.spyOn(native, "allocate"); vi.spyOn(native, "start");
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, recovered, native, test.audit)).toBe(1);
    expect(durable.releaseRuns[0].canaries[0].retired).toBe(true); expect(test.holdCount()).toBe(0);
    expect(await reconcileReleaseCanaryRetirements(test.later, test.actor, recovered, native, test.audit, { maxRecords: 1 })).toBe(0);
    expect(test.request.mock.calls).toHaveLength(before); expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(native.allocate).not.toHaveBeenCalled(); expect(native.start).not.toHaveBeenCalled(); expect(test.audit).not.toHaveBeenCalled();
  });
  it("does not convert old retired/deleted markers into legacy pre-dispatch physical proof", async () => {
    const test = fixture();
    await expect(test.adapter.qualify(test.image, "claude-setup-token")).rejects.toThrow("clone failed machine attestation");
    expect(await test.adapter.cleanup()).toBe(false);
    Object.assign(test.state.resources.images[0], { retired: true, deleted: true });
    test.state.resources.images[0].builder.deleted = true; test.run.canaries[0].retired = true;
    const before = test.request.mock.calls.length;
    await expect(reconcileReleaseCanaryRetirements(test.later, test.actor, test.lease, test.native, test.audit)).rejects.toThrow("physical cleanup proof is unconfirmed");
    expect(test.request.mock.calls).toHaveLength(before); expect(test.holdCount()).toBe(1); expect(test.audit).not.toHaveBeenCalled();
  });
});
