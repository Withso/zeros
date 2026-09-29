import { expect, it, vi } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { retireSupersededDevImages } from "../dev-environment/hosted-image.mjs";

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
