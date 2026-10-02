import { admissionPolicy, releaseHostedAdmission, reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { requireCheck, type Channel } from "./contracts";
import { workerOwner } from "./worker-owner";
export { workerOwner, workerSnapshotName } from "./worker-owner";
import { protectedBoatSnapshotCapacity } from "../../apps/control-plane/src/cloud-workspaces/boat-account-admission";
import { settleWorkerNamedRetirement } from "./worker-named-retirement";

export const WORKER_SNAPSHOT_BUDGET = { limit: 10 } as const;
type Snapshot = { provider: string; id: string };
export function assertWorkerSnapshotSlots(channel: Channel, candidate: string, profile: any, inventory: Snapshot[], reservations: any[]) {
  const policy = admissionPolicy(profile);
  requireCheck(policy.maxNamedSnapshots === WORKER_SNAPSHOT_BUDGET.limit &&
    policy.maxBuilders === 1 && policy.maxBuildersPerOwner === 1, "Worker shared-account slot and builder policy is invalid");
  const names = new Set(inventory.filter(row => row.provider === "boat").map(row => row.id));
  requireCheck(names.has(profile.boat.baseSnapshot), "Worker snapshot inventory must confirm the protected base");
  requireCheck([...names].every(name => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)), "Worker snapshot inventory contains an invalid slot");
  for (const row of reservations) if (row.kind === "builder" && row.snapshotName && !row.snapshotReleasedAt) names.add(row.snapshotName);
  names.add(candidate);
  const belongs = (name: string, owner: Channel) => name.startsWith(`dev-${workerOwner(owner)}-`) || name.startsWith(`zeros-${owner}-`);
  requireCheck(names.size <= policy.maxNamedSnapshots, "Worker named snapshot capacity is reserved; no build may start");
  requireCheck(belongs(candidate, channel), "Worker candidate slot belongs to another channel");
  protectedBoatSnapshotCapacity(profile, inventory.filter(row => row.provider === "boat").map(row => row.id), reservations, candidate);
  return { used: names.size, headroom: policy.snapshotHeadroom, limit: policy.maxNamedSnapshots };
}
export async function reserveWorkerSlot(store: any, lease: any, profile: any, channel: Channel, snapshotName: string, inventory: Snapshot[]) {
  const guarded = { list: (...args: any[]) => store.list(...args), readAdmission: () => store.readAdmission(),
    writeAdmission: async (ledger: any, etag: string) => {
      assertWorkerSnapshotSlots(channel, snapshotName, profile, inventory, ledger.reservations);
      return store.writeAdmission(ledger, etag);
    } };
  const options: any = { kind: "builder", snapshotName, inventory };
  return reserveHostedAdmission(guarded, lease.state, profile, options);
}
export async function reconcileWorkerSnapshotHolds(store: any, lease: any, profile: any, inventory: Snapshot[], request: any) {
  const state = lease.state, names = new Set(inventory.filter(row => row.provider === "boat").map(row => row.id));
  requireCheck(names.has(profile.boat.baseSnapshot) && names.size === inventory.filter(row => row.provider === "boat").length,
    "Worker snapshot retirement requires complete protected-base inventory");
  const images = state.resources.images ?? [];
  const named = (image: any) => image.snapshotNameRetirement !== undefined || image.snapshotRetirementReview !== undefined ||
    image.snapshotDeleteIntent !== undefined && image.snapshotDeleteIntent?.version !== 1;
  for (const image of images.filter(named)) {
    // An explicit reviewed action settles only its exact reservation. Leave the
    // unchanged physical-only reconciliation to a subsequent ordinary pass.
    if (await settleWorkerNamedRetirement(store, lease, profile, image, inventory, request)) return;
  }
  const proven = (image: any) => !named(image) && image.purpose === "release-worker" && image.qualified === true && image.snapshotRequested === true &&
    image.snapshotId?.startsWith(`dev-${state.owner}-${state.generation.slice(0, 8)}-`) && image.snapshotCreate?.phase === "acknowledged" &&
    image.builder?.deleted === true && /^bx_[a-z0-9]+$/.test(image.builder.id ?? "") && /^bdop_[a-f0-9]{32}$/.test(image.builder.deletionOperationId ?? "") &&
    image.candidate?.snapshotId === image.snapshotId && image.candidate.sourceCommit === image.sourceCommit &&
    image.candidate.buildSha256 === image.buildSha256 && /^[a-f0-9]{40}$/.test(image.sourceCommit ?? "") && /^[a-f0-9]{64}$/.test(image.buildSha256 ?? "");
  for (const image of images.filter(proven)) {
    if (image.snapshotDeleted || names.has(image.snapshotId)) continue;
    await lease.fence();
    const response = await request("GET", `/named-snapshots/${encodeURIComponent(image.snapshotId)}`);
    requireCheck(response.status === 404, "Worker snapshot inventory disagrees with exact retirement readback; retain its admission hold");
    image.snapshotDeleted = true; image.snapshotRetiredAt = new Date().toISOString();
    image.snapshotRetirementReason = "externally-pruned-after-builder-cleanup"; await lease.save();
  }
  if (images.some((image: any) => proven(image) && image.snapshotDeleted)) await releaseHostedAdmission(store, lease, profile);
}
