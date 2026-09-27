import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { privateDirectory, writePrivateFile } from "./state.mjs";
import { providerJson, pollProvider, DevProviderError } from "./provider-http.mjs";

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

export async function confirmBoatDeletion(lease, record, request, { allowDeferredStorage = false, ...polling } = {}) {
  if (record.deleted) return;
  if (!/^bx_[a-z0-9]+$/.test(record.id ?? "")) throw new Error("Dev builder allocation is unconfirmed; retain its receipt");
  if (!record.deletionOperationId) {
    record.deleteRequested = true; await lease.save(); await lease.fence();
    const response = await request("DELETE", `/sandboxes/${record.id}`, { headers: { "x-ascii-confirm-delete": record.id } });
    const operation = response.body?.operation;
    if (response.status >= 300 || operation?.kind !== "sandbox" || operation.targetId !== record.id || !/^bdop_[a-f0-9]{32}$/.test(operation.id ?? "")) throw new Error("Dev builder deletion is unconfirmed; a 404 alone does not prove deletion");
    record.deletionOperationId = operation.id; await lease.save();
  }
  const result = await pollProvider("Dev builder physical deletion", async () => {
    const response = await request("GET", `/deletion-operations/${record.deletionOperationId}`), op = response.body?.operation;
    if (response.status !== 200 || op?.id !== record.deletionOperationId || op.targetId !== record.id || op.kind !== "sandbox") throw new Error("Dev builder deletion proof changed");
    if (allowDeferredStorage && op.status === "blocked" &&
        ["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"].includes(op.stage) &&
        (op.stage !== "waiting_for_uploads" || Number.isFinite(Date.parse(op.expectedBy)))) {
      // These documented stages describe irreversible storage retirement.
      // Only image builders may defer it; tenant-worker deletion stays strict.
      // An absent sandbox by itself is never sufficient proof.
      const sandbox = await request("GET", `/sandboxes/${record.id}`);
      if (sandbox.status !== 404) throw new Error("The retired Dev builder is not confirmed unavailable");
      record.retiredAt ??= new Date().toISOString();
      record.deletionStage = op.stage; record.deletionExpectedBy = op.expectedBy ?? null;
      await lease.save(); return "storage-pending";
    }
    if (op.status === "blocked") throw new Error("Boat blocked Dev builder deletion; retain the operation receipt for retry");
    return op.status === "completed" && typeof op.completedAt === "string" && Number.isFinite(Date.parse(op.completedAt)) ? "completed" : false;
  }, { signal: lease.signal, timeout: 300_000, ...polling });
  if (result === "completed") { record.deleted = true; await lease.save(); }
}

export async function reconcileRetiredBuilders(lease, profile, request = devBoatClient(profile.boat, lease.signal)) {
  const pending = lease.state.pendingBuilderDeletions ?? [];
  for (const record of pending) {
    if (record.accountScope !== profile.boat.accountScope || record.billingOrg !== profile.boat.billingOrg ||
        !record.retiredAt || !/^bdop_[a-f0-9]{32}$/.test(record.deletionOperationId ?? "")) throw new Error("Pending Dev builder storage belongs to a different provider account");
    await confirmBoatDeletion(lease, record, request, { allowDeferredStorage: true });
  }
  lease.state.pendingBuilderDeletions = pending.filter(record => !record.deleted);
  if (lease.state.pendingBuilderDeletions.length >= 100) throw new Error("Too many Dev builder storage retirements remain pending; wait for provider cleanup before another launch");
  await lease.save();
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

/** Uses the release image kit, including native attestation and sanitation.
 * Its private local recovery files are encrypted in the shared Dev registry
 * before every provider mutation, so a cloud archive can clean a Mac build. */
export async function ensureDevImage(lease, profile, source, stateDirectory, artifacts) {
  source = { ...source.worker, workerInputsSha256: source.workerInputsSha256 };
  const builds = lease.state.resources.images ??= [];
  let record = builds.find(r => r.inputsSha256 === source.workerInputsSha256 && !r.deleted);
  const raw = devBoatClient(profile.boat, lease.signal);
  if (record?.qualified) {
    const r = await raw("GET", `/named-snapshots/${record.snapshotId}`), s = r.body?.snapshot;
    if (r.status !== 200 || s?.name !== record.snapshotId || s.sourceSandboxId !== record.builder?.id || s.status !== "ready") throw new Error("The qualified Dev worker snapshot is unavailable or changed");
    if (!record.builder.deleted) await confirmBoatDeletion(lease, record.builder, raw, { allowDeferredStorage: true });
    return record;
  }
  if (!record) {
    record = { inputsSha256: source.workerInputsSha256, sourceCommit: source.commit,
      snapshotId: `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-${source.workerInputsSha256.slice(0, 16)}` };
    builds.push(record); await lease.save();
  }
  if (record.sourceCommit !== source.commit) throw new Error("Finish or archive the pending Dev image build before changing its source");
  const directory = privateDirectory(privateDirectory(stateDirectory, "images"), source.workerInputsSha256);
  restoreKitState(directory, record.files);
  const kit = await import(pathToFileURL(path.join(source.directory, "scripts/cloud-workspace-validation/boat-image/boat-image.ts")));
  const config = await import(pathToFileURL(path.join(source.directory, "scripts/cloud-workspace-validation/config.ts")));
  const persist = async () => { record.files = saveKitState(directory); await lease.save(); };
  const deps = { repoRoot: source.directory, stateDir: directory, billingOrg: profile.boat.billingOrg, now: Date.now,
    randomUUID, randomHex: () => randomBytes(16).toString("hex"), imageContract: config.imageContractSha256,
    boat: async (method, route, options = {}) => {
      await persist(); await lease.fence();
      if (method === "POST" && route === "/sandboxes") {
        record.builderIntent ??= { body: options.body, key: options.headers?.["idempotency-key"], at: Date.now() }; await lease.save();
      }
      if (method === "POST" && route === "/named-snapshots") { record.snapshotRequested = true; await lease.save(); }
      const result = await raw(method, route, options);
      if (method === "POST" && route === "/sandboxes" && result.status < 300 && /^bx_[a-z0-9]+$/.test(result.body?.sandbox?.id ?? "")) {
        record.builder = { id: result.body.sandbox.id }; await lease.save();
      }
      return result;
    } };
  const call = async args => {
    await assertDevBuilderBudget(lease, profile, record, raw);
    try { const result = await kit.main(args, deps); await persist(); return result; }
    catch { await persist(); throw new Error("Dev worker build did not complete. Its encrypted recovery receipts were retained; retry launch or run pnpm dev:archive."); }
  };
  const dir = path.join(directory, source.commit.slice(0, 12));
  if (!record.maxUsedHours) {
    const response = await raw("GET", `/limits?org=${encodeURIComponent(profile.boat.billingOrg)}`);
    const used = response.body?.creditUsedSeconds;
    if (response.status !== 200 || !Number.isFinite(used)) throw new Error("Boat Dev build budget could not be checked");
    record.maxUsedHours = used / 3600 + profile.boat.builderBudgetHours; await lease.save();
  }
  if (!fs.existsSync(path.join(directory, "builder.json"))) await call(["builder", "create", "--from", profile.boat.baseSnapshot, "--max-used-hours", String(record.maxUsedHours)]);
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
    await call(["builder", "run", path.join(dir, "builder-preflight.sh")]); await call(["builder", "upload"]);
    record.buildStarted = true; await lease.save();
    await call(["builder", "run", path.join(dir, "install.sh"), "120"]);
  }
  await pollProvider("Dev native worker build", async () => {
    const status = JSON.parse(await call(["builder", "run", path.join(dir, "build-status.sh")]));
    if (status.result && !status.result.passed) throw new Error("Dev native worker build failed; retry after inspecting its private build receipt");
    return status.result?.passed === true;
  }, { signal: lease.signal, timeout: 25 * 60_000, interval: 10_000 });
  if (!record.attestationStarted) { record.attestationStarted = true; await lease.save(); await call(["attestation", "start"]); }
  const attestation = await pollProvider("Dev worker attestation", async () => {
    const result = await call(["attestation", "status"]);
    if (!result.finished) return false;
    if (!result.qualified || !result.matchesCommit || !Number.isSafeInteger(result.measuredStorageMiB)) throw new Error("Dev worker native attestation did not qualify");
    return result;
  }, { signal: lease.signal, timeout: 20 * 60_000, interval: 10_000 });
  if (!fs.existsSync(path.join(dir, "sanitize.sh"))) await call(["generate-post"]);
  if (!record.snapshotRequested) await call(["snapshot", "save"]);
  await pollProvider("Dev worker snapshot", async () => (await call(["snapshot", "status"])).state === "ready", { signal: lease.signal, timeout: 600_000, interval: 5000 });
  Object.assign(record, { qualified: true, buildSha256: attestation.buildSha256, storageMiB: attestation.measuredStorageMiB }); await lease.save();
  await confirmBoatDeletion(lease, record.builder, raw, { allowDeferredStorage: true });
  delete record.files; await lease.save();
  return record;
}

export async function deleteDevImages(lease, profile, request = devBoatClient(profile.boat, lease.signal), polling = {}) {
  for (const record of lease.state.resources.images ?? []) {
    if (record.deleted) continue;
    if (record.builderIntent && !record.builder) {
      if (Date.now() - record.builderIntent.at > 23 * 3600_000) throw new Error("Unconfirmed Dev builder is outside Boat's idempotency window; reconcile it before deleting its receipt");
      await lease.fence();
      const r = await request("POST", "/sandboxes", { body: record.builderIntent.body,
        headers: { "idempotency-key": record.builderIntent.key, "x-boat-org": profile.boat.billingOrg } });
      if (r.status >= 300 || !/^bx_[a-z0-9]+$/.test(r.body?.sandbox?.id ?? "")) throw new Error("Dev builder allocation still needs reconciliation");
      record.builder = { id: r.body.sandbox.id }; await lease.save();
    }
    if (record.snapshotRequested && !record.snapshotDeleted) {
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
    if (record.builder) await confirmBoatDeletion(lease, record.builder, request, { ...polling, allowDeferredStorage: true });
    record.retired = true; record.deleted = !record.builder || record.builder.deleted === true;
    delete record.files; await lease.save();
  }
}
