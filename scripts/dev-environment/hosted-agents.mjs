import { randomUUID } from "node:crypto";
import { sha256 } from "./state.mjs";

const CHECKS = ["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission",
  "stopAndRevocation", "nativeTurn", "nativeResume", "authentication", "nativeMcp"];
const NATIVE_EXTENSIONS=["nativeGoals","nativeFork","transcriptFork","nativeReview","nativeApps","nativeMultiAgent"];
/** Codex's extended native checks (goals, forks, review, multi-agent, apps)
 * take longer than the core set; every step is still individually bounded. */
export const QUALIFICATION_DEADLINE_MS = 40 * 60_000;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const signature = (image, connection) => sha256(JSON.stringify([image.snapshotId, image.buildSha256,
  connection.credentialId, connection.credentialRevision, connection.connectionRevision, connection.kind, connection.model,
  ...(connection.mode ? [connection.mode] : []), ...(image.id ? [image.id] : [])]));

/** Accept only the fixed native-canary result, never SDK logs or a machine-only
 * attestation. The migration owner's existing audited operator validates it a
 * second time before changing the exact image/kind admission row. */
export function nativeRuntimeEvidence(image, connection, outcome, startedAt, now = Date.now()) {
  const report = outcome?.report, identity = report?.identity, at = Date.parse(report?.qualifiedAt);
  if (outcome?.code !== 0 || outcome.retirement !== 0 || report?.version !== 3 || report.qualified !== true ||
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
    credentials: [{ kind: connection.kind, checks: Object.fromEntries([...CHECKS,...NATIVE_EXTENSIONS.filter(check=>report.checks.includes(check))].map(check => [check, true])), renewal }] };
  return { ...evidence, evidenceSha256: sha256(JSON.stringify(evidence)) };
}

/** One bounded advancement per lease. A native turn runs on the disposable VM
 * after this returns, allowing Archive to acquire the lease immediately. Lost
 * dispatch acknowledgements are polled, never blindly sent a second time. */
export async function advanceHostedAgents(lease, profile, deps, { retry = false } = {}) {
  const { state } = lease, now = deps.now?.() ?? Date.now();
  if (state.status !== "ready" || !profile.fixture) return { state: "inactive" };
  const worker = state.resources.images?.find(row => row.qualified && !row.deleted && !row.snapshotDeleted &&
    row.inputsSha256 === state.source?.workerInputsSha256);
  if (!worker) throw new Error("Dev agents require the current qualified worker image");
  const status = await deps.inspect(worker);
  // Discovery is fenced by the product DB's fixture owner, account, exact base
  // and attestation. Ready images must qualify before W12 allows activation.
  const candidates = [{ image: worker, connections: status.connections ?? [] },
    ...(status.organizationImages ?? []).map(image => ({ image, connections: image.connections }))]
    .flatMap(({ image, connections }) => connections.map(connection => ({ image, connection })));
  const jobs = state.agentQualifications ??= [];
  // Retire stale work before considering sign-in, a new selection or image.
  for (const job of jobs.filter(row => !row.retired && row.phase !== "enabled")) {
    const current = candidates.some(({ image, connection }) => signature(image, connection) === job.signature);
    const overdue = now - job.startedAt > QUALIFICATION_DEADLINE_MS;
    if (job.phase === "failed" || !current || overdue) {
      if (overdue && job.phase !== "failed") job.failure ??= { stage: "deadline" };
      job.phase = "failed"; await lease.save();
      await deps.retire(job); job.retired = true; await lease.save();
    }
  }
  if (status.needsSignIn) return { state: "sign-in" };
  if (status.needsSeed) { await deps.seed(); return { state: "seeding" }; }
  if (!status.connections?.length) return { state: "connections" };
  // One paid canary at a time, including across interrupted launches.
  const active = jobs.find(job => ["allocating", "starting", "running", "passed"].includes(job.phase));
  const candidate = active ? candidates.find(({ image, connection }) => signature(image, connection) === active.signature)
    : candidates.find(({ image, connection }) => !connection.enabled && !jobs.some(job => job.signature === signature(image, connection) &&
        (job.phase === "enabled" || job.phase === "failed" && !retry)));
  if (!candidate) return { state: candidates.every(({ connection }) => connection.enabled) ? "ready" : "failed" };
  const { image, connection } = candidate;
  const key = signature(image, connection);
  let job = active;
  if (!job) {
    const attempts = jobs.filter(row => row.signature === key);
    if (attempts.length >= 3) return { state: "failed" };
    if (jobs.length >= 100) throw new Error("Dev agent qualification history reached its bound; archive before more attempts");
    job = { id: randomUUID(), signature: key, phase: "allocating", startedAt: now, actorUserId: status.actorUserId,
      ...(image.id ? { organizationImageId: image.id, runtimeContractSha256: image.contractSha256 } : {}),
      connection: globalThis.structuredClone(connection), image: { snapshotId: image.snapshotId, buildSha256: image.buildSha256, sourceCommit: image.sourceCommit } };
    jobs.push(job); await lease.save();
  }
  if (job.phase === "allocating") {
    await lease.fence(); await deps.allocate(job, image);
    const ready = await deps.ready(job);
    if (ready === "failed") {
      job.failure = { stage: "machine" };
      job.phase = "failed"; await lease.save(); await deps.retire(job); job.retired = true; await lease.save();
      return { state: "failed", provider: connection.provider };
    }
    if (ready !== true) return { state: "testing", provider: connection.provider };
    job.phase = "starting"; await lease.save(); await lease.fence();
    try { await deps.start(job, image); }
    catch (error) {
      if (error?.code !== "DEV_AGENT_NOT_DISPATCHED") throw error;
      job.failure = { stage: "pre-dispatch" };
      job.phase = "failed"; await lease.save(); await deps.retire(job); job.retired = true; await lease.save();
      return { state: "failed", provider: connection.provider };
    }
    job.phase = "running"; await lease.save();
    return { state: "testing", provider: connection.provider };
  }
  if (["starting", "running"].includes(job.phase)) {
    const result = await deps.poll(job);
    if (result.running) return { state: "testing", provider: connection.provider };
    try { job.evidence = nativeRuntimeEvidence({ ...job.image, contractSha256: job.runtimeContractSha256 }, job.connection, result, job.startedAt, now); job.phase = "passed"; }
    catch {
      const code = value => Number.isInteger(value) && value >= -256 && value <= 256 ? value : null;
      const knownChecks = new Set([...CHECKS,...NATIVE_EXTENSIONS, "nativePermissionSelection", "nativeAccessRefresh", "nativeGitAuthor",
        "nativeMcpRotation", "nativeMcpRemoval", "nativeMcpOwnerHandoff", "stopAndRevocation"]);
      const phases = ["input", "actor-admission", "native-start", "provider-home-isolation", "native-git-author",
        "native-turn", "native-tool-evidence", "native-mcp", "access-refresh", "native-resume", "permission-selection", "stop", "revocation",
        "native-goal-set","native-goal-reload","native-fork","transcript-fork","native-review","native-apps","native-multi-agent",
        "native-mcp-rotation","native-mcp-removal","native-mcp-owner-handoff"];
      job.failure = { stage: "native", exitCode: code(result.code), retirementCode: code(result.retirement),
        qualified: result.report?.qualified === true,
        completedChecks: [...knownChecks].filter(check => Array.isArray(result.report?.checks) && result.report.checks.includes(check)),
        ...(phases.includes(result.report?.phase) ? { nativePhase: result.report.phase } : {}),
        ...(["timeout", "assertion", "runtime"].includes(result.report?.failure) ? { category: result.report.failure } : {}) };
      job.phase = "failed";
    }
    await lease.save();
  }
  if (!job.retired) { await deps.retire(job); job.retired = true; await lease.save(); }
  if (job.phase !== "passed") return { state: "failed", provider: connection.provider };
  // The database row is authoritative after a lost acknowledgement. Repeating
  // the operator with a newly issued migration login would change its target
  // fingerprint; do not manufacture a second approval for the same result.
  if (!connection.enabled) { await lease.fence(); await deps.enable(job); }
  job.phase = "enabled"; await lease.save();
  return { state: "enabled", provider: connection.provider };
}
