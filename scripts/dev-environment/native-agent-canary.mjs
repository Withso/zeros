import { refuseRetiredDevNativeCanary } from "./native-agent-retirement.mjs";
import { devBoatClient, confirmBoatDeletion, assertDevBuilderBudget } from "./hosted-image.mjs";
import { sha256 } from "./state.mjs";
import { dispatchDevCreate, DevProviderError } from "./provider-http.mjs";

export const CHECKS = ["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission",
  "stopAndRevocation", "nativeTurn", "nativeResume", "authentication", "nativeMcp"];
export const NATIVE_EXTENSIONS=["nativeGoals","nativeFork","transcriptFork","nativeReview","nativeApps","nativeMultiAgent"];
/** Codex's extended native checks (goals, forks, review, multi-agent, apps)
 * take longer than the core set; every step is still individually bounded. */
export const QUALIFICATION_DEADLINE_MS = 40 * 60_000;
export function qualificationRateLimited(outcome) {
  return (outcome?.code !== 0 || outcome?.report?.qualified !== true) &&
    [outcome?.errorKind, outcome?.report?.errorKind, outcome?.report?.failureKind].includes("rate-limited");
}
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Accept only the fixed native-canary result, never SDK logs or a machine-only
 * attestation. The migration owner's existing audited operator validates it a
 * second time before changing the exact image/kind admission row. */
export function nativeRuntimeEvidence(image, connection, outcome, startedAt, now = Date.now()) {
  const report = outcome?.report, identity = report?.identity, at = Date.parse(report?.qualifiedAt);
  const qualificationProfile = connection.qualificationProfile ?? "full";
  if (outcome?.code !== 0 || outcome.retirement !== 0 || report?.version !== 3 || report.qualified !== true ||
      !["smoke", "full"].includes(qualificationProfile) || (report.qualificationProfile ?? "full") !== qualificationProfile ||
      report.executionProfile !== "zeros-cloud-native-v1" || report.authority !== "isolated-image-canary" ||
      identity?.sourceCommit !== image.sourceCommit || identity.buildSha256 !== image.buildSha256 ||
      identity.kind !== connection.kind || identity.model !== connection.model || !digest(identity.contractSha256) ||
      image.contractSha256 && image.contractSha256 !== identity.contractSha256 ||
      !Array.isArray(report.checks) || [...CHECKS, "nativePermissionSelection"].some(check => !report.checks.includes(check)) ||
      !Number.isFinite(at) || at < startedAt - 5000 || at > now + 5000 || now - at > 24 * 3600_000) {
    throw new Error("The native Dev agent report did not qualify this exact image and connection");
  }
  const renewal = connection.kind === "codex-chatgpt";
  if (renewal && (!report.checks.includes("nativeAccessRefresh") ||
      ["accountBinding", "accessChanged", "cachePublished", "consentPreserved"].some(check => outcome.renewal?.[check] !== true))) {
    throw new Error("The Codex native renewal and worker refresh checks did not qualify");
  }
  // Only explicitly selected, non-secret fields enter the durable evidence.
  const evidence = { version: 3, executionProfile: "zeros-cloud-native-v1", channel: "development", provider: "boat",
    runtimeClass: "linux-vm", imageRef: `boat:${image.snapshotId}@sha256:${image.buildSha256}`, profile: "zeros-cloud-worker-v3",
    runtimeContractSha256: identity.contractSha256, sourceCommit: image.sourceCommit, qualifiedAt: report.qualifiedAt,
    ...(report.qualificationProfile ? { qualificationProfile } : {}),
    credentials: [{ kind: connection.kind, checks: Object.fromEntries([...CHECKS,...NATIVE_EXTENSIONS.filter(check=>qualificationProfile === "full" && report.checks.includes(check))].map(check => [check, true])), renewal }] };
  return { ...evidence, evidenceSha256: sha256(JSON.stringify(evidence)) };
}


export function canaryBudgetHours(boat) {
  return Math.min(boat.builderBudgetHours, QUALIFICATION_DEADLINE_MS / 3_600_000 + 0.25);
}

const cleanupTime = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
function nativeCleanupBinding(row, job, profile, operation) {
  const values = [profile.boat?.accountScope, profile.boat?.billingOrg, profile.railway?.projectId,
    profile.planetscale?.organization, profile.planetscale?.database, profile.cloudflare?.accountId];
  if (!values.every(value => typeof value === "string" && value.length > 0) || row.purpose !== "native-agent-qualification" ||
    row.agentQualificationId !== job.id || row.builderIntent?.key !== job.id || !Number.isFinite(row.builderIntent.at) ||
    row.sourceCommit !== job.image?.sourceCommit || row.sourceImage !== job.image?.snapshotId || !digest(job.image?.buildSha256) ||
    operation?.id !== row.builder.deletionOperationId || operation.kind !== "sandbox" || operation.targetId !== row.builder.id ||
    !cleanupTime(operation.requestedAt) || Date.parse(operation.requestedAt) < row.builderIntent.at ||
    Date.parse(operation.requestedAt) > Date.now()) throw new Error("Native canary physical cleanup proof is unconfirmed; retain its admission");
  return { version: 1, operationId: job.id, targetId: row.builder.id, snapshotId: row.sourceImage, sourceCommit: row.sourceCommit,
    buildSha256: job.image.buildSha256, creationIntentSha256: sha256(JSON.stringify(row.builderIntent)), accountBinding: sha256(JSON.stringify(values)),
    billingOrg: profile.boat.billingOrg };
}
function nativeCleanupProof(row, job, profile, operation) {
  const binding = nativeCleanupBinding(row, job, profile, operation);
  if (operation.status !== "completed" || !cleanupTime(operation.completedAt) || Date.parse(operation.completedAt) < Date.parse(operation.requestedAt) ||
    Date.parse(operation.completedAt) > Date.now()) throw new Error("Native canary physical cleanup proof is unconfirmed; retain its admission");
  return { ...binding, operation: { id: operation.id, kind: "sandbox", targetId: row.builder.id, status: "completed",
      requestedAt: operation.requestedAt, completedAt: operation.completedAt } };
}
function nativeStorageProof(state, row, job, profile, operation) {
  const binding = nativeCleanupBinding(row, job, profile, operation), observation = row.snapshotPolicyObserved;
  if (!["alpha", "beta", "production"].some(channel => state.owner === sha256(`zeros-release-worker:${channel}`).slice(0, 24)) ||
    row.nativeDispatchStarted !== true || row.snapshotPolicyVersion !== 1 || row.builderIntent.body.snapshots !== false ||
    observation?.version !== 1 || observation.targetId !== row.builder.id || observation.snapshots !== false ||
    !cleanupTime(observation.observedAt) || Date.parse(observation.observedAt) < row.builderIntent.at ||
    Date.parse(observation.observedAt) > Date.parse(operation.requestedAt) || operation.status !== "blocked" || operation.completedAt != null ||
    !["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"].includes(operation.stage) ||
    operation.stage === "waiting_for_uploads" && !cleanupTime(operation.expectedBy) ||
    operation.expectedBy != null && (!cleanupTime(operation.expectedBy) || Date.parse(operation.expectedBy) < Date.parse(operation.requestedAt) ||
      Date.parse(operation.expectedBy) > Date.now() + 6 * 3600_000 + 5000)) throw new Error("Native canary storage retirement proof is unconfirmed; retain its admission");
  return { ...binding, kind: "storage-pending", snapshotsOff: { ...observation }, operation: { id: operation.id, kind: "sandbox", targetId: row.builder.id,
    status: "blocked", stage: operation.stage, requestedAt: operation.requestedAt, expectedBy: operation.expectedBy ?? null } };
}

export function nativeAgentCanary(lease, profile, providerRequest, admission, options = {}) {
  const request = (...args) => {
    providerRequest ??= devBoatClient(profile.boat, lease.signal);
    return providerRequest(...args);
  };
  const nativeDeadlineSeconds = options.nativeDeadlineSeconds ?? QUALIFICATION_DEADLINE_MS / 1000;
  if (!Number.isSafeInteger(nativeDeadlineSeconds) || nativeDeadlineSeconds < 60 || nativeDeadlineSeconds > 2400) throw new Error("Invalid native canary deadline");
  const boundedLease = options.nativeDeadlineSeconds !== undefined || options.maxUsedHours !== undefined;
  const assertBudget = async row => {
    let usedSeconds;
    await assertDevBuilderBudget(lease, profile, row, async (method, route, input) => {
      const response = await request(method, route, input);
      if (method === "GET" && route.startsWith("/limits")) {
        usedSeconds = response.body?.creditUsedSeconds;
        if (response.status !== 200 || !Number.isFinite(usedSeconds) || usedSeconds < 0) throw new Error("Native canary budget meter is unavailable");
      }
      return response;
    });
    return usedSeconds;
  };
  const record = job => {
    const row = lease.state.resources.images?.find(image => image.agentQualificationId === job.id);
    if (!row || row.purpose !== "native-agent-qualification") throw new Error("Dev agent canary ownership receipt is missing");
    return row;
  };
  const owned = async job => {
    const row = record(job), response = await request("GET", `/sandboxes/${row.builder?.id}`);
    if (response.status !== 200 || response.body?.sandbox?.id !== row.builder.id || response.body.sandbox.team?.id !== profile.boat.billingOrg) {
      throw new Error("Dev agent canary provider identity changed");
    }
    if (row.snapshotPolicyVersion !== undefined) {
      if (row.snapshotPolicyVersion !== 1 || row.builderIntent?.body?.snapshots !== false || response.body.sandbox.snapshots !== false)
        throw new Error("Native canary snapshots-off policy is unconfirmed; no account material may be dispatched");
      row.snapshotPolicyObserved = { version: 1, targetId: row.builder.id, snapshots: false, observedAt: new Date().toISOString() };
      await lease.save();
    }
    return response.body.sandbox;
  };
  // Only retirement may replay a lost historical allocation, using its exact
  // saved request and idempotency key. This is never a fresh canary producer.
  const recoverAllocation = async (job, image) => {
    const row = record(job);
    if (!row.builderIntent || row.builderIntent.key !== job.id || !row.builderIntent.body ||
        !Number.isFinite(row.builderIntent.at) || row.builderIntent.at > Date.now() + 5000 ||
        row.sourceCommit !== image.sourceCommit || row.sourceImage !== image.snapshotId)
      throw new Error("Dev canary recovery requires its recorded original allocation intent");
    if (row.builder?.deleteRequested || row.builder?.retiredAt) throw new Error("Dev agent canary was retired");
    const usedSeconds = await assertBudget(row);
    if (boundedLease && !row.builder) {
      const remainingSeconds = Math.floor(row.maxUsedHours * 3600 - usedSeconds);
      if (row.builderIntent.body.ttlSeconds < 60 || row.builderIntent.body.ttlSeconds > remainingSeconds)
        throw new Error("Native canary budget cannot cover its retained VM lease; reconcile before dispatch");
    }
    await lease.fence();
    await admission?.reserve(job);
    try {
      if (!row.builder) {
        if (Date.now() - row.builderIntent.at > 23 * 3600_000) throw new Error("Dev canary creation must be reconciled before its idempotency window expires");
        await dispatchDevCreate(lease, row, "Boat Dev", async () => {
          const response = await request("POST", "/sandboxes", { body: row.builderIntent.body,
            headers: { "idempotency-key": row.builderIntent.key, "x-boat-org": profile.boat.billingOrg }, timeoutMs: 120_000 });
          if (response.status >= 300) throw new DevProviderError("Boat Dev", response.status, response.requestId);
          if (!/^bx_[a-z0-9]+$/.test(response.body?.sandbox?.id ?? "")) throw new Error("Dev canary creation is unconfirmed; its intent was retained");
          row.builder = { id: response.body.sandbox.id }; await lease.save();
        }, { key: "builderCreate", idempotentReplay: true });
      }
      await owned(job);
    } finally { await admission?.release(); }
  };
  return {
    async allocate() { refuseRetiredDevNativeCanary(); },
    async ready() { refuseRetiredDevNativeCanary(); },
    target(job) { return { id: record(job).builder.id, attempt: job.id, snapshotId: job.image.snapshotId,
      sourceCommit: job.image.sourceCommit, buildSha256: job.image.buildSha256 }; },
    async start() { refuseRetiredDevNativeCanary(); },
    async poll(job) {
      const row = lease.state.resources.images?.find(value => value.agentQualificationId === job.id);
      // The historical hosted SSH dispatcher saved starting/running on the
      // qualification job, but did not write the native transport's marker.
      // Observe that exact recorded attempt without restoring dispatch.
      const recorded = lease.state.agentQualifications?.find(value => value.id === job.id);
      const hostedStarted = ["starting", "running"].includes(recorded?.phase) &&
        row?.purpose === "native-agent-qualification" && row.builder?.id &&
        recorded.image?.sourceCommit === row.sourceCommit && recorded.image?.snapshotId === row.sourceImage &&
        recorded.image?.sourceCommit === job.image?.sourceCommit && recorded.image?.snapshotId === job.image?.snapshotId &&
        recorded.image?.buildSha256 === job.image?.buildSha256;
      if (row?.nativeDispatchStarted !== true && !hostedStarted)
        refuseRetiredDevNativeCanary();
      await owned(job); await assertBudget(record(job));
      const id = record(job).builder.id, attempt = job.id.replaceAll("-", "");
      if (!/^[a-f0-9]{32}$/.test(attempt)) throw new Error("Invalid Dev canary attempt");
      const response = await request("POST", `/sandboxes/${id}/commands`, { body: { timeoutSeconds: 10, command: `sudo -n /usr/bin/python3 - <<'PY'
import pathlib,json
p=pathlib.Path('/srv/zeros-qualification/native-${attempt}/result.json')
if p.exists():
 assert p.is_file() and not p.is_symlink() and p.stat().st_size<32768
 print(p.read_text())
else:
 runner=p.parent/'runner.py'
 print(json.dumps({'running':True} if runner.is_file() and not runner.is_symlink() else {'dispatchUnconfirmed':True}))
PY` } });
      if (response.status !== 200 || response.body?.exitCode !== 0 || response.body.timedOut) throw new Error("Dev agent result is unavailable");
      // No SDK output is logged or persisted; the coordinator accepts only
      // fixed report fields bound to the exact image and selected credential.
      let result;
      try { result = JSON.parse(response.body.stdout); } catch { throw new Error("Dev agent result is unavailable"); }
      if (result.dispatchUnconfirmed === true) throw new Error("Native canary dispatch is unconfirmed; reconcile before retrying, never redispatch credentials");
      return result;
    },
    async retire(job, beforeStorageRelease) {
      if (!lease.state.resources.images.some(value => value.agentQualificationId === job.id)) return;
      const row = record(job);
      if (!row.builder && ["planned", "rejected"].includes(row.builderCreate?.phase)) {
        row.retired = true; row.deleted = true; await lease.save();
        await admission?.release(); return;
      }
      if (!row.builder) {
        // Reconcile a lost create response with its original request. Never
        // erase an allocation intent on the assumption that creation failed.
        await recoverAllocation(job, job.image);
      }
      let confirmed = false, storageAcknowledged = false;
      try {
        if (options.strictCleanup && row.builder.deleteRequested && !row.builder.deletionOperationId) {
          throw new Error("Native canary deletion response was lost; reconcile its terminal operation before retrying");
        }
        if (options.strictCleanup) {
          const retained = row.builder.physicalCleanup;
          if (row.builder.deleted && !retained) { row.builder.deleted = false; row.deleted = false; await lease.save(); }
          if (retained) {
            const expected = nativeCleanupProof(row, job, profile, retained.operation);
            if (Object.entries(expected).some(([key, value]) => JSON.stringify(retained[key]) !== JSON.stringify(value)) ||
              !Number.isFinite(Date.parse(retained.operationObservedAt)) || !Number.isFinite(Date.parse(retained.unavailableObservedAt)) ||
              Date.parse(retained.operation.completedAt) > Date.parse(retained.operationObservedAt) ||
              Date.parse(retained.operationObservedAt) > Date.parse(retained.unavailableObservedAt) || Date.parse(retained.unavailableObservedAt) > Date.now())
              throw new Error("Native canary retained physical cleanup proof changed; retain its admission");
          }
          const storage = row.builder.storageRetirement;
          if (storage) {
            const expected = nativeStorageProof(lease.state, row, job, profile, storage.operation);
            if (!options.releaseStorageDeferral || Object.entries(expected).some(([key, value]) => JSON.stringify(storage[key]) !== JSON.stringify(value)) ||
              !cleanupTime(storage.operationObservedAt) || !cleanupTime(storage.unavailableObservedAt) ||
              Date.parse(storage.operation.requestedAt) > Date.parse(storage.operationObservedAt) ||
              Date.parse(storage.operationObservedAt) > Date.parse(storage.unavailableObservedAt) || Date.parse(storage.unavailableObservedAt) > Date.now())
              throw new Error("Native canary retained storage retirement proof changed; retain its admission");
          }
        }
        const deferStorage = options.strictCleanup && options.releaseStorageDeferral === true && row.nativeDispatchStarted === true;
        await confirmBoatDeletion(lease, row.builder, request, { allowDeferredStorage: !options.strictCleanup || deferStorage, timeout: options.cleanupTimeoutMs ?? 30_000,
          ...(deferStorage ? { retainedDeferredStorage: operation => Boolean(row.builder.storageRetirement) &&
            ["pending", "processing"].includes(operation.status) && ["removing", "retrying"].includes(operation.stage) &&
            operation.completedAt == null && operation.requestedAt === row.builder.storageRetirement.operation.requestedAt } : {}),
          ...(deferStorage ? { beforeDeferredStorage: async (operation, observations) => {
            if (typeof beforeStorageRelease !== "function") throw new Error("Native canary storage retirement audit is unconfirmed; retain its admission");
            if (row.builder.storageRetirement && row.builder.storageRetirement.operation.requestedAt !== operation.requestedAt)
              throw new Error("Native canary storage retirement operation changed; retain its admission");
            if (operation.status === "blocked") {
              const proof = nativeStorageProof(lease.state, row, job, profile, operation);
              row.builder.storageRetirement = { ...proof, ...observations };
            } else nativeStorageProof(lease.state, row, job, profile, row.builder.storageRetirement.operation);
            await lease.save(); await lease.fence(); await beforeStorageRelease(); storageAcknowledged = true;
          } } : {}),
          ...(options.strictCleanup ? { beforeDeleted: async operation => {
            if (row.builder.storageRetirement && row.builder.storageRetirement.operation.requestedAt !== operation.requestedAt)
              throw new Error("Native canary storage retirement operation changed; retain its admission");
            const proof = nativeCleanupProof(row, job, profile, operation), operationObservedAt = new Date().toISOString();
            const sandbox = await request("GET", `/sandboxes/${row.builder.id}`);
            if (sandbox.status !== 404) throw new Error("Native canary physical cleanup sandbox remains available; retain its admission");
            row.builder.physicalCleanup = { ...proof, operationObservedAt, unavailableObservedAt: new Date().toISOString() };
            await lease.save(); await lease.fence();
          } } : {}) });
        confirmed = row.builder.deleted === true || storageAcknowledged;
        row.retired = true; row.deleted = row.builder.deleted === true; await lease.save();
      } finally { if (!options.strictCleanup || confirmed) await admission?.release(); }
    },
  };
}
