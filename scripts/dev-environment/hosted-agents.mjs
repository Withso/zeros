import { randomUUID } from "node:crypto";
import { sha256 } from "./state.mjs";
import { CHECKS, NATIVE_EXTENSIONS, QUALIFICATION_DEADLINE_MS, nativeRuntimeEvidence, qualificationRateLimited } from "./native-agent-canary.mjs";
export { QUALIFICATION_DEADLINE_MS, nativeRuntimeEvidence, qualificationRateLimited } from "./native-agent-canary.mjs";

const signature = (image, connection) => sha256(JSON.stringify([image.snapshotId, image.buildSha256,
  connection.credentialId, connection.credentialRevision, connection.connectionRevision, connection.kind, connection.model,
  ...(connection.mode ? [connection.mode] : []), ...(image.id ? [image.id] : [])]));
const rateLimitedJob = job => job.phase === "failed" && job.failure?.errorKind === "rate-limited";
const rateLimitResult = job => ({ state: "rate-limited", provider: job.connection.provider, retryAfter: job.retryAfter,
  message: "Dev canary account rate-limited; automatic retry is deferred with bounded backoff. Qualification attempts are not consumed." });

/** One bounded advancement per lease. A native turn runs on the disposable VM
 * after this returns, allowing Archive to acquire the lease immediately. Lost
 * dispatch acknowledgements are polled, never blindly sent a second time. */
/** A new worker build replaces the image these checks qualify. Each canary
 * holds the owner's builder reservation, and only a ready environment
 * advances it, so a relaunch with changed worker source retires unfinished
 * checks before its build competes for that capacity. */
export async function retireUnfinishedHostedAgents(lease, deps) {
  let retired = 0;
  for (const job of (lease.state.agentQualifications ?? []).filter(row => !row.retired)) {
    if (job.phase !== "failed" && job.phase !== "enabled") { job.phase = "failed"; job.failure ??= { stage: "superseded" }; await lease.save(); }
    await deps.retire(job); job.retired = true; await lease.save(); retired++;
  }
  return retired;
}

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
  // A retired "passed" check still awaits enable, and counts as stale only
  // once its image or connection is no longer current.
  for (const job of jobs.filter(row => row.phase !== "enabled" && (!row.retired || row.phase === "passed"))) {
    const current = candidates.some(({ image, connection }) => signature(image, connection) === job.signature);
    const pending = job.phase !== "passed" && job.phase !== "failed";
    const overdue = pending && now - job.startedAt > QUALIFICATION_DEADLINE_MS;
    // The budget guard deletes its canary; retrying that machine only fails.
    const budget = pending && state.resources.images?.some(row => row.agentQualificationId === job.id && row.budgetExceeded === true);
    if (job.phase === "failed" || !current || overdue || budget) {
      if (job.phase !== "failed") job.failure ??= { stage: !current ? "superseded" : budget ? "budget" : "deadline" };
      job.phase = "failed"; await lease.save();
      if (!job.retired) { await deps.retire(job); job.retired = true; await lease.save(); }
    }
  }
  const latestBySignature = new Map(jobs.map(job => [job.signature, job]));
  const retained = jobs.filter(job => !rateLimitedJob(job) || !job.retired || latestBySignature.get(job.signature) === job);
  if (retained.length !== jobs.length) { jobs.splice(0, jobs.length, ...retained); await lease.save(); }
  if (status.needsSignIn) return { state: "sign-in" };
  if (status.needsSeed) { await deps.seed(); return { state: "seeding" }; }
  if (!status.connections?.length) return { state: "connections" };
  // One paid canary at a time, including across interrupted launches.
  const active = jobs.find(job => ["allocating", "starting", "running", "passed"].includes(job.phase));
  const eligible = candidates.filter(({ image, connection }) => {
    const latest = latestBySignature.get(signature(image, connection));
    return !connection.enabled && latest?.phase !== "enabled" && !(latest?.phase === "failed" && !rateLimitedJob(latest) && !retry);
  });
  const waiting = candidate => {
    const latest = jobs.findLast(job => job.signature === signature(candidate.image, candidate.connection));
    return latest && rateLimitedJob(latest) && Date.parse(latest.retryAfter) > now ? latest : undefined;
  };
  const candidate = active ? candidates.find(({ image, connection }) => signature(image, connection) === active.signature)
    : eligible.find(value => !waiting(value));
  if (!candidate && !active) {
    const deferred = eligible.map(waiting).find(Boolean);
    if (deferred) return rateLimitResult(deferred);
  }
  if (!candidate) return { state: candidates.every(({ connection }) => connection.enabled) ? "ready" : "failed" };
  const { image, connection } = candidate;
  const key = signature(image, connection);
  let job = active;
  if (!job) {
    const attempts = jobs.filter(row => row.signature === key);
    if (attempts.filter(row => !rateLimitedJob(row)).length >= 3) return { state: "failed" };
    if (jobs.length >= 100) throw new Error("Dev agent qualification history reached its bound; archive before more attempts");
    job = { id: randomUUID(), signature: key, phase: "allocating", startedAt: now, actorUserId: status.actorUserId,
      ...(rateLimitedJob(latestBySignature.get(key) ?? {}) ? { rateLimitCount: latestBySignature.get(key).rateLimitCount } : {}),
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
    // Judge completion against when the report was read: inspection earlier
    // in this advance can outlast the run's final seconds.
    try { job.evidence = nativeRuntimeEvidence({ ...job.image, contractSha256: job.runtimeContractSha256 }, job.connection, result, job.startedAt, deps.now?.() ?? Date.now()); job.phase = "passed"; }
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
        ...(["timeout", "assertion", "runtime"].includes(result.report?.failure) ? { category: result.report.failure } : {}),
        ...(/^[A-Z][A-Z0-9_]{1,63}$/.test(result.report?.failureCode ?? "") ? { errorCode: result.report.failureCode } : {}),
        ...(/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(result.report?.failureName ?? "") ? { errorName: result.report.failureName } : {}),
        ...(/^[a-z][a-z0-9-]{1,40}$/.test(result.report?.failureKind ?? "") ? { errorKind: result.report.failureKind } : {}),
        ...(/^[a-z][a-z0-9-]{1,40}$/.test(result.report?.failureStage ?? "") ? { errorStage: result.report.failureStage } : {}),
        ...(Number.isInteger(result.report?.failureExitCode) && Math.abs(result.report.failureExitCode) <= 256 ? { errorExitCode: result.report.failureExitCode } : {}),
        ...(/^[a-f0-9]{16}$/.test(result.report?.failureMessageSha256 ?? "") ? { errorMessageSha256: result.report.failureMessageSha256 } : {}) };
      job.phase = "failed";
      if (qualificationRateLimited(result)) {
        job.failure.errorKind = "rate-limited";
        job.rateLimitCount = Math.min(8, (job.rateLimitCount ?? 0) + 1);
        job.retryAfter = new Date((deps.now?.() ?? Date.now()) + Math.min(15 * 60_000, 60_000 * 2 ** (job.rateLimitCount - 1))).toISOString();
        console.info(rateLimitResult(job).message);
      }
    }
    await lease.save();
  }
  if (!job.retired) { await deps.retire(job); job.retired = true; await lease.save(); }
  if (rateLimitedJob(job)) return rateLimitResult(job);
  if (job.phase !== "passed") return { state: "failed", provider: connection.provider };
  // The database row is authoritative after a lost acknowledgement. Repeating
  // the operator with a newly issued migration login would change its target
  // fingerprint; do not manufacture a second approval for the same result.
  if (!connection.enabled) { await lease.fence(); await deps.enable(job); }
  job.phase = "enabled"; await lease.save();
  return { state: "enabled", provider: connection.provider };
}
