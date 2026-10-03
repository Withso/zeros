import { expect, it, vi } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { retireSupersededDevImages } from "../dev-environment/hosted-image.mjs";
import { reserveHostedAdmission, releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";

const profile: any = { boat: { accountScope: "scope", billingOrg: "org", baseSnapshot: "base" } };

function generation(builderDeleted: (n: number) => boolean = () => true) {
  const state: any = newHostedGeneration({ owner: "a".repeat(24), identity: "synthetic" });
  const prefix = `dev-${state.owner}-${state.generation.slice(0, 8)}-`;
  const image = (n: number) => ({ inputsSha256: String(n).repeat(64), sourceCommit: "c".repeat(40), snapshotId: `${prefix}${String(n).repeat(16)}`,
    qualified: true, snapshotRequested: true, snapshotCreate: { phase: "acknowledged" }, builder: { id: `bx_${n}`, deleted: builderDeleted(n) } });
  state.resources.images = [1, 2, 3, 4, 5].map(image);
  state.resources.images.push({ purpose: "native-agent-qualification", agentQualificationId: "11111111-1111-4111-8111-111111111111" });
  const snapshots = new Map(state.resources.images.filter((r: any) => r.snapshotId).map((r: any) => [r.snapshotId, { name: r.snapshotId, sourceSandboxId: r.builder.id, status: "ready" }]));
  const request = vi.fn(async (method: string, route: string) => {
    const name = route.split("/").pop()!;
    if (method === "GET") return snapshots.has(name) ? { status: 200, body: { snapshot: snapshots.get(name) } } : { status: 404 };
    if (method === "DELETE") { snapshots.delete(name); return { status: 200, body: { type: "snapshot.named.deleted", name, status: "deleted" } }; }
    throw new Error(`unexpected ${method} ${route}`);
  });
  return { state, lease: { state, save: vi.fn(), fence: vi.fn() }, request, snapshots, name: (n: number) => `${prefix}${String(n).repeat(16)}` };
}

it("retires a live generation's superseded images but keeps the deployed image and the newest other one", async () => {
  // Each worker-source change adds a named snapshot; without retirement a
  // long-lived generation fills the account's capacity and blocks builds.
  const t = generation();
  const retired = await retireSupersededDevImages(t.lease, profile, { keepInputs: ["2".repeat(64)], request: t.request });
  expect(retired).toEqual([t.name(1), t.name(3), t.name(4)]);
  expect([...t.snapshots.keys()]).toEqual([t.name(2), t.name(5)]);
  for (const n of [1, 3, 4]) expect(t.state.resources.images[n - 1]).toMatchObject({ snapshotDeleted: true, snapshotRetirementReason: "superseded" });
  expect(t.state.resources.images[1].snapshotDeleted).toBeUndefined();
});

it("never retires an image whose builder is not confirmed deleted", async () => {
  const t = generation(n => n !== 3);
  expect(await retireSupersededDevImages(t.lease, profile, { keepInputs: ["2".repeat(64)], request: t.request })).toEqual([t.name(1), t.name(4)]);
  expect(t.snapshots.has(t.name(3))).toBe(true);
});

it("keeps everything when only the deployed image and one other exist", async () => {
  const t = generation();
  t.state.resources.images = t.state.resources.images.filter((r: any) => [t.name(4), t.name(5)].includes(r.snapshotId));
  expect(await retireSupersededDevImages(t.lease, profile, { keepInputs: ["4".repeat(64)], request: t.request })).toEqual([]);
  expect(t.request).not.toHaveBeenCalled();
});

it("retires legacy images saved before the create journal whose builders were retired with deferred storage", async () => {
  const t = generation();
  for (const record of t.state.resources.images.filter((r: any) => r.snapshotId)) {
    delete record.snapshotCreate;
    record.builder = { id: record.builder.id, retiredAt: new Date().toISOString(), deletionOperationId: `bdop_${"0".repeat(32)}` };
  }
  expect(await retireSupersededDevImages(t.lease, profile, { keepInputs: ["2".repeat(64)], request: t.request })).toEqual([t.name(1), t.name(3), t.name(4)]);
  expect([...t.snapshots.keys()]).toEqual([t.name(2), t.name(5)]);
});

it("preserves explicit rollback cleanup and its deployed fallback without a local snapshot ceiling", async () => {
  const t = generation();
  t.state.status = "ready";
  t.state.resources.images = t.state.resources.images.filter((r: any) => [t.name(4), t.name(5)].includes(r.snapshotId));
  for (const n of [1, 2, 3]) t.snapshots.delete(t.name(n));
  const selected = { ...profile, railway: { projectId: "project" }, planetscale: { organization: "org", database: "db" }, cloudflare: { accountId: "account" } };
  let current: any = null;
  const store = { list: async () => ({ records: [{ state: t.state }], quarantine: [] }),
    readAdmission: async () => current ? structuredClone(current) : null,
    writeAdmission: async (state: any) => { current = { state: structuredClone(state), etag: "revision" }; } };
  const releases = ["alpha", "beta", "production"].flatMap(channel => ["current", "rollback"].map(kind => `zeros-${channel}-${kind}`));
  const inventory = () => ["base", ...releases, "unrelated-retained", ...t.snapshots.keys()].map(id => ({ provider: "boat", id }));
  const snapshotName = t.name(6);
  await reserveHostedAdmission(store, t.state, selected);
  await expect(reserveHostedAdmission(store, t.state, selected, { kind: "builder", inventory: inventory(), snapshotName })).resolves.toMatchObject({ snapshotName });

  await retireSupersededDevImages(t.lease, selected, { keepInputs: ["5".repeat(64)], keepRollback: false, request: t.request });
  await releaseHostedAdmission(store, t.lease, selected);
  await expect(reserveHostedAdmission(store, t.state, selected, { kind: "builder", inventory: inventory(), snapshotName })).resolves.toMatchObject({ snapshotName });
  expect([...t.snapshots.keys()]).toEqual([t.name(5)]);
  expect(t.state.resources.images[1].snapshotDeleted).toBeUndefined();
  expect(t.request.mock.calls.filter(([method]) => method === "DELETE").map(([, route]) => route)).toEqual([`/named-snapshots/${t.name(4)}`]);
});
