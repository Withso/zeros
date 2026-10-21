// Cleanup-only compatibility for encrypted Dev receipts recorded before v2.
// New launches never build or qualify these images; archive still owns them.
import { devBoatClient } from "./boat.mjs";
import { pollProvider, DevProviderError, dispatchDevCreate, acknowledgeDevCreate } from "./provider-http.mjs";

export async function confirmBoatDeletion(lease, record, request, { allowDeferredStorage = false, beforeDeleted, beforeDeferredStorage, retainedDeferredStorage, ...polling } = {}) {
  if (record.deleted) return;
  if (!/^bx_[a-z0-9]+$/.test(record.id ?? "")) throw new Error("Dev builder allocation is unconfirmed; retain its receipt");
  if (!record.deletionOperationId) {
    record.deleteRequested = true; await lease.save(); await lease.fence();
    const response = await request("DELETE", `/sandboxes/${record.id}`, { headers: { "x-ascii-confirm-delete": record.id } });
    const operation = response.body?.operation;
    if (response.status >= 300 || operation?.kind !== "sandbox" || operation.targetId !== record.id || !/^bdop_[a-f0-9]{32}$/.test(operation.id ?? "")) throw new Error("Dev builder deletion is unconfirmed; a 404 alone does not prove deletion");
    record.deletionOperationId = operation.id; await lease.save();
  }
  let completedOperation;
  const result = await pollProvider("Dev builder physical deletion", async () => {
    const response = await request("GET", `/deletion-operations/${record.deletionOperationId}`), op = response.body?.operation;
    const operationObservedAt = new Date().toISOString();
    if (response.status !== 200 || op?.id !== record.deletionOperationId || op.targetId !== record.id || op.kind !== "sandbox") throw new Error("Dev builder deletion proof changed");
    if (allowDeferredStorage && (op.status === "blocked" &&
        ["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"].includes(op.stage) &&
        (op.stage !== "waiting_for_uploads" || Number.isFinite(Date.parse(op.expectedBy))) || retainedDeferredStorage?.(op) === true)) {
      // These documented stages describe irreversible storage retirement.
      // Tenant-worker lifecycle stays strict. Dev archive may transfer a
      // verified retirement receipt only after its entire backend is gone.
      // An absent sandbox by itself is never sufficient proof.
      const sandbox = await request("GET", `/sandboxes/${record.id}`);
      if (sandbox.status !== 404) throw new Error("The retired Dev builder is not confirmed unavailable");
      await beforeDeferredStorage?.(op, { operationObservedAt, unavailableObservedAt: new Date().toISOString() });
      record.retiredAt ??= new Date().toISOString();
      record.deletionStage = op.stage; record.deletionExpectedBy = op.expectedBy ?? null;
      await lease.save(); return "storage-pending";
    }
    if (op.status === "blocked") throw new Error("Boat blocked Dev builder deletion; retain the operation receipt for retry");
    if (op.status === "completed" && typeof op.completedAt === "string" && Number.isFinite(Date.parse(op.completedAt))) {
      completedOperation = op; return "completed";
    }
    return false;
  }, { signal: lease.signal, timeout: 300_000, ...polling });
  if (result === "completed") { await beforeDeleted?.(completedOperation); record.deleted = true; await lease.save(); }
}

export async function reconcileRetiredBuilders(lease, profile, request, { maxRecords = 16, budgetMs = 15_000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100 || !Number.isFinite(budgetMs) || budgetMs < 1) throw new Error("Invalid Dev retention budget");
  const deadline = now() + budgetMs;
  const signal = AbortSignal.any([...(lease.signal ? [lease.signal] : []), AbortSignal.timeout(budgetMs)]);
  request ??= devBoatClient(profile.boat, signal);
  const builders = lease.state.pendingBuilderDeletions ?? [], workers = lease.state.pendingWorkerDeletions ?? [];
  const pending = [...builders, ...workers].filter(record => !record.deleted)
    .sort((a, b) => (Date.parse(a.lastReconcileAt) || 0) - (Date.parse(b.lastReconcileAt) || 0));
  let attempted = 0;
  for (const record of pending) {
    if (attempted >= maxRecords || now() >= deadline) break;
    if (Date.parse(record.retryAfter) > now()) continue;
    attempted++;
    record.lastReconcileAt = new Date(now()).toISOString();
    try {
      if (workers.includes(record) && (record.devOwner !== lease.state.owner ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.devGeneration ?? "") ||
          !/^[a-f0-9-]{36}$/.test(record.workspaceId ?? "") || !Number.isSafeInteger(record.generation) || record.generation < 1)) throw new Error("Invalid worker retention ownership");
      if (record.accountScope !== profile.boat.accountScope || record.billingOrg !== profile.boat.billingOrg ||
          !record.retiredAt || !/^bdop_[a-f0-9]{32}$/.test(record.deletionOperationId ?? "")) throw new Error("Invalid builder retention ownership");
      // One observation per pass, never minutes of polling each old receipt.
      await confirmBoatDeletion(lease, record, request, { allowDeferredStorage: true, timeout: 0, signal });
      delete record.reconcileUnconfirmed; delete record.retryAfter;
    } catch {
      record.reconcileUnconfirmed = true;
      record.reconcileAttempts = (record.reconcileAttempts ?? 0) + 1;
      record.retryAfter = new Date(now() + Math.min(3600_000, 30_000 * 2 ** Math.min(record.reconcileAttempts, 7))).toISOString();
    }
    await lease.save();
  }
  lease.state.pendingBuilderDeletions = builders.filter(record => !record.deleted);
  lease.state.pendingWorkerDeletions = workers.filter(record => !record.deleted);
  await lease.save();
  if (pending.some(record => record.reconcileUnconfirmed)) throw new Error("Dev storage retention is unconfirmed; saved retries will continue without blocking other owners");
}

export async function reconcileDevImageCreates(lease, profile, request = devBoatClient(profile.boat, lease.signal)) {
  for (const record of lease.state.resources.images ?? []) {
    if (record.deleted) continue;
    const canary = record.purpose === "native-agent-qualification" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.agentQualificationId ?? "") &&
      record.snapshotId === undefined && !record.snapshotRequested && record.builderIntent?.key === record.agentQualificationId;
    if (!canary && !record.snapshotId?.startsWith(`dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-`)) throw new Error("Invalid Dev image recovery ownership");
    if (record.builderIntent && !record.builder && !["planned", "rejected"].includes(record.builderCreate?.phase)) {
      const intent = record.builderIntent;
      if (typeof intent.key !== "string" || !intent.body || !Number.isFinite(intent.at) || Date.now() < intent.at || Date.now() - intent.at >= 23 * 3600_000) throw new Error("Dev builder remains unconfirmed outside its idempotency window; retain provider request evidence");
      await dispatchDevCreate(lease, record, "Boat Dev", async () => {
        const result = await request("POST", "/sandboxes", { body: intent.body, headers: { "idempotency-key": intent.key, "x-boat-org": profile.boat.billingOrg } });
        if (result.status >= 300) throw new DevProviderError("Boat Dev", result.status, result.requestId);
        if (!/^bx_[a-z0-9]+$/.test(result.body?.sandbox?.id ?? "")) throw new Error("Dev builder remains unconfirmed");
        record.builder = { id: result.body.sandbox.id }; await lease.save();
      }, { key: "builderCreate", idempotentReplay: true });
    }
    if (!record.snapshotRequested || record.snapshotDeleted || ["planned", "rejected"].includes(record.snapshotCreate?.phase)) continue;
    const result = await request("GET", `/named-snapshots/${record.snapshotId}`), snapshot = result.body?.snapshot;
    // A historical qualified name can be pruned by an operator. Close only
    // its name record after durable proof that no writer/worker remains. An
    // uncertain create or accessible builder still cannot be closed by a 404.
    if (result.status === 404 && lease.state.status === "archiving" && lease.state.steps.backendStopped &&
        lease.state.steps.railwayDeleted && lease.state.steps.workersDeleted && record.qualified &&
        /^[a-f0-9]{64}$/.test(record.buildSha256 ?? "") && record.builder?.deleted === true &&
        /^bdop_[a-f0-9]{32}$/.test(record.builder.deletionOperationId ?? "") &&
        (!record.snapshotCreate || record.snapshotCreate.phase === "acknowledged")) {
      record.snapshotDeleted = true; record.snapshotRetiredAt = new Date().toISOString();
      record.snapshotRetirementReason = "externally-pruned-after-shutdown"; await lease.save(); continue;
    }
    if (result.status !== 200 || snapshot?.name !== record.snapshotId || snapshot.sourceSandboxId !== record.builder?.id) throw new Error("Dev snapshot remains unconfirmed; absence does not authorize another save");
    await acknowledgeDevCreate(lease, record, "snapshotCreate");
  }
}

/** Deletes one owned named snapshot and waits until its name is gone. */
async function deleteDevSnapshot(lease, record, request, polling) {
  const route = `/named-snapshots/${record.snapshotId}`, response = await request("GET", route), s = response.body?.snapshot;
  if (response.status === 404 && !record.snapshotDeleteRequested) throw new Error("An unconfirmed Dev snapshot save needs reconciliation");
  if (response.status !== 404) {
    if (response.status !== 200 || s?.name !== record.snapshotId || s.sourceSandboxId !== record.builder?.id || !record.snapshotId.startsWith(`dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-`)) throw new Error("Dev snapshot ownership changed");
    if (!["ready", "failed", "error"].includes(s.status)) throw new Error("Dev snapshot save is still running; retry archive when it settles");
    record.snapshotDeleteRequested = true; await lease.save(); await lease.fence();
    const deleted = await request("DELETE", route);
    if (deleted.status !== 404 && (deleted.status !== 200 || deleted.body?.type !== "snapshot.named.deleted" ||
        deleted.body.name !== record.snapshotId || deleted.body.status !== "deleted")) throw new DevProviderError("Boat Dev snapshot deletion", deleted.status);
  }
  await pollProvider("Dev named snapshot deletion", async () => {
    const r = await request("GET", route); if (r.status !== 200 && r.status !== 404) throw new DevProviderError("Boat Dev snapshot inventory", r.status); return r.status === 404;
  }, { signal: lease.signal, ...polling });
  record.snapshotDeleted = true;
  // The provider removes the name immediately but retains backing data for
  // at least six hours to expire signed upload URLs. Do not label absence
  // of the name as physical storage deletion or hold the DB for that GC.
  record.snapshotRetiredAt = new Date().toISOString(); await lease.save();
}

export async function deleteDevImages(lease, profile, request = devBoatClient(profile.boat, lease.signal), polling = {}) {
  for (const record of lease.state.resources.images ?? []) {
    if (record.deleted) continue;
    if (record.builderIntent && !record.builder && !["planned", "rejected"].includes(record.builderCreate?.phase)) {
      if (Date.now() - record.builderIntent.at > 23 * 3600_000) throw new Error("Unconfirmed Dev builder is outside Boat's idempotency window; reconcile it before deleting its receipt");
      await lease.fence();
      const r = await request("POST", "/sandboxes", { body: record.builderIntent.body,
        headers: { "idempotency-key": record.builderIntent.key, "x-boat-org": profile.boat.billingOrg } });
      if (r.status >= 300 || !/^bx_[a-z0-9]+$/.test(r.body?.sandbox?.id ?? "")) throw new Error("Dev builder allocation still needs reconciliation");
      record.builder = { id: r.body.sandbox.id }; await lease.save();
    }
    if (record.snapshotRequested && !record.snapshotDeleted && !["planned", "rejected"].includes(record.snapshotCreate?.phase))
      await deleteDevSnapshot(lease, record, request, polling);
    if (record.builder) await confirmBoatDeletion(lease, record.builder, request, { ...polling, allowDeferredStorage: true });
    record.retired = true; record.deleted = !record.builder || record.builder.deleted === true;
    delete record.files; await lease.save();
  }
}
