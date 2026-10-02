import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { privateDirectory, writePrivateFile } from "./state.mjs";
import { providerJson, pollProvider, DevProviderError, dispatchDevCreate, acknowledgeDevCreate } from "./provider-http.mjs";

export function devBoatClient(config, signal) {
  return (method, route, options = {}) => providerJson("Boat Dev", `https://boat.dev/api/v1${route}`, {
    method, signal, timeoutMs: options.timeoutMs ?? 65_000,
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const FILE = /^(?:builder(?:-intent)?\.json|[a-f0-9]{12}\/(?:[a-z-]+\.(?:json|sh)))$/;
function saveKitState(directory) {
  const files = {};
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    if (typeof entry !== "string" || !FILE.test(entry)) continue;
    const file = path.join(directory, entry), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error("Invalid Dev image receipt file");
    files[entry] = fs.readFileSync(file, "utf8");
  }
  const text = JSON.stringify(files);
  if (text.length > 1024 * 1024) throw new Error("Dev image receipt exceeds its budget");
  return gzipSync(text).toString("base64");
}
function restoreKitState(directory, packed) {
  if (!packed) return;
  const files = JSON.parse(gunzipSync(Buffer.from(packed, "base64"), { maxOutputLength: 1024 * 1024 }).toString());
  for (const [name, text] of Object.entries(files)) {
    if (!FILE.test(name) || typeof text !== "string") throw new Error("Invalid Dev image receipt path");
    if (name.includes("/")) privateDirectory(directory, name.split("/")[0]);
    writePrivateFile(path.join(directory, name), text);
  }
}

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

export function assertDevAllocationBacklog(state) {
  if ([...(state.pendingBuilderDeletions ?? []), ...(state.pendingWorkerDeletions ?? [])].filter(record => !record.deleted).length >= 100) {
    throw new Error("Too many Dev storage retirements remain pending; wait for provider cleanup before another launch");
  }
}

export async function assertDevBuilderBudget(lease, profile, record, request) {
  if (!Number.isFinite(record.maxUsedHours)) throw new Error("Dev builder budget is missing");
  const response = await request("GET", `/limits?org=${encodeURIComponent(profile.boat.billingOrg)}`);
  const used = response.body?.creditUsedSeconds;
  if (response.status !== 200 || !Number.isFinite(used)) throw new Error("Dev builder meter is unavailable; no further build commands were dispatched");
  if (record.budgetExceeded || used / 3600 >= record.maxUsedHours) {
    record.budgetExceeded = true; await lease.save();
    if (record.builder && !record.builder.deleted) await confirmBoatDeletion(lease, record.builder, request, { allowDeferredStorage: true });
    throw new Error("Dev builder budget was reached; archive this generation before starting another build");
  }
}

export async function verifyDevImage(record, profile, request = devBoatClient(profile.boat)) {
  if (!record?.qualified || record.deleted || record.snapshotDeleted) throw new Error("Dev worker image is not qualified");
  const r = await request("GET", `/named-snapshots/${record.snapshotId}`), snapshot = r.body?.snapshot;
  if (r.status !== 200 || snapshot?.name !== record.snapshotId || snapshot.sourceSandboxId !== record.builder?.id || snapshot.status !== "ready") throw new Error("The qualified Dev worker snapshot is unavailable or changed");
}

/** Uses the release image kit, including native attestation and sanitation.
 * Its private local recovery files are encrypted in the shared Dev registry
 * before every provider mutation, so a cloud archive can clean a Mac build. */
export async function ensureDevImage(lease, profile, source, stateDirectory, artifacts, { progress = () => {} } = {}) {
  source = { ...source.worker, workerInputsSha256: source.workerInputsSha256 };
  const builds = lease.state.resources.images ??= [];
  let record = builds.find(r => r.inputsSha256 === source.workerInputsSha256 && !r.deleted);
  const raw = devBoatClient(profile.boat, lease.signal);
  if (record?.qualified) {
    await verifyDevImage(record, profile, raw);
    if (!record.builder.deleted) await confirmBoatDeletion(lease, record.builder, raw, { allowDeferredStorage: true });
    return record;
  }
  if (!record) {
    assertDevAllocationBacklog(lease.state);
    record = { inputsSha256: source.workerInputsSha256, sourceCommit: source.commit,
      snapshotId: `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-${source.workerInputsSha256.slice(0, 16)}` };
    builds.push(record); await lease.save();
  }
  if (record.sourceCommit !== source.commit) throw new Error("Finish or archive the pending Dev image build before changing its source");
  // Remote Archive cannot remove another device's local kit files. Identical
  // source inputs in a new generation must never adopt that retired builder.
  // Pending legacy builds restore their relative files from the authenticated
  // registry receipt below; keep older directories intact for their owner.
  const generationDirectory = privateDirectory(privateDirectory(stateDirectory, "images"), lease.state.generation);
  const directory = privateDirectory(generationDirectory, source.workerInputsSha256);
  restoreKitState(directory, record.files);
  if (!record.builder && ["planned", "rejected"].includes(record.builderCreate?.phase)) {
    fs.rmSync(path.join(directory, "builder-intent.json"), { force: true }); delete record.builderIntent;
  }
  if (record.snapshotRequested && ["planned", "rejected"].includes(record.snapshotCreate?.phase)) {
    fs.rmSync(path.join(directory, source.commit.slice(0, 12), "snapshot-ledger.json"), { force: true });
    record.snapshotRequested = false;
  }
  const kit = await import(pathToFileURL(path.join(source.directory, "scripts/cloud-workspace-validation/boat-image/boat-image.ts")));
  const config = await import(pathToFileURL(path.join(source.directory, "scripts/cloud-workspace-validation/config.ts")));
  const persist = async () => { record.files = saveKitState(directory); await lease.save(); };
  const deps = { repoRoot: source.directory, stateDir: directory, billingOrg: profile.boat.billingOrg, now: Date.now,
    randomUUID, randomHex: () => randomBytes(16).toString("hex"), imageContract: config.imageContractSha256,
    boat: async (method, route, options = {}) => {
      await persist(); await lease.fence();
      const hadBuilderIntent = Boolean(record.builderIntent);
      if (method === "POST" && route === "/sandboxes") {
        record.builderIntent ??= { body: options.body, key: options.headers?.["idempotency-key"], at: Date.now() }; await lease.save();
      }
      if (method === "POST" && route === "/named-snapshots") { record.snapshotRequested = true; await lease.save(); }
      const key = method === "POST" && route === "/sandboxes" ? "builderCreate" : method === "POST" && route === "/named-snapshots" ? "snapshotCreate" : null;
      const dispatch = async () => {
        const result = await raw(method, route, options);
        if (key && result.status >= 300) throw new DevProviderError("Boat Dev", result.status, result.requestId);
        if (key === "builderCreate") {
          if (!/^bx_[a-z0-9]+$/.test(result.body?.sandbox?.id ?? "")) throw new Error("Unconfirmed Dev builder response");
          record.builder = { id: result.body.sandbox.id }; await lease.save();
        }
        return result;
      };
      if (!key) return dispatch();
      const intent = record.builderIntent;
      const idempotentReplay = key === "builderCreate" && hadBuilderIntent && typeof intent?.key === "string" && intent.key === options.headers?.["idempotency-key"] &&
        JSON.stringify(intent.body) === JSON.stringify(options.body) && Date.now() - intent.at < 23 * 3600_000;
      return dispatchDevCreate(lease, record, "Boat Dev", dispatch, { key, idempotentReplay });
    } };
  const call = async args => {
    await assertDevBuilderBudget(lease, profile, record, raw);
    try { const result = await kit.main(args, deps); await persist(); return result; }
    catch (error) {
      await persist();
      // These are fixed image-kit messages, never provider response bodies.
      const capacity = /^The account already holds [0-9]{1,6} named snapshots; delete an unused one first$/.test(error?.message ?? "");
      throw new Error(capacity
        ? "Dev worker build did not complete: Boat named snapshot limit reached. Retire an unused Dev image after verifying its workspace references, then retry. The build and recovery receipts are retained."
        : "Dev worker build did not complete. Its encrypted recovery receipts were retained; retry launch or run pnpm dev:archive.");
    }
  };
  const dir = path.join(directory, source.commit.slice(0, 12));
  if (!record.maxUsedHours) {
    const response = await raw("GET", `/limits?org=${encodeURIComponent(profile.boat.billingOrg)}`);
    const used = response.body?.creditUsedSeconds;
    if (response.status !== 200 || !Number.isFinite(used)) throw new Error("Boat Dev build budget could not be checked");
    record.maxUsedHours = used / 3600 + profile.boat.builderBudgetHours; await lease.save();
  }
  if (!fs.existsSync(path.join(directory, "builder.json"))) await call(["builder", "create", "--from", profile.boat.baseSnapshot, "--max-used-hours", String(record.maxUsedHours)]);
  progress("Waiting for the owned cloud image builder to start");
  await pollProvider("Dev image builder startup", async () => {
    const result = await call(["builder", "status"]);
    if (result.wallet !== "billing-org") throw new Error("Dev image builder billing identity changed");
    return ["ready", "idle", "running"].includes(result.state);
  }, { signal: lease.signal, timeout: 300_000, interval: 5000 });
  if (!fs.existsSync(path.join(dir, "source.tar.gz"))) {
    if (record.sourceArchive) {
      fs.writeFileSync(path.join(dir, "source.tar.gz"), await artifacts.readImageSource(lease.state, record), { mode: 0o600 });
    } else {
      if (record.buildStarted) throw new Error("The pending worker build is missing its original archive receipt; archive before rebuilding");
      fs.rmSync(path.join(dir, "source.json"), { force: true }); await call(["export"]);
    }
  }
  if (!record.sourceArchive) await artifacts.saveImageSource(lease, record, fs.readFileSync(path.join(dir, "source.tar.gz")));
  if (!fs.existsSync(path.join(dir, "generation.json"))) {
    const previous = JSON.parse(await call(["builder", "run", path.join(kit.TEMPLATES, "build-hash.sh")]));
    await call(["generate", "--previous", previous.commit]);
    const file = path.join(dir, "generation.json"), generation = JSON.parse(fs.readFileSync(file, "utf8"));
    generation.snapshotName = record.snapshotId; writePrivateFile(file, JSON.stringify(generation)); await persist();
  }
  if (!record.buildStarted) {
    progress("Uploading the captured worker source and starting its native build");
    await call(["builder", "run", path.join(dir, "builder-preflight.sh")]); await call(["builder", "upload"]);
    record.buildStarted = true; await lease.save();
    await call(["builder", "run", path.join(dir, "install.sh"), "120"]);
  }
  progress("Waiting for the native worker build to finish");
  await pollProvider("Dev native worker build", async () => {
    const status = JSON.parse(await call(["builder", "run", path.join(dir, "build-status.sh")]));
    if (status.result && !status.result.passed) throw new Error("Dev native worker build failed; retry after inspecting its private build receipt");
    return status.result?.passed === true;
  }, { signal: lease.signal, timeout: 25 * 60_000, interval: 10_000 });
  progress("Verifying the worker isolation and runtime attestation");
  if (!record.attestationStarted) { record.attestationStarted = true; await lease.save(); await call(["attestation", "start"]); }
  const attestation = await pollProvider("Dev worker attestation", async () => {
    const result = await call(["attestation", "status"]);
    if (!result.finished) return false;
    if (!result.qualified || !result.matchesCommit || !Number.isSafeInteger(result.measuredStorageMiB)) throw new Error("Dev worker native attestation did not qualify");
    return result;
  }, { signal: lease.signal, timeout: 20 * 60_000, interval: 10_000 });
  if (!fs.existsSync(path.join(dir, "sanitize.sh"))) await call(["generate-post"]);
  progress("Publishing the qualified worker snapshot");
  if (!record.snapshotRequested || ["planned", "rejected"].includes(record.snapshotCreate?.phase)) await call(["snapshot", "save"]);
  await pollProvider("Dev worker snapshot", async () => (await call(["snapshot", "status"])).state === "ready", { signal: lease.signal, timeout: 600_000, interval: 5000 });
  Object.assign(record, { qualified: true, buildSha256: attestation.buildSha256, storageMiB: attestation.measuredStorageMiB }); await lease.save();
  await confirmBoatDeletion(lease, record.builder, raw, { allowDeferredStorage: true });
  delete record.files; await lease.save();
  return record;
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

/** A live generation keeps its deployed worker image and the newest other
 * qualified image for rollback. Each older one only consumes the account's
 * named-snapshot capacity, so a long-lived checkout would eventually block
 * every build. A replacement build can release the older rollback slot while
 * retaining the deployed image as its fallback. Only images whose builders are
 * stopped are retired; unconfirmed names stay for archive or reconcile. */
export async function retireSupersededDevImages(lease, profile, { keepInputs = [], keepRollback = true, request = devBoatClient(profile.boat, lease.signal), polling = {} } = {}) {
  const owned = `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-`;
  // Qualified images predating the create journal have no snapshotCreate.
  const live = (lease.state.resources.images ?? []).filter(record => !record.deleted && record.qualified && !record.snapshotDeleted &&
    record.snapshotRequested && !["planned", "rejected"].includes(record.snapshotCreate?.phase) && record.snapshotId?.startsWith(owned));
  const keep = new Set(live.filter(record => keepInputs.includes(record.inputsSha256)));
  const newest = [...live].reverse().find(record => !keep.has(record));
  if (newest && (keepRollback || !keep.size)) keep.add(newest);
  const retired = [];
  for (const record of live) {
    // Deferred-storage retirement records retiredAt rather than deleted.
    if (keep.has(record) || !(record.builder?.deleted === true || record.builder?.retiredAt)) continue;
    try { await deleteDevSnapshot(lease, record, request, polling); }
    catch (error) { if (lease.signal?.aborted) throw error; continue; }
    record.snapshotRetirementReason = "superseded"; await lease.save();
    retired.push(record.snapshotId);
  }
  return retired;
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
