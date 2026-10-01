import { describe, expect, it, vi } from "vitest";
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
  const provider = { usedSeconds: 0, loseCreate: false, started: true, physicalDeletion: true };
  const operationId = `bdop_${"c".repeat(32)}`, uploads: any[] = [];
  const request = vi.fn(async (method: string, route: string, input: any = {}) => {
    if (route.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: provider.usedSeconds } };
    if (method === "POST" && route === "/sandboxes") {
      if (provider.loseCreate) { provider.loseCreate = false; throw new Error("synthetic lost create"); }
      return { status: 201, body: { sandbox: { id: "bx_test" } } };
    }
    if (method === "GET" && route === "/sandboxes/bx_test") return { status: 200, body: { sandbox: { id: "bx_test", state: "ready", team: { id: "test-wallet" } } } };
    if (method === "POST" && route.endsWith("/commands")) return { status: 200, body: { exitCode: 0, stdout: JSON.stringify({ started: provider.started }) } };
    if (method === "PUT") { uploads.push(JSON.parse(Buffer.from(input.body.content, "base64").toString())); return { status: 200, body: { size: Buffer.from(input.body.content, "base64").length } }; }
    if (method === "DELETE") return { status: 202, body: { operation: { id: operationId, kind: "sandbox", targetId: "bx_test" } } };
    if (route.startsWith("/deletion-operations")) return { status: 200, body: { operation: { id: operationId, kind: "sandbox", targetId: "bx_test",
      status: provider.physicalDeletion ? "completed" : "blocked", stage: "kept_for_newer_snapshots", completedAt: provider.physicalDeletion ? new Date().toISOString() : null } } };
    throw new Error("Unexpected fake canary request");
  });
  const core = nativeAgentCanary(lease, { boat: { billingOrg: "test-wallet", builderBudgetHours: 0.25 } }, request, admission,
    { strictCleanup: true, maxUsedHours: 0.2, nativeDeadlineSeconds: 420, ...options });
  return { core, lease, request, provider, admission, uploads };
}
describe("shared disposable native canary transport", () => {
  it("bounds SMOKE VM lifetime by its profile and the remaining account-wide budget before dispatch", async () => {
    const test = harness(), target = job(); test.provider.usedSeconds = 360;
    await test.core.allocate(target, image);
    const create = test.request.mock.calls.find(([method, route]) => method === "POST" && route === "/sandboxes")!;
    expect(create[2].body).toEqual({ type: "default", from: image.snapshotId, ttlSeconds: 360, noEnv: true, env: {}, snapshots: false });
    expect(create[2].headers).toEqual({ "idempotency-key": target.id, "x-boat-org": "test-wallet" });
    expect(test.admission.reserve).toHaveBeenCalledOnce();
  });
  it("reconciles a lost clone response with the same persisted request and key before proceeding", async () => {
    const test = harness(), target = job(); test.provider.loseCreate = true;
    await expect(test.core.allocate(target, image)).rejects.toThrow("lost create");
    expect(test.lease.state.resources.images[0].builderCreate.phase).toBe("uncertain");
    await test.core.allocate(target, image);
    const creates = test.request.mock.calls.filter(([method, route]) => method === "POST" && route === "/sandboxes");
    expect(creates).toHaveLength(2); expect(creates[1][2]).toEqual(creates[0][2]);
    expect(test.lease.state.resources.images[0].builder.id).toBe("bx_test");
  });
  it.each([undefined, true, false])("preserves a historical snapshots=%s creation body and key during recovery", async snapshots => {
    const test = harness(), target = job();
    const body = Object.freeze({ type: "default", from: image.snapshotId, ttlSeconds: 360, noEnv: true, env: {},
      ...(snapshots === undefined ? {} : { snapshots }) });
    test.lease.state.resources.images.push({ agentQualificationId: target.id, purpose: "native-agent-qualification",
      sourceCommit: image.sourceCommit, sourceImage: image.snapshotId, maxUsedHours: 0.2,
      builderIntent: { key: target.id, at: Date.now(), body }, builderCreate: { phase: "uncertain" } });
    await test.core.allocate(target, image);
    const create = test.request.mock.calls.find(([method, route]) => method === "POST" && route === "/sandboxes")!;
    expect(create[2].body).toBe(body);
    expect(create[2].body).toEqual(body);
    expect(create[2].headers).toEqual({ "idempotency-key": target.id, "x-boat-org": "test-wallet" });
    expect(test.lease.state.resources.images[0].builderIntent.body).toBe(body);
    expect(test.lease.state.resources.images[0].builder.id).toBe("bx_test");
  });
  it("never redispatches native authority after a lost start, and fails closed without a runner observation", async () => {
    const test = harness(), target = job(), runner = vi.fn(async () => { throw new Error("synthetic lost native start"); });
    await test.core.allocate(target, image);
    await expect(test.core.start(target, {}, undefined, runner)).rejects.toThrow("lost native start");
    await test.core.start(target, {}, undefined, runner); expect(runner).toHaveBeenCalledOnce();
    test.provider.started = false;
    await expect(test.core.start(target, {}, undefined, runner)).rejects.toThrow("never redispatch credentials");
    expect(runner).toHaveBeenCalledOnce();
  });
  it("uses private file transport for access material and the SMOKE deadline, never command interpolation", async () => {
    const test = harness(), target = job(), secret = "synthetic-private-canary-value";
    await test.core.allocate(target, image);
    await test.core.start(target, { material: { kind: "cursor-api-key", apiKey: secret } });
    expect(test.uploads).toEqual([{ material: { kind: "cursor-api-key", apiKey: secret } }]);
    const commands = test.request.mock.calls.filter(([method, route]) => method === "POST" && route.endsWith("/commands")).map(([, , input]) => input.body.command);
    expect(commands.join("\n")).not.toContain(secret); expect(commands.join("\n")).toContain("time.monotonic()+420");
    expect(commands.join("\n")).toContain("os.O_EXCL|os.O_NOFOLLOW");
  });
  it("holds strict cleanup until a matching physical-deletion operation completes", async () => {
    const test = harness(), target = job(); await test.core.allocate(target, image); test.provider.physicalDeletion = false;
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
    await test.core.allocate(target, image);
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
    const test = harness(), target = job(); await test.core.allocate(target, image);
    test.request.mockImplementationOnce(async () => { throw new Error("synthetic lost delete"); });
    await expect(test.core.retire(target)).rejects.toThrow("synthetic lost delete");
    await expect(test.core.retire(target)).rejects.toThrow("deletion response was lost");
    expect(test.lease.state.resources.images[0].builder.deleted).not.toBe(true);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("does not allocate after account exhaustion or an invalid meter", async () => {
    for (const usedSeconds of [720, 800, -1, NaN]) {
      const test = harness(); test.provider.usedSeconds = usedSeconds;
      await expect(test.core.allocate(job(), image)).rejects.toThrow(/budget|meter/);
      expect(test.request.mock.calls.some(([method]) => method === "POST")).toBe(false);
      expect(test.admission.reserve).not.toHaveBeenCalled();
    }
  });
});
