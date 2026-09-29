import { randomUUID } from "node:crypto";
import { bindHostedProfile, newHostedGeneration, deploymentConfigFingerprint, recordArchiveIntent, bindHostedLifetime } from "./hosted-state.mjs";
import { assertHostedCleanupTargets } from "./hosted-protection.mjs";

/** Provider adapters must persist intent before dispatch and prove exact
 * ownership on every mutation. No successful DELETE response alone completes
 * a step. The database journal remains until worker/upload outcomes are either
 * complete or their verified irreversible retirement receipts are durably
 * transferred to the encrypted registry. */
export async function archiveHosted(lease, profile, services) {
  const state = lease.state;
  assertHostedCleanupTargets(state, profile);
  bindHostedProfile(state, profile);
  recordArchiveIntent(state, profile);
  if (state.status === "archived") {
    await lease.save();
    await services.releaseAdmission?.(lease);
    await services.reconcileRetiredBuilders?.(lease);
    return { archived: true, delayedImageStorageRemoval: Boolean(state.retiredImages?.length || state.pendingBuilderDeletions?.length || state.pendingWorkerDeletions?.length) };
  }
  state.status = "archiving"; state.archiveRequestedAt ??= new Date().toISOString(); await lease.save();
  const archiveHooks=[...(services.lifecycleHooks??[])];
  if((state.connectionRegistration||state.connectionRevocation?.pending||state.connectionServiceOrigin&&!state.connectionRevocation?.revokedAt)&&
    !archiveHooks.some(hook=>hook.name==='connections'&&hook.archive)){
    archiveHooks.push({name:'connections',archive:async()=>{throw new Error('Dev connection revocation requires its configured operator hook');}});
  }
  const failures = [];
  const attempt = async (step, action, dependencies = []) => {
    if (state.steps[step] || dependencies.some(key => !state.steps[key])) return;
    await lease.fence();
    try { await action(lease); }
    catch (error) {
      // Persist only fixed task identifiers, never provider response bodies.
      state.cleanupFailures ??= {};
      state.cleanupFailures[step] = { attempts: (state.cleanupFailures[step]?.attempts ?? 0) + 1, at: new Date().toISOString() };
      await lease.save(); failures.push(error); return;
    }
    state.steps[step] = true; delete state.cleanupFailures?.[step]; await lease.save();
  };
  // Compute shutdown must never wait for old storage or SSH-key retirement.
  await attempt("backendStopped", services.stopBackend);
  await attempt("railwayDeleted", services.deleteBackend, ["backendStopped"]);
  if (services.retireAgentAccess) await attempt("agentAccessRetired", services.retireAgentAccess);
  for (const hook of archiveHooks) {
    if (hook.archive) await attempt(`hook:${hook.name}:archived`, hook.archive);
  }
  const steps = [
    ["workersDeleted", "deleteWorkers", ["railwayDeleted"]], ["imagesRetired", "deleteImages", ["workersDeleted"]],
    ["webDeleted", "deleteWeb", []], ["webhookDeleted", "deleteWebhook", []],
    ["objectsDeleted", "deleteObjects", ["workersDeleted", "imagesRetired"]],
    ["databaseDeleted", "deleteDatabase", ["workersDeleted", "objectsDeleted", ...archiveHooks.filter(hook => hook.archive).map(hook => `hook:${hook.name}:archived`)]],
  ];
  for (const [step, action, dependencies] of steps) await attempt(step, services[action], dependencies);
  if (services.reconcileRetiredBuilders) {
    // Always retry historical evidence; it is independent of today's writers.
    delete state.steps.retentionReconciled;
    await attempt("retentionReconciled", services.reconcileRetiredBuilders);
  }
  if (failures.length) throw failures[0];
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
  delete state.agentQualifications;
  // Remove credentials, retain only non-secret destruction evidence.
  state.resources = {};
  await lease.save();
  await services.releaseAdmission?.(lease);
  return { archived: true, delayedImageStorageRemoval: state.retiredImages.length > 0 || state.pendingBuilderDeletions.length > 0 || Boolean(state.pendingWorkerDeletions?.length) };
}

export async function startHosted(lease, identity, profile, services) {
  const state = lease.state;
  if (state.status === "archiving") throw new Error("Dev archive is incomplete. Run pnpm dev:archive to finish cleanup before launching again.");
  if (state.status === "archived") {
    await services.releaseAdmission?.(lease);
    await lease.preserveGeneration?.();
    const next = newHostedGeneration(identity, state);
    const lock = state.lease;
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next, { lease: lock });
  }
  bindHostedProfile(state, profile); bindHostedLifetime(state, profile);
  if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) throw new Error("Dev maximum lifetime expired; archive before launching a fresh generation");
  state.lastUserActivityAt = new Date().toISOString(); await lease.save();
  // Read-only permission checks and the source build happen before allocating
  // a database or service. A worker build has its own durable create ledger.
  await services.preflight(lease);
  const source = await services.captureSource(lease);
  const configFingerprint = deploymentConfigFingerprint(state, profile);
  const sameDeployment = state.source?.sourceSha256 === source.sourceSha256 ||
    (typeof source.deploymentInputsSha256 === "string" && /^[a-f0-9]{64}$/.test(source.deploymentInputsSha256) &&
      state.source?.deploymentInputsSha256 === source.deploymentInputsSha256 &&
      state.source?.workerInputsSha256 === source.workerInputsSha256);
  if (state.status === "ready" && !(state.connectionRegistration && Date.parse(state.connectionRegistration.expiresAt) <= Date.now() + 6 * 3600000) && sameDeployment && state.configFingerprint?.version === configFingerprint.version && state.configFingerprint.digest === configFingerprint.digest) {
    // Verify what is actually deployed. A desktop-only edit changes the full
    // checkout fingerprint but must not stop/redeploy its unchanged backend.
    // Retain that deployment receipt so /healthz and the web commit stay exact.
    try { await services.verify(lease, { ...source, ...state.source }); return { reused: true, source }; }
    catch {
      lease.signal?.throwIfAborted();
      // Reconcile the exact recorded resources below; never replace the owner
      // or database merely because its deployment stopped or became unhealthy.
      state.status = "provisioning"; await lease.save();
    }
  }
  state.status = "provisioning";
  state.runId = randomUUID(); await lease.save();
  await services.reserveGeneration?.(lease);
  const worker = await services.ensureImage(lease, source);
  await services.ensureDatabase(lease);
  await services.ensureBackend(lease);
  await services.stopBackend(lease);
  await services.migrate(lease, source);
  await services.ensureWebhook(lease);
  for (const hook of services.lifecycleHooks ?? []) await hook.beforeDeploy?.(lease);
  await services.deployBackend(lease, source, worker);
  await services.deployWeb(lease, source);
  await services.verify(lease, source);
  await services.retireDatabaseCredentials?.(lease);
  state.configFingerprint = configFingerprint;
  state.source = { sourceSha256: source.sourceSha256, workerInputsSha256: source.workerInputsSha256, commit: source.commit,
    ...(source.deploymentInputsSha256 ? { deploymentInputsSha256: source.deploymentInputsSha256 } : {}) };
  state.status = "ready"; await lease.save();
  return { reused: false, source };
}
