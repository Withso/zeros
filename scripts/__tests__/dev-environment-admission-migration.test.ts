import { expect, it, vi } from "vitest";
import { reserveHostedAdmission, releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { hostedAgentCanary } from "../dev-environment/hosted-agent-canary.mjs";
import { reconcileDevImageCreates } from "../dev-environment/hosted-image.mjs";

const profile: any = { boat: { accountScope: "scope", billingOrg: "org", baseSnapshot: "base", builderBudgetHours: 1 },
  railway: { projectId: "project" }, planetscale: { organization: "org", database: "db" }, cloudflare: { accountId: "account" } };
const generation = (owner: string) => newHostedGeneration({ owner: owner.repeat(24), identity: owner });
function registry(records: any[]) {
  let value: any = null, revision = 0;
  return { list: async () => ({ records: records.map(state => ({ state: structuredClone(state) })), quarantine: [] }),
    readAdmission: async () => structuredClone(value),
    writeAdmission: vi.fn(async (state, etag) => {
      if (etag !== value?.etag) throw Object.assign(new Error("conflict"), { code: "DEV_REGISTRY_CONFLICT" });
      value = { state: structuredClone(state), etag: String(++revision) }; return value.etag;
    }) };
}
const leaseFor = (state: any) => ({ state, save: vi.fn(), fence: vi.fn() });
const name = (state: any, suffix = "old") => `dev-${state.owner}-${state.generation.slice(0, 8)}-${suffix}`;
async function realCanary(state: any, id = "11111111-1111-4111-8111-111111111111") {
  state.resources.images ??= [];
  const job = { id }, lease = leaseFor(state);
  await hostedAgentCanary(lease, profile, async (method, route) => route.startsWith("/limits")
    ? { status: 200, body: { creditUsedSeconds: 0 } }
    : { status: 200, body: { sandbox: { id: "bx_canary", team: { id: "org" } } } }).allocate(job, { snapshotId: "base", sourceCommit: "a".repeat(40) });
  return state.resources.images.find(image => image.agentQualificationId === id);
}

it("V4-04 enrolls a real qualification canary without reserving a snapshot or poisoning later operations", async () => {
  const old = generation("a"), fresh = generation("b"); old.status = "ready";
  const canary = await realCanary(old), store = registry([old, fresh]);
  expect(canary.snapshotId).toBeUndefined();
  await reserveHostedAdmission(store, fresh, profile);
  await expect(reserveHostedAdmission(store, fresh, profile)).resolves.toBeDefined();
  const row = (await store.readAdmission()).state.reservations.find(row => row.kind === "builder");
  expect(row).toMatchObject({ computeId: `canary:${canary.agentQualificationId}` }); expect(row.snapshotName).toBeUndefined();
  await expect(reserveHostedAdmission(store, fresh, profile, { kind: "builder", snapshotName: name(fresh), inventory: [{ provider: "boat", id: "base" }] })).rejects.toThrow(/cap/);
  await releaseHostedAdmission(store, leaseFor(old), profile);
  expect((await store.readAdmission()).state.reservations.some(row => row.computeId === `canary:${canary.agentQualificationId}`)).toBe(true);
  canary.builder.deleted = true;
  await releaseHostedAdmission(store, leaseFor(old), profile);
  expect((await store.readAdmission()).state.reservations.some(row => row.computeId === `canary:${canary.agentQualificationId}`)).toBe(false);
  await expect(reserveHostedAdmission(store, fresh, profile)).resolves.toBeDefined();
});

it("V4-04 repairs the earlier nameless builder row from authenticated canaries and keeps uncertain allocations", async () => {
  const old = generation("a"), fresh = generation("b"), store = registry([old, fresh]); old.status = "ready";
  // Write the old bug's row after obtaining the real account digest.
  await reserveHostedAdmission(store, fresh, profile);
  const canary = await realCanary(old); delete canary.builder;
  const saved = await store.readAdmission();
  saved.state.reservations.push({ kind: "builder", owner: old.owner, generation: old.generation, createdAt: old.createdAt, legacy: true });
  await store.writeAdmission(saved.state, saved.etag);
  await expect(releaseHostedAdmission(store, leaseFor(fresh), profile)).resolves.toBeUndefined();
  const repaired = (await store.readAdmission()).state.reservations.filter(row => row.kind === "builder");
  expect(repaired).toEqual([expect.objectContaining({ computeId: `canary:${canary.agentQualificationId}`, owner: old.owner })]);
  expect(repaired[0].releasedAt).toBeUndefined();
  await expect(reserveHostedAdmission(store, fresh, profile)).resolves.toBeDefined();
});

it("V4-04 preserves an unrecoverable nameless row instead of guessing away account capacity", async () => {
  const state = generation("a"), store = registry([state]);
  await reserveHostedAdmission(store, state, profile);
  const saved = await store.readAdmission();
  saved.state.reservations.push({ kind: "builder", owner: "b".repeat(24), generation: state.generation, createdAt: state.createdAt, legacy: true });
  await store.writeAdmission(saved.state, saved.etag); const before = await store.readAdmission(); store.writeAdmission.mockClear();
  await expect(releaseHostedAdmission(store, leaseFor(state), profile)).rejects.toThrow(/reconcil|ledger/);
  expect(store.writeAdmission).not.toHaveBeenCalled(); expect(await store.readAdmission()).toEqual(before);
});

it.each(["own", "other"])("V4-05 counts %s legacy uncertain builders before a changed-source allocation", async selected => {
  const old = generation("a"), fresh = selected === "own" ? old : generation("b"); old.version = 1; old.status = "ready";
  old.resources.images = [{ snapshotId: name(old), builderIntent: { key: "old-key", at: Date.now() }, builderCreate: { phase: "uncertain" } }];
  const store = registry([old]); await reserveHostedAdmission(store, fresh, profile);
  await expect(reserveHostedAdmission(store, fresh, profile, { kind: "builder", snapshotName: name(fresh, "changed"), inventory: [{ provider: "boat", id: "base" }] })).rejects.toThrow(/cap/);
  expect((await store.readAdmission()).state.reservations).toContainEqual(expect.objectContaining({ kind: "builder", snapshotName: name(old) }));
});

it("V4-05 retains a pending snapshot slot after its builder is physically gone", async () => {
  const old = generation("a"), fresh = generation("b"); old.status = "ready";
  old.resources.images = [{ snapshotId: name(old), snapshotRequested: true, snapshotCreate: { phase: "uncertain" }, builder: { id: "bx_old", deleted: true } }];
  const store = registry([old]); await reserveHostedAdmission(store, fresh, profile);
  const inventory = [{ provider: "boat", id: "base" }, ...Array.from({ length: 7 }, (_, i) => ({ provider: "boat", id: `release-${i}` }))];
  await expect(reserveHostedAdmission(store, fresh, profile, { kind: "builder", snapshotName: name(fresh), inventory })).rejects.toThrow(/snapshot capacity/);
});

it("V4-04 validates the enrolled ledger before writing any malformed resource identity", async () => {
  const old = generation("a"), fresh = generation("b"); old.status = "ready";
  old.resources.images = [{ snapshotId: "foreign-name", builder: { id: "bx_old" } }];
  const store = registry([old]);
  await expect(reserveHostedAdmission(store, fresh, profile)).rejects.toThrow(/ledger|identity|reservation/);
  expect(store.writeAdmission).not.toHaveBeenCalled();
});

it("V4-04 reserves canary compute before dispatch and denies a second owner without inventing an intent", async () => {
  const first = generation("a"), second = generation("b"), store = registry([first, second]);
  first.resources.images = []; second.resources.images = [];
  const request = vi.fn(async (method, route) => route.startsWith("/limits")
    ? { status: 200, body: { creditUsedSeconds: 0 } }
    : { status: 200, body: { sandbox: { id: "bx_canary", team: { id: "org" } } } });
  const canary = (state: any) => hostedAgentCanary(leaseFor(state), profile, request, {
    reserve: job => reserveHostedAdmission(store, state, profile, { kind: "builder", computeId: `canary:${job.id}` }),
    release: () => releaseHostedAdmission(store, leaseFor(state), profile),
  });
  const image = { snapshotId: "base", sourceCommit: "a".repeat(40) };
  await canary(first).allocate({ id: "11111111-1111-4111-8111-111111111111" }, image);
  await expect(canary(second).allocate({ id: "22222222-2222-4222-8222-222222222222" }, image)).rejects.toThrow(/cap/);
  expect(request.mock.calls.filter(call => call[0] === "POST")).toHaveLength(1);
  expect(second.resources.images).toEqual([]);
  const reservation = (await store.readAdmission()).state.reservations.find(row => row.kind === "builder");
  expect(reservation.computeId).toBe("canary:11111111-1111-4111-8111-111111111111");
  expect(reservation.snapshotName).toBeUndefined();
  request.mockImplementation(async (_method, route) => route.startsWith("/limits")
    ? { status: 200, body: { creditUsedSeconds: 0 } }
    : route === "/sandboxes/bx_canary" || route.startsWith("/deletion-operations/")
      ? { status: 200, body: { operation: { id: "bdop_" + "a".repeat(32), kind: "sandbox", targetId: "bx_canary", status: "completed", completedAt: new Date().toISOString() } } }
      : { status: 200, body: { sandbox: { id: "bx_next", team: { id: "org" } } } });
  await canary(first).retire({ id: "11111111-1111-4111-8111-111111111111" });
  expect((await store.readAdmission()).state.reservations.some(row => row.kind === "builder")).toBe(false);
  await expect(canary(second).allocate({ id: "22222222-2222-4222-8222-222222222222" }, image)).resolves.toBeUndefined();
});

it("V4-04 reconciles an uncertain canary using its original key without fabricating a named snapshot", async () => {
  const state = generation("a"), row = await realCanary(state); delete row.builder;
  row.builderCreate = { phase: "uncertain" };
  const request = vi.fn(async (method, route, options) => {
    expect(method).toBe("POST"); expect(route).toBe("/sandboxes");
    expect(options.headers["idempotency-key"]).toBe(row.builderIntent.key);
    expect(options.body).toEqual(row.builderIntent.body);
    return { status: 200, body: { sandbox: { id: "bx_canary" } } };
  });
  await reconcileDevImageCreates(leaseFor(state), profile, request);
  expect(request).toHaveBeenCalledOnce(); expect(row.snapshotId).toBeUndefined();
  expect(row.builderCreate.phase).toBe("acknowledged");
});

it("V4-04 retires a known initial canary rejection without allocating again or retaining compute capacity", async () => {
  const state = generation("a"), store = registry([state]), lease = leaseFor(state); state.resources.images = [];
  const request = vi.fn(async (_method, route) => route.startsWith("/limits")
    ? { status: 200, body: { creditUsedSeconds: 0 } } : { status: 403 });
  const canary = hostedAgentCanary(lease, profile, request, {
    reserve: job => reserveHostedAdmission(store, state, profile, { kind: "builder", computeId: `canary:${job.id}` }),
    release: () => releaseHostedAdmission(store, lease, profile),
  });
  const job = { id: "11111111-1111-4111-8111-111111111111", image: { snapshotId: "base", sourceCommit: "a".repeat(40) } };
  await expect(canary.allocate(job, job.image)).rejects.toThrow();
  expect(state.resources.images[0].builderCreate.phase).toBe("rejected");
  await expect(canary.retire(job)).resolves.toBeUndefined();
  expect(request.mock.calls.filter(call => call[0] === "POST")).toHaveLength(1);
  expect(state.resources.images[0].deleted).toBe(true);
  expect((await store.readAdmission()).state.reservations.some(row => row.kind === "builder")).toBe(false);
});
