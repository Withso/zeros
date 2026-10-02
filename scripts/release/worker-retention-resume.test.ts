import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeAgentCanary, CHECKS, NATIVE_EXTENSIONS } from "../dev-environment/native-agent-canary.mjs";
import { releaseHostedAdmission, reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { retireReleaseBuilder } from "./worker-builder-retirement";
import { releaseCanaryAdapter, fixedCanaryOutcome } from "./worker-canary";
import { workerOwner, workerSnapshotName, reserveWorkerSlot } from "./worker-admission";
import { workerEnvironment, workerConnections } from "./worker-test-fixtures";
import { workerExecutionConfig } from "./worker-config";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))); });

async function fixture(nativeTarget = "bx_native", kind = "claude-setup-token") {
  const env = workerEnvironment(), { config } = workerExecutionConfig(env), connections = workerConnections();
  const now = Date.now(), at = (offset: number) => new Date(now + offset).toISOString();
  const profile = { boat: { accountScope: env.BOAT_ACCOUNT_SCOPE!, billingOrg: env.BOAT_BILLING_ORG!, baseSnapshot: env.BOAT_BASE_SNAPSHOT!, builderBudgetHours: 0.25 },
    railway: { projectId: config.projectId }, planetscale: { organization: config.organization, database: config.database }, cloudflare: { accountId: "test-account" } };
  const account = hash([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId,
    profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId]);
  const state: any = { version: 2, owner: workerOwner(config.channel), generation: "66666666-6666-4666-8666-666666666666",
    identity: hash(["release-worker", config.repository, config.channel]), status: "provisioning", createdAt: at(-120_000), resources: { images: [] }, releaseRuns: [] };
  const run: any = { runId: config.runId, sourceSha: config.sourceSha, inputsSha256: "e".repeat(64), actorUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID,
    operationId: "77777777-7777-4777-8777-777777777777", qualificationProfile: "full", releaseCanaryBindings: connections, maxUsedHours: 2, canaries: [] };
  state.releaseRuns.push(run);
  const snapshotId = workerSnapshotName(state, hash([config.sourceSha, config.runId]));
  const candidate = { snapshotId, sourceCommit: config.sourceSha, buildSha256: "b".repeat(64), storageMiB: 4096, architecture: "linux/amd64" as const };
  const scope = { repository: config.repository, channel: config.channel, runId: config.runId, runAttempt: config.runAttempt, sourceSha: config.sourceSha,
    inputsSha256: run.inputsSha256, owner: state.owner, generation: state.generation, accountBinding: account, protectedBaseSnapshot: profile.boat.baseSnapshot };
  const body = { type: "default", from: profile.boat.baseSnapshot, ttlSeconds: 3600, noEnv: true, env: {} }, prefix = config.sourceSha.slice(0, 12);
  const parent: any = { purpose: "release-worker", releaseRunId: run.runId, inputsSha256: run.inputsSha256, sourceCommit: config.sourceSha,
    snapshotId, candidate, buildSha256: candidate.buildSha256, qualified: true, snapshotRequested: true,
    builderCreate: { phase: "acknowledged" }, snapshotCreate: { phase: "acknowledged" },
    builder: { id: "bx_parent", billingOrgConfirmed: true, billingObservedAt: at(-100_000), accountBinding: account },
    builderIntent: { key: "88888888-8888-4888-8888-888888888888", body, at: now - 100_000, scope },
    kitFiles: { "builder.json": JSON.stringify({ id: "bx_parent", from: body.from, type: body.type, createdAt: at(-100_000) }),
      [`${prefix}/source.json`]: JSON.stringify({ parent: config.sourceSha, commit: config.sourceSha, tree: "c".repeat(40), archiveSha256: "d".repeat(64), archiveBytes: 100, parts: 1, sourceFiles: 1, exactMergedCommit: true }),
      [`${prefix}/generation.json`]: JSON.stringify({ commit: config.sourceSha, previous: "f".repeat(40), contract: imageContractSha256(), attempt: `m2-build-${"f".repeat(32)}`, scriptSha256: "a".repeat(64), snapshotName: snapshotId, buildSha256: candidate.buildSha256 }),
      [`${prefix}/native-attestation.json`]: JSON.stringify({ qualified: true, setupQualification: { secure: true }, metadata: { buildSha256: candidate.buildSha256, build: { source: { commit: config.sourceSha } } }, resources: { allocation: { storageBytes: candidate.storageMiB * 1048576 } } }),
      [`${prefix}/snapshot-ledger.json`]: JSON.stringify({ version: 1, state: "ready", name: snapshotId, resourceId: "bx_parent", sourceCommit: config.sourceSha, buildSha256: candidate.buildSha256, createdAt: at(-80_000), lastObservedAt: at(-80_000), sanitation: { qualified: true, sourceCommit: config.sourceSha, buildSha256: candidate.buildSha256, observedAt: at(-80_000) } }) } };
  state.resources.images.push(parent);
  let ledger: any = { version: 1, owner: "account-admission", account, reservations: [] }, ledgerRevision = 1;
  const lease = { state, signal: new AbortController().signal, save: vi.fn(async () => {}), fence: vi.fn(async () => {}) };
  const store = { list: vi.fn(async () => ({ records: [], quarantine: [] })), readAdmission: vi.fn(async () => ({ state: structuredClone(ledger), etag: String(ledgerRevision) })),
    writeAdmission: vi.fn(async (value: any) => { ledger = structuredClone(value); ledgerRevision++; }) };
  const builderOperation: any = { id: `bdop_${"c".repeat(32)}`, kind: "sandbox", targetId: parent.builder.id, status: "blocked", stage: "waiting_for_uploads", expectedBy: at(6 * 3600_000) };
  const nativeOperation: any = { id: `bdop_${(nativeTarget === "bx_native" ? "d" : "e").repeat(32)}`, kind: "sandbox", targetId: nativeTarget, status: "blocked", stage: "waiting_for_uploads", expectedBy: at(6 * 3600_000), requestedAt: at(0) };
  let nativeUnavailable = false;
  const request = vi.fn(async (method: string, route: string): Promise<any> => {
    if (route.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: 0 } };
    if (route === `/named-snapshots/${snapshotId}`) return { status: 200, body: { snapshot: { name: snapshotId, status: "ready", sourceSandboxId: parent.builder.id } } };
    if (method === "DELETE" && route === `/sandboxes/${parent.builder.id}`) return { status: 202, body: { operation: structuredClone(builderOperation) } };
    if (method === "POST" && route === "/sandboxes") return { status: 201, body: { sandbox: { id: nativeTarget } } };
    if (method === "DELETE" && route === `/sandboxes/${nativeTarget}`) { nativeUnavailable = true; nativeOperation.requestedAt = new Date().toISOString(); return { status: 202, body: { operation: structuredClone(nativeOperation) } }; }
    if (route === `/deletion-operations/${builderOperation.id}`) return { status: 200, body: { operation: structuredClone(builderOperation) } };
    if (route === `/deletion-operations/${nativeOperation.id}`) return { status: 200, body: { operation: structuredClone(nativeOperation) } };
    if (route === `/sandboxes/${nativeTarget}`) return nativeUnavailable ? { status: 404 } : { status: 200, body: { sandbox: { id: nativeTarget, snapshots: false, team: { id: profile.boat.billingOrg }, state: "running" } } };
    if (route === `/sandboxes/${parent.builder.id}`) return { status: 404 };
    throw new Error("Unexpected local provider request");
  });
  await reserveWorkerSlot(store, lease, profile, config.channel, snapshotId, [{ provider: "boat", id: profile.boat.baseSnapshot }, { provider: "boat", id: snapshotId }]);
  await retireReleaseBuilder(config, { lease, record: parent, profile, request, readAdmission: store.readAdmission });
  await releaseHostedAdmission(store, lease, profile);
  const core = nativeAgentCanary(lease, profile, request, { reserve: (job: any) => reserveHostedAdmission(store, state, profile, { kind: "builder", computeId: `canary:${job.id}` }),
    release: () => releaseHostedAdmission(store, lease, profile) }, { strictCleanup: true, maxUsedHours: run.maxUsedHours, cleanupTimeoutMs: 0 });
  const retired = vi.fn(core.retire.bind(core));
  const adapter = releaseCanaryAdapter(lease, run, new Map(connections.map(row => [row.kind, row])), { ...core, retire: retired,
    ready: vi.fn(async () => true), start: vi.fn(async (job: any) => {
      const row = state.resources.images.find((value: any) => value.agentQualificationId === job.id);
      row.machineAttestationStarted = true; row.nativeDispatchStarted = true;
      job.admissionRequest = { version: 1, channel: config.channel, ownerUserId: run.actorUserId, organizationId: env.WORKER_CANARY_ORGANIZATION_ID,
        sourceSha: config.sourceSha, repository: config.repository, qualificationProfile: "full", runId: run.runId, runAttempt: "1", branch: "main",
        operationId: job.id, ...connections.find(binding => binding.kind === job.kind), target: core.target(job) };
    }), poll: vi.fn(async (job: any) => ({ code: 0, retirement: 0, report: { version: 3, qualified: true, qualificationProfile: "full",
      executionProfile: "zeros-cloud-native-v1", authority: "isolated-image-canary", qualifiedAt: new Date().toISOString(),
      identity: { sourceCommit: candidate.sourceCommit, buildSha256: candidate.buildSha256, contractSha256: imageContractSha256(), kind: job.kind, model: job.model },
      checks: [...CHECKS, ...NATIVE_EXTENSIONS, "nativePermissionSelection"] } })) }, { qualificationProfile: "full" });
  await expect(adapter.qualify(candidate, kind)).rejects.toThrow("blocked");
  const job = run.canaries[0], row = state.resources.images.find((value: any) => value.agentQualificationId === job.id);
  const failedAt = now + 10_000;
  const subject = { repository: config.repository, channel: config.channel, sourceSha: config.sourceSha, branch: config.branch, runId: config.runId, failedAttempt: "1", jobId: "456" };
  const producer = { runId: "789", runAttempt: "1" };
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-retention-resume-")); directories.push(directory);
  const documents = vi.fn(async () => ({ registry: { state: structuredClone(state), etag: "registry-1" }, admission: { state: structuredClone(ledger), etag: `ledger-${ledgerRevision}` } }));
  const context = { env: { RUNTIME_QUALIFICATION_ACTOR_USER_ID: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID,
    WORKER_CANARY_ORGANIZATION_ID: env.WORKER_CANARY_ORGANIZATION_ID }, profile, inputsSha256: run.inputsSha256, failedAt, now: () => now + 30_000,
    originalWorker: vi.fn(async (_attempt: string) => ({ startedAt: now - 120_000, finishedAt: failedAt })), documents, request };
  const complete = () => { nativeOperation.status = "completed"; nativeOperation.stage = "completed"; nativeOperation.completedAt = at(20_000); };
  return { state, run, parent, job, row, store, request, nativeOperation, builderOperation, context, subject, producer, directory, complete,
    available: () => { nativeUnavailable = false; }, ledger: () => ledger, lease, adapter, retired };
}

describe("automatic original-worker retention resumption", () => {
  it("exposes only the non-secret observer identity projection, not guarded-execution authority", async () => {
    const test = await fixture();
    expect(Object.keys(test.context.env).sort()).toEqual(["RUNTIME_QUALIFICATION_ACTOR_USER_ID", "WORKER_CANARY_ORGANIZATION_ID"]);
    expect(test.context.env.RUNTIME_QUALIFICATION_ACTOR_USER_ID).toBe(test.run.actorUserId);
    expect(test.context.env.WORKER_CANARY_ORGANIZATION_ID).toBe(test.job.admissionRequest.organizationId);
    expect(test).not.toHaveProperty("env");
  });

  it("retains the real adapter's successful result and compute hold on strict pending cleanup, then recognizes only actual newer completion", async () => {
    const test = await fixture();
    expect(test.job.phase).toBe("completed"); expect(test.job.outcome.code).toBe(0); expect(test.job.retired).toBeUndefined();
    expect(test.row.builder.deletionOperationId).toBe(test.nativeOperation.id); expect(test.row.builder.deletionStage).toBeUndefined();
    expect(test.ledger().reservations.find((row: any) => row.computeId === `canary:${test.job.id}`)?.releasedAt).toBeUndefined();
    const { readRetentionCompletion } = await import("./worker-retention-proof");
    await expect(readRetentionCompletion(test.subject, test.context)).rejects.toThrow();
    test.complete();
    const before = structuredClone(test.state), writes = test.store.writeAdmission.mock.calls.length, calls = test.request.mock.calls.length;
    const proof = await readRetentionCompletion(test.subject, test.context);
    expect(proof.completedAt).toBe(test.nativeOperation.completedAt); expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(test.state).toEqual(before); expect(test.store.writeAdmission).toHaveBeenCalledTimes(writes);
    expect(test.request.mock.calls.slice(calls).every(([method]) => method === "GET")).toBe(true);
    expect(test.request.mock.calls.slice(calls).map(([, route]) => route)).toContain(`/deletion-operations/${test.nativeOperation.id}`);
    expect(test.request.mock.calls.slice(calls).map(([, route]) => route).indexOf(`/deletion-operations/${test.nativeOperation.id}`))
      .toBeLessThan(test.request.mock.calls.slice(calls).map(([, route]) => route).indexOf("/sandboxes/bx_native"));
  });

  it("does not redispatch the completed native work when the original strict adapter resumes", async () => {
    const test = await fixture(); test.complete();
    vi.useFakeTimers(); vi.setSystemTime(test.context.now());
    const result = await test.adapter.qualify(test.parent.candidate, test.job.kind);
    expect(result.outcome).toEqual(test.job.outcome); expect(test.retired).toHaveBeenCalledTimes(2);
    expect(test.request.mock.calls.filter(([method, route]) => method === "POST" && route === "/sandboxes")).toHaveLength(1);
    expect(test.request.mock.calls.filter(([method, route]) => method === "DELETE" && route === "/sandboxes/bx_native")).toHaveLength(1);
    expect(test.row.builder.deleted).toBe(true); expect(test.row.builder.physicalCleanup.operation.id).toBe(test.nativeOperation.id);
  });

  it("recognizes a later kind's newly completed hold while retaining the earlier strict physical and terminal proof", async () => {
    const first = await fixture(); first.complete();
    vi.useFakeTimers(); vi.setSystemTime(first.context.now());
    await first.adapter.qualify(first.parent.candidate, first.job.kind);
    first.job.auditRetired = { version: 1, operationId: first.job.id, deletionOperationId: first.nativeOperation.id };
    vi.setSystemTime(first.context.now() + 1000);
    const test = await fixture("bx_cursor", "cursor-api-key");
    test.subject.failedAttempt = "2"; test.job.admissionRequest.runAttempt = "2";
    test.run.canaries.unshift(first.job); test.state.resources.images.push(first.row);
    test.ledger().reservations.push(...first.ledger().reservations.filter((hold: any) => hold.computeId === `canary:${first.job.id}`));
    const firstWindow = await first.context.originalWorker("1"), secondWindow = await test.context.originalWorker("2");
    test.context.originalWorker.mockImplementation(async attempt => attempt === "1" ? firstWindow : secondWindow);
    const { readRetentionCompletion } = await import("./worker-retention-proof");
    await expect(readRetentionCompletion(test.subject, test.context)).rejects.toThrow(); test.complete();
    const calls = test.request.mock.calls.length, writes = test.store.writeAdmission.mock.calls.length;
    await expect(readRetentionCompletion(test.subject, test.context)).resolves.toHaveProperty("completedAt", test.nativeOperation.completedAt);
    expect(test.context.originalWorker.mock.calls).toContainEqual(["1"]); expect(test.context.originalWorker.mock.calls).toContainEqual(["2"]);
    expect(test.request.mock.calls.slice(calls).every(([method]) => method === "GET")).toBe(true);
    expect(test.store.writeAdmission).toHaveBeenCalledTimes(writes); expect(first.row.builder.deleted).toBe(true);
    test.job.admissionRequest.runAttempt = "1";
    test.context.originalWorker.mockImplementation(async () => firstWindow);
    await expect(readRetentionCompletion(test.subject, test.context)).rejects.toThrow("producing attempt");
  });

  it.each([
    ["owner", (test: any) => { test.state.owner = workerOwner("beta"); }],
    ["identity", (test: any) => { test.state.identity = "f".repeat(64); }],
    ["generation", (test: any) => { test.state.generation = "11111111-1111-4111-8111-111111111111"; }],
    ["account", (test: any) => { test.context.profile.boat.accountScope = "other-account"; }],
    ["billing organization", (test: any) => { test.context.profile.boat.billingOrg = "other-organization"; }],
    ["protected base", (test: any) => { test.context.profile.boat.baseSnapshot = "other-base"; }],
    ["active lease", (test: any) => { test.state.lease = { token: "11111111-1111-4111-8111-111111111111", expiresAt: test.context.now() + 1000 }; }],
    ["malformed lease", (test: any) => { test.state.lease = { expiresAt: "expired" }; }],
    ["source", (test: any) => { test.run.sourceSha = "f".repeat(40); }],
    ["inputs", (test: any) => { test.run.inputsSha256 = "f".repeat(64); }],
    ["actor", (test: any) => { test.run.actorUserId = "11111111-1111-4111-8111-111111111111"; }],
    ["organization", (test: any) => { test.job.admissionRequest.organizationId = "11111111-1111-4111-8111-111111111111"; }],
    ["original attempt", (test: any) => { test.job.admissionRequest.runAttempt = "2"; }],
    ["credential revision", (test: any) => { test.job.credentialRevision++; }],
    ["designation", (test: any) => { test.run.releaseCanaryBindings[0].designationId = "999"; }],
    ["profile", (test: any) => { test.job.qualificationProfile = "smoke"; }],
    ["candidate field", (test: any) => { test.parent.candidate.storageMiB++; }],
    ["candidate extra", (test: any) => { test.parent.candidate.untrusted = true; }],
    ["creation intent", (test: any) => { test.row.builderIntent.body.from = "other-image"; }],
    ["snapshot policy", (test: any) => { test.row.snapshotPolicyObserved.snapshots = true; }],
    ["prelaunch", (test: any) => { test.job.prelaunchFailure = { version: 1, stage: "private-input-upload", classification: "forbidden", status: 403 }; }],
    ["uncertain dispatch", (test: any) => { delete test.row.nativeDispatchStarted; }],
    ["absent operation", (test: any) => { delete test.row.builder.deletionOperationId; }],
    ["wrong operation", (test: any) => { test.nativeOperation.id = `bdop_${"f".repeat(32)}`; }],
    ["wrong target", (test: any) => { test.nativeOperation.targetId = "bx_other"; }],
    ["wrong kind", (test: any) => { test.nativeOperation.kind = "snapshot"; }],
    ["unknown status", (test: any) => { test.nativeOperation.status = "unknown"; }],
    ["unknown completion stage", (test: any) => { test.nativeOperation.stage = "waiting_for_restore"; }],
    ["old completion", (test: any) => { test.nativeOperation.completedAt = new Date(test.context.failedAt).toISOString(); }],
    ["future completion", (test: any) => { test.nativeOperation.completedAt = new Date(test.context.now() + 1000).toISOString(); }],
    ["new deletion after failed job", (test: any) => { test.nativeOperation.requestedAt = new Date(test.context.failedAt + 1000).toISOString(); }],
    ["sandbox still available", (test: any) => { test.available(); }],
    ["missing compute hold", (test: any) => { test.ledger().reservations.splice(test.ledger().reservations.findIndex((row: any) => row.computeId === `canary:${test.job.id}`), 1); }],
    ["released compute", (test: any) => { test.ledger().reservations.find((row: any) => row.computeId === `canary:${test.job.id}`).releasedAt = new Date().toISOString(); }],
    ["released image", (test: any) => { test.ledger().reservations.find((row: any) => row.snapshotName === test.parent.snapshotId).snapshotReleasedAt = new Date().toISOString(); }],
    ["failed result", (test: any) => { test.job.outcome.code = 1; }],
    ["retirement failed", (test: any) => { test.job.outcome.retirement = 1; }],
    ["rate limit", (test: any) => { test.job.outcome.errorKind = "rate-limited"; }],
    ["partial FULL", (test: any) => { test.job.outcome.report.checks = test.job.outcome.report.checks.filter((check: string) => check !== "transcriptFork"); }],
    ["stale evidence", (test: any) => { test.job.outcome.report.qualifiedAt = new Date(test.context.now() - 25 * 3600_000).toISOString(); }],
    ["duplicate allocation", (test: any) => { test.state.resources.images.push(structuredClone(test.row)); }],
    ["failed native producer", (test: any) => { test.context.originalWorker.mockRejectedValue(new Error("unconfirmed")); }],
  ] as const)("refuses %s without a provider or registry mutation", async (_label, change) => {
    const test = await fixture(); test.complete(); test.nativeOperation.stage = "completed";
    change(test); const calls = test.request.mock.calls.length, writes = test.store.writeAdmission.mock.calls.length;
    const { readRetentionCompletion } = await import("./worker-retention-proof");
    await expect(readRetentionCompletion(test.subject, test.context)).rejects.toThrow();
    expect(test.request.mock.calls.slice(calls).every(([method]) => method === "GET")).toBe(true);
    expect(test.store.writeAdmission).toHaveBeenCalledTimes(writes);
  });

  it("uses an immutable intent across independent observer invocations after a lost rerun response", async () => {
    const test = await fixture(); test.complete();
    const { prepareRetentionResume, requestRetentionResume } = await import("./worker-retention-resume");
    const { readRetentionCompletion } = await import("./worker-retention-proof");
    let armed = false;
    const deps = { inspect: vi.fn(async () => ({ sha256: "a".repeat(64), failedAt: test.context.failedAt })),
      assertIntentAvailable: vi.fn(async (_subject: any, current?: any) => { if (armed && !current) throw new Error("intent consumed"); }),
      completion: () => readRetentionCompletion(test.subject, test.context), verifyOwnIntent: vi.fn(async () => {}),
      markRequested: vi.fn(async () => {}), rerun: vi.fn(async () => { throw new Error("acknowledgement lost"); }) };
    const intent = await prepareRetentionResume(test.subject, test.producer, deps); armed = true;
    expect(await requestRetentionResume(intent, test.producer, deps)).toBe("unconfirmed");
    await expect(prepareRetentionResume(test.subject, { runId: "790", runAttempt: "1" }, deps)).rejects.toThrow("consumed");
    expect(deps.rerun).toHaveBeenCalledOnce(); expect(deps.rerun).toHaveBeenCalledWith(test.subject.jobId);
    expect(JSON.stringify(intent)).not.toContain(test.row.builder.id); expect(JSON.stringify(intent)).not.toContain(test.job.credentialId);
    expect(test.job.retired).toBeUndefined(); expect(test.row.builder.deleted).not.toBe(true);
  });

  it.each(["changed proof", "changed metadata", "lost upload", "lost local fence"])("does not POST after %s", async reason => {
    const test = await fixture(); test.complete();
    const { prepareRetentionResume, requestRetentionResume } = await import("./worker-retention-resume");
    const deps = { inspect: vi.fn(async () => ({ sha256: "a".repeat(64), failedAt: test.context.failedAt })), assertIntentAvailable: vi.fn(async () => {}),
      completion: vi.fn(async () => ({ sha256: "b".repeat(64), completedAt: test.nativeOperation.completedAt })),
      verifyOwnIntent: vi.fn(async () => {}), markRequested: vi.fn(async () => {}), rerun: vi.fn(async () => "accepted" as const) };
    const intent = await prepareRetentionResume(test.subject, test.producer, deps);
    if (reason === "changed proof") deps.completion.mockResolvedValue({ sha256: "c".repeat(64), completedAt: test.nativeOperation.completedAt });
    if (reason === "changed metadata") deps.inspect.mockResolvedValue({ sha256: "c".repeat(64), failedAt: test.context.failedAt });
    if (reason === "lost upload") deps.verifyOwnIntent.mockRejectedValue(new Error("lost"));
    if (reason === "lost local fence") deps.markRequested.mockRejectedValue(new Error("lost"));
    await expect(requestRetentionResume(intent, test.producer, deps)).rejects.toThrow(); expect(deps.rerun).not.toHaveBeenCalled();
  });

  it("rechecks active release conflicts after the final physical observation and before requesting", async () => {
    const test = await fixture(); test.complete();
    const { prepareRetentionResume, requestRetentionResume } = await import("./worker-retention-resume");
    const { readRetentionCompletion } = await import("./worker-retention-proof");
    let conflicting = false;
    const deps = { inspect: vi.fn(async () => { if (conflicting) throw new Error("active release"); return { sha256: "a".repeat(64), failedAt: test.context.failedAt }; }),
      assertIntentAvailable: vi.fn(async () => {}), completion: vi.fn(() => readRetentionCompletion(test.subject, test.context)),
      verifyOwnIntent: vi.fn(async () => {}), markRequested: vi.fn(async () => {}), rerun: vi.fn(async () => "accepted" as const) };
    const intent = await prepareRetentionResume(test.subject, test.producer, deps);
    deps.completion.mockImplementationOnce(async () => { const proof = await readRetentionCompletion(test.subject, test.context); conflicting = true; return proof; });
    await expect(requestRetentionResume(intent, test.producer, deps)).rejects.toThrow("active release");
    expect(deps.markRequested).not.toHaveBeenCalled(); expect(deps.rerun).not.toHaveBeenCalled();
  });

  it("allows a distinct later failed leaf only with its genuinely later native completion", async () => {
    const test = await fixture(); test.complete();
    const { prepareRetentionResume, retentionIntentKey } = await import("./worker-retention-resume");
    const deps = { inspect: vi.fn(async () => ({ sha256: "a".repeat(64), failedAt: test.context.failedAt })), assertIntentAvailable: vi.fn(async () => {}),
      completion: vi.fn(async () => ({ sha256: "b".repeat(64), completedAt: test.nativeOperation.completedAt })),
      verifyOwnIntent: vi.fn(async () => {}), markRequested: vi.fn(async () => {}), rerun: vi.fn(async () => "accepted" as const) };
    const first = await prepareRetentionResume(test.subject, test.producer, deps), next = { ...test.subject, failedAttempt: "2", jobId: "457" };
    deps.inspect.mockResolvedValue({ sha256: "c".repeat(64), failedAt: test.context.failedAt + 30_000 });
    await expect(prepareRetentionResume(next, { runId: "790", runAttempt: "1" }, deps)).rejects.toThrow();
    deps.completion.mockResolvedValue({ sha256: "d".repeat(64), completedAt: new Date(test.context.failedAt + 40_000).toISOString() });
    const second = await prepareRetentionResume(next, { runId: "790", runAttempt: "1" }, deps);
    expect(retentionIntentKey(first.subject)).not.toBe(retentionIntentKey(second.subject));
  });
});

describe("retention observer workflow isolation", () => {
  it("serializes only observers and leaves all real release/mutation queues unchanged", async () => {
    const text = await readFile(".github/workflows/worker-retention-resume.yml", "utf8");
    expect(text).toContain("group: worker-retention-resume-${{ needs.validate.outputs.channel }}");
    expect(text).not.toMatch(/group: (?:hosted-mutation|release-(?:alpha|beta|production))/);
    expect(text).toContain("cancel-in-progress: false"); expect(text).not.toContain("queue: max");
    expect(text).not.toMatch(/WORKER_CANARY_ADMISSION_TOKEN|RAILWAY_DEPLOY_TOKEN|PLANETSCALE_SERVICE_TOKEN|production-approval/);
    expect(text).toContain("environment: ${{ needs.validate.outputs.channel }}");
    expect(text).toContain("overwrite: false"); expect(text).toContain("retention-days: 90");
    expect(text.indexOf("name: Persist rerun intent")).toBeLessThan(text.indexOf("name: Request original failed worker once"));
    for (const workflow of ["hosted-promotion", "cloud-worker-promotion"]) {
      expect(await readFile(`.github/workflows/${workflow}.yml`, "utf8")).toContain("group: hosted-mutation-${{ inputs.channel }}");
    }
  });
});
