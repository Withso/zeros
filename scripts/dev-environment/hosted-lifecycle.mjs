import { randomUUID } from "node:crypto";
import { bindHostedProfile, newHostedGeneration } from "./hosted-state.mjs";

/** Provider adapters must persist intent before dispatch and prove exact
 * ownership on every mutation. No successful DELETE response alone completes
 * a step. This coordinator deliberately keeps the database journal until all
 * worker and upload outcomes have been reconciled. */
export async function archiveHosted(lease, profile, services) {
  const state = lease.state;
  await services.reconcileRetiredBuilders?.(lease);
  if (state.status === "archived") return { archived: true, delayedImageStorageRemoval: Boolean(state.retiredImages?.length || state.pendingBuilderDeletions?.length) };
  bindHostedProfile(state, profile);
  state.status = "archiving"; state.archiveRequestedAt ??= new Date().toISOString(); await lease.save();
  const steps = [
    ["backendStopped", "stopBackend"], ["railwayDeleted", "deleteBackend"],
    ["workersDeleted", "deleteWorkers"], ["imagesRetired", "deleteImages"],
    ["webDeleted", "deleteWeb"], ["webhookDeleted", "deleteWebhook"],
    ["objectsDeleted", "deleteObjects"], ["databaseDeleted", "deleteDatabase"],
  ];
  for (const [step, action] of steps) {
    if (state.steps[step]) continue;
    await lease.fence(); await services[action](lease); state.steps[step] = true; await lease.save();
  }
  state.status = "archived"; state.archivedAt = new Date().toISOString();
  state.retiredImages = (state.resources.images ?? []).filter(r => r.snapshotRetiredAt)
    .map(r => ({ name: r.snapshotId, retiredAt: r.snapshotRetiredAt, backingStorage: "provider-managed-delayed-removal" }));
  const pending = new Map((state.pendingBuilderDeletions ?? []).map(r => [r.deletionOperationId, r]));
  for (const image of state.resources.images ?? []) {
    const builder = image.builder;
    if (builder?.retiredAt && !builder.deleted) pending.set(builder.deletionOperationId, {
      ...builder, accountScope: profile.boat.accountScope, billingOrg: profile.boat.billingOrg,
    });
  }
  state.pendingBuilderDeletions = [...pending.values()];
  delete state.keys; delete state.backendVariables; delete state.source; delete state.runId;
  // Remove credentials, retain only non-secret destruction evidence.
  state.resources = {};
  await lease.save();
  return { archived: true, delayedImageStorageRemoval: state.retiredImages.length > 0 || state.pendingBuilderDeletions.length > 0 };
}

export async function startHosted(lease, identity, profile, services) {
  const state = lease.state;
  if (state.status === "archiving") throw new Error("Dev archive is incomplete. Run pnpm dev:archive to finish cleanup before launching again.");
  if (state.status === "archived") {
    const next = newHostedGeneration(identity, state);
    const lock = state.lease;
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next, { lease: lock });
  }
  bindHostedProfile(state, profile); await lease.save();
  // Read-only permission checks and the source build happen before allocating
  // a database or service. A worker build has its own durable create ledger.
  await services.preflight(lease);
  const source = await services.captureSource(lease);
  if (state.status === "ready" && state.source?.sourceSha256 === source.sourceSha256) {
    try { await services.verify(lease, source); return { reused: true, source }; }
    catch {
      lease.signal?.throwIfAborted();
      // Reconcile the exact recorded resources below; never replace the owner
      // or database merely because its deployment stopped or became unhealthy.
      state.status = "provisioning"; await lease.save();
    }
  }
  state.status = "provisioning";
  state.runId = randomUUID(); await lease.save();
  const worker = await services.ensureImage(lease, source);
  await services.ensureDatabase(lease);
  await services.ensureBackend(lease);
  await services.stopBackend(lease);
  await services.migrate(lease, source);
  await services.ensureWebhook(lease);
  await services.deployBackend(lease, source, worker);
  await services.deployWeb(lease, source);
  await services.verify(lease, source);
  state.source = { sourceSha256: source.sourceSha256, workerInputsSha256: source.workerInputsSha256, commit: source.commit };
  state.status = "ready"; await lease.save();
  return { reused: false, source };
}
