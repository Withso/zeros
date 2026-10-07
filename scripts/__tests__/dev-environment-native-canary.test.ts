import { describe, expect, it, vi } from "vitest";
import { hostedAgentCanary } from "../dev-environment/hosted-agent-canary.mjs";
import { nativeAgentCanary } from "../dev-environment/native-agent-canary.mjs";
import { reserveHostedAdmission, releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";

const image = { snapshotId: "test-worker", sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64) };
const job = () => ({ id: "11111111-1111-4111-8111-111111111111", image });
function harness(options: Record<string, any> = {}) {
  const state = newHostedGeneration({ owner: "a".repeat(24), identity: "native-canary" });
  state.resources.images = [];
  const lease = { state, save: vi.fn(async () => {}), fence: vi.fn(async () => {}) };
  const admission = { reserve: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const provider = { usedSeconds: 0, loseCreate: false, started: true, physicalDeletion: true, snapshots: false as boolean | undefined, deleteRequested: false };
  const operationId = `bdop_${"c".repeat(32)}`, uploads: any[] = [];
  const request = vi.fn(async (method: string, route: string, input: any = {}) => {
    if (route.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: provider.usedSeconds } };
    if (method === "POST" && route === "/sandboxes") {
      if (provider.loseCreate) { provider.loseCreate = false; throw new Error("synthetic lost create"); }
      return { status: 201, body: { sandbox: { id: "bx_test" } } };
    }
    if (method === "GET" && route === "/sandboxes/bx_test") return provider.deleteRequested ? { status: 404, body: {} }
      : { status: 200, body: { sandbox: { id: "bx_test", state: "ready", snapshots: provider.snapshots, team: { id: "test-wallet" } } } };
    if (method === "POST" && route.endsWith("/commands")) return { status: 200, body: { exitCode: 0, stdout: JSON.stringify(input.body.command.includes("dispatchUnconfirmed")
      ? provider.started ? { running: true } : { dispatchUnconfirmed: true } : { started: provider.started }) } };
    if (method === "PUT") { uploads.push(JSON.parse(Buffer.from(input.body.content, "base64").toString())); return { status: 200, body: { size: Buffer.from(input.body.content, "base64").length } }; }
    if (method === "DELETE") { provider.deleteRequested = true; return { status: 202, body: { operation: { id: operationId, kind: "sandbox", targetId: "bx_test" } } }; }
    if (route.startsWith("/deletion-operations")) return { status: 200, body: { operation: { id: operationId, kind: "sandbox", targetId: "bx_test",
      status: provider.physicalDeletion ? "completed" : "blocked", stage: "kept_for_newer_snapshots", requestedAt: new Date().toISOString(), completedAt: provider.physicalDeletion ? new Date().toISOString() : null } } };
    throw new Error("Unexpected fake canary request");
  });
  const core = nativeAgentCanary(lease, { boat: { billingOrg: "test-wallet", accountScope: "test-scope", builderBudgetHours: 0.25 },
    railway: { projectId: "test-project" }, planetscale: { organization: "test-organization", database: "test-database" }, cloudflare: { accountId: "test-account" } }, request, admission,
    { strictCleanup: true, maxUsedHours: 0.2, nativeDeadlineSeconds: 420, ...options });
  return { core, lease, request, provider, admission, uploads };
}
function historical(test: ReturnType<typeof harness>, target = job(), patch: Record<string, any> = {}) {
  const row = { agentQualificationId: target.id, inputsSha256: "d".repeat(64), purpose: "native-agent-qualification",
    sourceCommit: image.sourceCommit, sourceImage: image.snapshotId, maxUsedHours: 0.2, snapshotPolicyVersion: 1,
    builderIntent: { key: target.id, at: Date.now(), body: { type: "default", from: image.snapshotId, ttlSeconds: 360, noEnv: true, env: {}, snapshots: false } },
    builderCreate: { phase: "acknowledged" }, builder: { id: "bx_test" }, ...patch };
  test.lease.state.resources.images.push(row); return row;
}
describe("shared disposable native canary transport", () => {
  it("refuses allocation before provider budget reads, admission or any lease writes", async () => {
    const test = harness(), before = structuredClone(test.lease.state);
    await expect(test.core.allocate(job(), image)).rejects.toMatchObject({ status: 409, code: "release_worker_images_retired",
      message: "v3 release worker images are retired; v4 runtime bundles are the supported artifact" });
    expect(test.request).not.toHaveBeenCalled(); expect(test.admission.reserve).not.toHaveBeenCalled();
    expect(test.admission.release).not.toHaveBeenCalled(); expect(test.lease.save).not.toHaveBeenCalled();
    expect(test.lease.fence).not.toHaveBeenCalled(); expect(test.lease.state).toEqual(before);
  });
  it("refuses native dispatch before saving a dispatch marker or staging any transport material", async () => {
    const test = harness(), target = job(), runner = vi.fn();
    test.lease.state.resources.images.push({ agentQualificationId: target.id, purpose: "native-agent-qualification",
      sourceCommit: image.sourceCommit, sourceImage: image.snapshotId, maxUsedHours: 0.2,
      builderIntent: { key: target.id, at: Date.now(), body: { snapshots: false } }, builder: { id: "bx_test" } });
    const before = structuredClone(test.lease.state);
    await expect(test.core.start(target, { material: { kind: "cursor-api-key", apiKey: "synthetic-private-canary-value" } }, undefined, runner))
      .rejects.toMatchObject({ status: 409, code: "release_worker_images_retired" });
    expect(runner).not.toHaveBeenCalled(); expect(test.request).not.toHaveBeenCalled(); expect(test.uploads).toEqual([]);
    expect(test.lease.save).not.toHaveBeenCalled(); expect(test.lease.fence).not.toHaveBeenCalled();
    expect(test.lease.state).toEqual(before);
  });
  it.each(["allocate", "ready", "start"] as const)("refuses %s even for recorded legacy attempts without provider or lease effects", async action => {
    const test = harness(), target = job(); historical(test, target, { nativeDispatchStarted: true });
    const before = structuredClone(test.lease.state);
    await expect(test.core[action](target, image)).rejects.toMatchObject({ status: 409, code: "release_worker_images_retired" });
    expect(test.request).not.toHaveBeenCalled(); expect(test.lease.save).not.toHaveBeenCalled();
    expect(test.lease.fence).not.toHaveBeenCalled(); expect(test.lease.state).toEqual(before);
  });
  it("refuses the hosted alias and lazy default client before reading provider authority", async () => {
    const forbidden = new Proxy({}, { get() { throw new Error("Provider authority must not be read"); } });
    await expect(hostedAgentCanary(forbidden, forbidden).allocate(job(), image)).rejects.toMatchObject({
      status: 409, code: "release_worker_images_retired" });
  });
  it("uses private file transport for access material and the SMOKE deadline only in history; retired dispatch performs zero transport", async () => {
    const test = harness(), target = job(); historical(test, target);
    await expect(test.core.start(target, { material: { kind: "cursor-api-key", apiKey: "synthetic-private-canary-value" } }))
      .rejects.toMatchObject({ status: 409, code: "release_worker_images_retired" });
    expect(test.uploads).toEqual([]); expect(test.request).not.toHaveBeenCalled();
    expect(test.lease.state.resources.images[0].nativeDispatchStarted).toBeUndefined();
  });
  it("reconciles a lost historical clone only through retirement with the same request and key", async () => {
    const test = harness(), target = job(), row = historical(test, target, { builder: undefined, builderCreate: { phase: "uncertain" } });
    test.provider.loseCreate = true;
    await expect(test.core.retire(target)).rejects.toThrow("lost create");
    expect(row.builderCreate.phase).toBe("uncertain");
    await test.core.retire(target);
    const creates = test.request.mock.calls.filter(([method, route]) => method === "POST" && route === "/sandboxes");
    expect(creates).toHaveLength(2); expect(creates[1][2]).toEqual(creates[0][2]);
    expect(row.builder).toMatchObject({ id: "bx_test", deleted: true });
  });
  it.each([undefined, true, false])("preserves a historical snapshots=%s creation body and key during cleanup recovery", async snapshots => {
    const test = harness(), target = job();
    const body = Object.freeze({ type: "default", from: image.snapshotId, ttlSeconds: 360, noEnv: true, env: {},
      ...(snapshots === undefined ? {} : { snapshots }) });
    const row = historical(test, target, { builder: undefined, snapshotPolicyVersion: undefined,
      builderIntent: { key: target.id, at: Date.now(), body }, builderCreate: { phase: "uncertain" } });
    await test.core.retire(target);
    const create = test.request.mock.calls.find(([method, route]) => method === "POST" && route === "/sandboxes")!;
    expect(create[2].body).toBe(body); expect(create[2].body).toEqual(body);
    expect(create[2].headers).toEqual({ "idempotency-key": target.id, "x-boat-org": "test-wallet" });
    expect(row.builderIntent.body).toBe(body); expect(row.builder).toMatchObject({ id: "bx_test", deleted: true });
  });
  it("does not invent an allocation intent during historical cleanup", async () => {
    const test = harness(), target = job(); historical(test, target, { builder: undefined, builderIntent: undefined });
    await expect(test.core.retire(target)).rejects.toThrow("recorded original allocation intent");
    expect(test.request).not.toHaveBeenCalled(); expect(test.admission.reserve).not.toHaveBeenCalled();
  });
  it("keeps original-intent expiry closed instead of replaying an expired create", async () => {
    const test = harness(), target = job(), row = historical(test, target, { builder: undefined });
    row.builderIntent.at = Date.now() - 24 * 3600_000;
    await expect(test.core.retire(target)).rejects.toThrow("idempotency window");
    expect(test.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
  it("polls only an already-started runner without dispatching credentials again", async () => {
    const test = harness(), target = job(); historical(test, target, { nativeDispatchStarted: true });
    test.provider.started = false;
    await expect(test.core.poll(target)).rejects.toThrow("dispatch is unconfirmed");
    test.provider.started = true;
    expect(await test.core.poll(target)).toEqual({ running: true }); expect(test.uploads).toEqual([]);
    expect(test.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
  });
  it.each(["starting", "running"])("polls the historical hosted SSH %s receipt without a native dispatch marker", async phase => {
    const test = harness(), target = { ...job(), phase, startedAt: Date.now(), connection: { kind: "cursor-api-key", model: "test-model" } };
    const row = historical(test, target); test.lease.state.agentQualifications = [structuredClone(target)];
    expect(row.nativeDispatchStarted).toBeUndefined();
    expect(await test.core.poll(target)).toEqual({ running: true });
    expect(test.request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1);
    expect(test.request.mock.calls.find(([method]) => method === "POST")![1]).toBe("/sandboxes/bx_test/commands");
    expect(test.request.mock.calls.some(([method]) => method === "PUT")).toBe(false);
    expect(test.uploads).toEqual([]); expect(test.admission.reserve).not.toHaveBeenCalled();
    expect(test.lease.fence).not.toHaveBeenCalled(); expect(row.nativeDispatchStarted).toBeUndefined();
    await expect(test.core.start(target)).rejects.toMatchObject({ code: "release_worker_images_retired" });
  });
  it.each(["not recorded", "allocating", "another source", "another snapshot", "another build"])("refuses historical SSH poll when %s before provider access", async invalid => {
    const test = harness(), target = job(); historical(test, target);
    const recorded = { ...target, image: { ...image }, phase: "running", startedAt: Date.now() };
    if (invalid !== "not recorded") test.lease.state.agentQualifications = [recorded];
    if (invalid === "allocating") recorded.phase = "allocating";
    if (invalid === "another source") recorded.image.sourceCommit = "c".repeat(40);
    if (invalid === "another snapshot") recorded.image.snapshotId = "another-worker";
    if (invalid === "another build") recorded.image.buildSha256 = "c".repeat(64);
    await expect(test.core.poll(target)).rejects.toMatchObject({ code: "release_worker_images_retired" });
    expect(test.request).not.toHaveBeenCalled(); expect(test.lease.save).not.toHaveBeenCalled();
  });
  it("refuses polling a never-dispatched record before provider reads or lease writes", async () => {
    const test = harness(), target = job(); historical(test, target);
    await expect(test.core.poll(target)).rejects.toMatchObject({ status: 409, code: "release_worker_images_retired" });
    expect(test.request).not.toHaveBeenCalled(); expect(test.lease.save).not.toHaveBeenCalled();
  });
  it("persists bound physical proof before compute release and repairs the historical deleted boolean without DELETE replay", async () => {
    const test = harness(), target = job(); historical(test, target);
    test.admission.release.mockClear();
    test.admission.release.mockImplementation(async () => {
      const row = test.lease.state.resources.images[0];
      expect(row.builder.physicalCleanup).toMatchObject({ version: 1, operationId: target.id, targetId: "bx_test", snapshotId: image.snapshotId,
        sourceCommit: image.sourceCommit, buildSha256: image.buildSha256, operation: { status: "completed" } });
      expect(test.lease.save).toHaveBeenCalled();
    });
    await test.core.retire(target);
    const row = test.lease.state.resources.images[0];
    delete row.builder.physicalCleanup;
    await test.core.retire(target);
    expect(row.builder.physicalCleanup).toMatchObject({ operationId: target.id, operation: { id: `bdop_${"c".repeat(32)}` } });
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.admission.release).toHaveBeenCalledTimes(2);
  });
  it("holds strict cleanup until a matching physical-deletion operation completes", async () => {
    const test = harness(), target = job(); historical(test, target); test.provider.physicalDeletion = false;
    await expect(test.core.retire(target)).rejects.toThrow("blocked");
    expect(test.lease.state.resources.images[0].deleted).not.toBe(true);
    test.provider.physicalDeletion = true; await test.core.retire(target);
    expect(test.lease.state.resources.images[0].deleted).toBe(true);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("retains real compute admission for a snapshots-off clone until physical deletion is proved", async () => {
    const test = harness(), target = job(), profile = { boat: { accountScope: "test-scope", billingOrg: "test-wallet", baseSnapshot: "test-base" },
      railway: { projectId: "test-project" }, planetscale: { organization: "test-organization", database: "test-database" },
      cloudflare: { accountId: "test-account" } };
    let current: any = null, revision = 0;
    const store = { list: async () => ({ records: [{ state: test.lease.state }], quarantine: [] }),
      readAdmission: async () => current ? structuredClone(current) : null,
      writeAdmission: async (state: any, etag: any) => {
        if (current?.etag !== etag) throw Object.assign(new Error(), { code: "DEV_REGISTRY_CONFLICT" });
        current = { state: structuredClone(state), etag: String(++revision) }; return current.etag;
      } };
    test.admission.reserve.mockImplementation(async () => { await reserveHostedAdmission(store, test.lease.state, profile,
      { kind: "builder", computeId: `canary:${target.id}` }); });
    test.admission.release.mockImplementation(async () => { await releaseHostedAdmission(store, test.lease, profile); });
    const holds = () => current.state.reservations.filter((reservation: any) => reservation.kind === "builder");
    historical(test, target); await test.admission.reserve(target);
    expect(test.lease.state.resources.images[0].builderIntent.body.snapshots).toBe(false);
    expect(holds()).toMatchObject([{ computeId: `canary:${target.id}` }]);
    expect(holds()[0].snapshotName).toBeUndefined();
    test.provider.physicalDeletion = false;
    await expect(test.core.retire(target)).rejects.toThrow("blocked");
    expect(holds()).toHaveLength(1); expect(holds()[0].releasedAt).toBeUndefined();
    expect(test.lease.state.resources.images[0].builder).toMatchObject({ deleteRequested: true, deletionOperationId: `bdop_${"c".repeat(32)}` });
    expect(test.lease.state.resources.images[0].builder.deleted).not.toBe(true);
    expect(test.lease.state.resources.images[0].builder.retiredAt).toBeUndefined();
    test.provider.physicalDeletion = true; await test.core.retire(target);
    expect(test.lease.state.resources.images[0].deleted).toBe(true); expect(holds()).toHaveLength(0);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("does not treat snapshots-off as deletion proof after a lost DELETE response", async () => {
    const test = harness(), target = job(); historical(test, target);
    test.request.mockImplementationOnce(async () => { throw new Error("synthetic lost delete"); });
    await expect(test.core.retire(target)).rejects.toThrow("synthetic lost delete");
    await expect(test.core.retire(target)).rejects.toThrow("deletion response was lost");
    expect(test.lease.state.resources.images[0].builder.deleted).not.toBe(true);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("does not replay a historical create after account exhaustion or an invalid meter", async () => {
    for (const usedSeconds of [720, 800, -1, NaN]) {
      const test = harness(); test.provider.usedSeconds = usedSeconds;
      const target = job(); historical(test, target, { builder: undefined, builderCreate: { phase: "uncertain" } });
      await expect(test.core.retire(target)).rejects.toThrow(/budget|meter/);
      expect(test.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
      expect(test.admission.reserve).not.toHaveBeenCalled();
    }
  });
});
