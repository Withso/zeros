import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseHostedAdmission, reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { nativeAgentCanary, nativeRuntimeEvidence } from "../dev-environment/native-agent-canary.mjs";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { main as imageKit } from "../cloud-workspace-validation/boat-image/boat-image";
import { boatImageAdapter } from "./worker-adapters";
import { assertWorkerSnapshotSlots, reconcileWorkerSnapshotHolds, reserveWorkerSlot, workerOwner, workerSnapshotName } from "./worker-admission";
import { workerExecutionConfig } from "./worker-config";
import { workerEnvironment, workerConnections } from "./worker-test-fixtures";
import { promoteWorker, validateWorkerReceipt, WorkerReceipt } from "./worker";
import { fixedCanaryOutcome, releaseCanaryAdapter } from "./worker-canary";
import { reconcileFailedReleaseBuilderHolds, reconcileReleaseBuilderRetentions, releaseBuilderCreationScope, retireReleaseBuilder, WorkerBuilderCleanupSchema } from "./worker-builder-retirement";
import { settleWorkerNamedRetirement, validateWorkerNamedRetirementEvidence, WorkerNamedNativeAuditSubjectSchema,
  workerNamedRetirementSha256 as namedDigest } from "./worker-named-retirement";
import { releaseCanaryCleanup, retireReleaseCanary } from "./worker-canary-recovery";
import { BoatAccountAdmission } from "../../apps/control-plane/src/cloud-workspaces/boat-account-admission";
import { DatabaseReleaseCanaryService, releaseCanaryRequest } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function failedBuilderFixture({ acknowledged = false } = {}) {
  const test = await fixture(), prefix = test.config.sourceSha.slice(0, 12);
  for (const key of ["candidate", "buildSha256", "qualified", "snapshotRequested", "snapshotCreate"]) delete test.record[key];
  for (const name of ["native-attestation.json", "snapshot-ledger.json"]) delete test.record.kitFiles[`${prefix}/${name}`];
  test.record.installStarted = true; test.record.attestationStarted = true;
  test.operation.requestedAt = new Date(Date.now() - 1000).toISOString();
  if (acknowledged) Object.assign(test.record.builder, { deleteRequested: true, deletionOperationId: test.operation.id,
    deletionAcceptedAt: test.operation.requestedAt });
  const base = test.request.getMockImplementation()!;
  test.request.mockImplementation((method, route, settings) => route === `/named-snapshots/${test.record.snapshotId}`
    ? Promise.resolve({ status: 404, body: null }) : base(method, route, settings));
  return test;
}

describe("failed image builder compute retirement", () => {
  it.each([false, true])("releases an unavailable uncaptured builder's compute hold with truthful pending storage (acknowledged=%s)", async acknowledged => {
    const test = await failedBuilderFixture({ acknowledged });
    await expect(test.adapter.cleanup()).resolves.toBeNull();
    expect(test.record.builder).toMatchObject({ deleted: false, retiredAt: expect.any(String),
      failedBuildRetirement: { kind: "failed-build-unavailable", storage: { status: "pending", physicalBytes: "unmeasured" } } });
    expect(test.record.builder.cleanup).toBeUndefined(); expect(test.record.candidate).toBeUndefined();
    expect(test.record.kitFiles).toBeDefined();
    expect(test.ledger().reservations.some((row: any) => row.kind === "builder")).toBe(false);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(acknowledged ? 0 : 1);
    const next = workerSnapshotName(test.state, "f".repeat(64));
    await expect(reserveWorkerSlot(test.store, test.context.lease, test.profile, "alpha", next,
      [{ provider: "boat", id: test.profile.boat.baseSnapshot }])).resolves.toBeDefined();
    expect(test.run.receipt).toBeUndefined();
  });
  it.each([
    ["captured snapshot", (test: any) => { test.record.snapshotRequested = true; }],
    ["capture intent", (test: any) => { test.record.snapshotCreate = { phase: "uncertain" }; }],
    ["candidate", (test: any) => { test.record.candidate = test.candidate; }],
    ["unacknowledged create", (test: any) => { test.record.builderCreate.phase = "uncertain"; }],
    ["wrong original account", (test: any) => { test.record.builderIntent.scope.accountBinding = "f".repeat(64); }],
    ["wrong original source", (test: any) => { test.record.builderIntent.scope.sourceSha = "f".repeat(40); }],
    ["credential-bearing create", (test: any) => { test.record.builderIntent.body.env = { PRIVATE: "synthetic" }; }],
    ["lost delete acknowledgement", (test: any) => { delete test.record.builder.deletionOperationId; }],
    ["wrong operation target", (test: any) => { test.operation.targetId = "bx_other"; }],
  ] as const)("retains the hold for %s", async (_name, change) => {
    const test = await failedBuilderFixture({ acknowledged: true }); change(test);
    const before = structuredClone(test.ledger());
    await expect(test.adapter.cleanup()).rejects.toThrow();
    expect(test.ledger()).toEqual(before); expect(test.context.release).not.toHaveBeenCalled();
    expect(test.record.builder.retiredAt).toBeUndefined();
    expect(test.request.mock.calls.some(([method]) => method === "DELETE")).toBe(false);
  });
  it("does not release admission when saving the unavailable-builder proof fails", async () => {
    const test = await failedBuilderFixture({ acknowledged: true }), before = structuredClone(test.ledger());
    test.context.lease.save.mockRejectedValueOnce(new Error("synthetic failed proof write"));
    await expect(test.adapter.cleanup()).rejects.toThrow("synthetic failed proof write");
    expect(test.context.release).not.toHaveBeenCalled(); expect(test.ledger()).toEqual(before);
    expect(test.saves.at(-1)?.resources.images[0].builder.failedBuildRetirement).toBeUndefined();
  });
  it("recovers an interrupted admission release and later reenters after its row is pruned", async () => {
    const test = await failedBuilderFixture({ acknowledged: true });
    test.store.writeAdmission.mockRejectedValueOnce(new Error("synthetic admission interruption"));
    await expect(test.adapter.cleanup()).rejects.toThrow("synthetic admission interruption");
    expect(test.record.builder.retiredAt).toBeDefined(); expect(imageHold(test).releasedAt).toBeUndefined();
    await expect(test.adapter.cleanup()).resolves.toBeNull();
    await expect(test.adapter.cleanup()).resolves.toBeNull();
    expect(test.ledger().reservations.some((row: any) => row.kind === "builder")).toBe(false);
    expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    expect(WorkerBuilderCleanupSchema.safeParse(test.record.builder.failedBuildRetirement).success).toBe(false);
    await expect(reconcileReleaseBuilderRetentions(test.config, test.context)).resolves.toBeUndefined();
    test.record.builder.failedBuildRetirement.provenance.source.commit = "f".repeat(40);
    await expect(test.adapter.cleanup()).rejects.toThrow("retained retirement proof changed");
  });
  it.each(["available builder", "named image", "unknown deletion stage"])("retains compute for %s", async change => {
    const test = await failedBuilderFixture({ acknowledged: true }), base = test.request.getMockImplementation()!;
    if (change === "unknown deletion stage") test.operation.stage = "unknown";
    else test.request.mockImplementation((method, route, settings) => route === (change === "available builder"
      ? `/sandboxes/${test.record.builder.id}` : `/named-snapshots/${test.record.snapshotId}`)
      ? Promise.resolve({ status: 200, body: {} }) : base(method, route, settings));
    await expect(test.adapter.cleanup()).rejects.toThrow();
    assertHeld(test); expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("observes only the acknowledged failed build occupying a later run's slot, then uses ordinary admission", async () => {
    const test = await failedBuilderFixture({ acknowledged: true });
    test.state.resources.images.push({ purpose: "release-worker", releaseRunId: "121", builder: { id: "bx_unrelated", retiredAt: new Date().toISOString() } });
    const original = structuredClone(test.state.resources.images[1]);
    const nextConfig = { ...test.config, runId: "124", sourceSha: "f".repeat(40) };
    await reconcileFailedReleaseBuilderHolds(nextConfig, test.context, test.store);
    expect(test.state.resources.images[1]).toEqual(original);
    expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    const next = workerSnapshotName(test.state, digest([nextConfig.sourceSha, nextConfig.runId]));
    await expect(reserveWorkerSlot(test.store, test.context.lease, test.profile, "alpha", next,
      [{ provider: "boat", id: test.profile.boat.baseSnapshot }])).resolves.toBeDefined();
    expect(test.ledger().reservations.filter((row: any) => row.kind === "builder" && !row.releasedAt)).toHaveLength(1);
  });
  it("preserves physical-only cleanup for a failed build without deferred-retirement provenance", async () => {
    const test = await failedBuilderFixture({ acknowledged: true });
    delete test.record.builder.billingOrgConfirmed;
    delete test.record.builderIntent.scope;
    test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString();
    await expect(test.adapter.cleanup()).resolves.toMatchObject({ kind: "physically-deleted" });
    expect(test.record.builder.deleted).toBe(true);
    expect(test.record.builder.failedBuildRetirement).toBeUndefined();
    expect(test.ledger().reservations.some((row: any) => row.kind === "builder")).toBe(false);
  });
});

async function fixture({ savedAgeMs = 20_000, sourceCommit = "a".repeat(40), runId = "123" } = {}) {
  const environment: NodeJS.ProcessEnv = { ...workerEnvironment(), GITHUB_SHA: sourceCommit, RELEASE_SHA: sourceCommit, GITHUB_RUN_ID: runId };
  const { config } = workerExecutionConfig(environment);
  const profile = { boat: { accountScope: environment.BOAT_ACCOUNT_SCOPE!, billingOrg: environment.BOAT_BILLING_ORG!, baseSnapshot: environment.BOAT_BASE_SNAPSHOT! },
    railway: { projectId: config.projectId }, planetscale: { organization: config.organization, database: config.database }, cloudflare: { accountId: "test-account" } };
  const account = digest([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId,
    profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId]);
  const state: any = { version: 2, owner: workerOwner(config.channel), generation: "11111111-1111-4111-8111-111111111111",
    identity: digest(["release-worker", config.repository, config.channel]), status: "provisioning", createdAt: new Date(Date.now() - savedAgeMs - 40_000).toISOString(), resources: { images: [] }, releaseRuns: [] };
  const snapshotId = workerSnapshotName(state, digest([config.sourceSha, config.runId]));
  const candidate = { snapshotId, sourceCommit: config.sourceSha, buildSha256: "b".repeat(64), architecture: "linux/amd64" as const, storageMiB: 4096 };
  const run: any = { runId: config.runId, sourceSha: config.sourceSha, inputsSha256: "e".repeat(64), qualificationProfile: "smoke", canaries: [] };
  const createdAt = new Date(Date.now() - savedAgeMs - 25_000).toISOString(), savedAt = new Date(Date.now() - savedAgeMs).toISOString();
  const body = { type: "default", from: profile.boat.baseSnapshot, ttlSeconds: 3600, noEnv: true, env: {} };
  const scope = { repository: config.repository, channel: config.channel, runId: config.runId, runAttempt: config.runAttempt,
    sourceSha: config.sourceSha, inputsSha256: run.inputsSha256, owner: state.owner, generation: state.generation, accountBinding: account,
    protectedBaseSnapshot: profile.boat.baseSnapshot };
  const prefix = config.sourceSha.slice(0, 12);
  const builderId = runId === "123" ? "bx_builder" : `bx_builder${runId}`;
  const record: any = { purpose: "release-worker", releaseRunId: config.runId, inputsSha256: run.inputsSha256, sourceCommit: config.sourceSha,
    snapshotId, candidate, buildSha256: candidate.buildSha256, qualified: true, snapshotRequested: true,
    builderCreate: { phase: "acknowledged" }, snapshotCreate: { phase: "acknowledged" },
    builder: { id: builderId, billingOrgConfirmed: true, billingObservedAt: createdAt, accountBinding: account },
    builderIntent: { key: "22222222-2222-4222-8222-222222222222", body, at: Date.parse(createdAt), scope },
    kitFiles: { "builder.json": JSON.stringify({ id: builderId, from: body.from, type: body.type, createdAt }),
      [`${prefix}/source.json`]: JSON.stringify({ parent: config.sourceSha, commit: config.sourceSha, tree: "c".repeat(40), archiveSha256: "d".repeat(64),
        archiveBytes: 12345, parts: 1, sourceFiles: 5, exactMergedCommit: true }),
      [`${prefix}/generation.json`]: JSON.stringify({ commit: config.sourceSha, previous: "f".repeat(40), contract: imageContractSha256(),
        attempt: `m2-build-${"f".repeat(32)}`, scriptSha256: "a".repeat(64), snapshotName: snapshotId, buildSha256: candidate.buildSha256 }),
      [`${prefix}/native-attestation.json`]: JSON.stringify({ qualified: true, setupQualification: { secure: true },
        metadata: { buildSha256: candidate.buildSha256, build: { source: { commit: config.sourceSha } } }, resources: { allocation: { storageBytes: 4096 * 1048576 } } }),
      [`${prefix}/snapshot-ledger.json`]: JSON.stringify({ version: 1, name: snapshotId, resourceId: builderId, sourceCommit: config.sourceSha,
        buildSha256: candidate.buildSha256, state: "ready", snapshotId: "snapshot-test", createdAt: savedAt, lastObservedAt: savedAt,
        sanitation: { qualified: true, sourceCommit: config.sourceSha, buildSha256: candidate.buildSha256, observedAt: savedAt } }) } };
  state.resources.images.push(record); state.releaseRuns.push(run);
  let ledger: any = { version: 1, owner: "account-admission", account, reservations: [] };
  let revision = 1;
  const saves: any[] = [];
  const lease = { state, signal: new AbortController().signal, save: vi.fn(async () => { saves.push(structuredClone(state)); }), fence: vi.fn(async () => {}) };
  const store = { list: vi.fn(async () => ({ records: [], quarantine: [] })),
    read: vi.fn(async () => ({ state: structuredClone(saves.at(-1) ?? state), etag: "owned-journal" })),
    readAdmission: vi.fn(async () => ({ state: structuredClone(ledger), etag: String(revision) })),
    writeAdmission: vi.fn(async (value: any, etag: string) => {
      expect(etag).toBe(String(revision)); ledger = structuredClone(value); revision++;
    }) };
  const inventory = [{ provider: "boat", id: profile.boat.baseSnapshot }, { provider: "boat", id: snapshotId }];
  await reserveWorkerSlot(store, lease, profile, config.channel, snapshotId, inventory);
  // Admission precedes the original builder create in the maintained worker.
  ledger.reservations.find((row: any) => row.snapshotName === snapshotId).createdAt = new Date(Date.parse(createdAt) - 1).toISOString();
  const operation: any = { id: `bdop_${(runId === "123" ? "c" : "d").repeat(32)}`, kind: "sandbox", targetId: record.builder.id,
    status: "blocked", stage: "waiting_for_uploads", expectedBy: new Date(Date.now() + 6 * 3600_000).toISOString() };
  const request = vi.fn(async (method: string, route: string, _settings?: any): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    if (route.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: 0 } };
    if (route === `/named-snapshots/${snapshotId}`) return { status: 200, body: { snapshot: { name: snapshotId, sourceSandboxId: record.builder.id, status: "ready" } } };
    if (method === "DELETE" && route === `/sandboxes/${record.builder.id}`) return { status: 202, body: { operation: structuredClone(operation) } };
    if (route === `/deletion-operations/${operation.id}`) return { status: 200, body: { operation: structuredClone(operation) } };
    if (route === `/sandboxes/${record.builder.id}`) return { status: 404, body: null };
    throw new Error("Unexpected synthetic Boat request");
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-release-builder-test-")); directories.push(directory);
  const context = { lease, record, run, profile, maxUsedHours: 2, snapshotName: snapshotId, request,
    readAdmission: () => store.readAdmission(), reserve: vi.fn(),
    release: vi.fn(async () => { await releaseHostedAdmission(store, lease, profile); }), kit: vi.fn() };
  const adapter = await boatImageAdapter(config, environment, directory, context);
  return { adapter, config, environment, profile, state, record, run, candidate, context, operation, request, saves, store, inventory, ledger: () => ledger, directory };
}

async function historicalFixture() {
  const repository = await mkdtemp(path.join(os.tmpdir(), "zeros-release-retention-recovery-")); directories.push(repository);
  const git = (...arguments_: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=Release Recovery Fixture", "-c", "user.email=release-recovery@example.invalid", ...arguments_],
    { cwd: repository, encoding: "utf8", env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "-q"); await writeFile(path.join(repository, "fixture.txt"), "historical release source\n");
  git("add", "fixture.txt"); git("commit", "-q", "-m", "synthetic historical release");
  const test = await fixture({ sourceCommit: git("rev-parse", "HEAD") });
  patchProof(test, "source", proof => { proof.tree = git("rev-parse", "HEAD^{tree}"); });
  await writeFile(path.join(repository, "fixture.txt"), "next release source\n");
  git("add", "fixture.txt"); git("commit", "-q", "-m", "synthetic next release");
  return { ...test, nextConfig: { ...test.config, sourceSha: git("rev-parse", "HEAD"), runId: "124" } };
}

function patchProof(test: Awaited<ReturnType<typeof fixture>>, name: string, change: (value: any) => void) {
  const file = `${test.config.sourceSha.slice(0, 12)}/${name}.json`, value = JSON.parse(test.record.kitFiles[file]);
  change(value); test.record.kitFiles[file] = JSON.stringify(value);
}
function assertHeld(test: Awaited<ReturnType<typeof fixture>>) {
  expect(test.record.builder.retiredAt).toBeUndefined();
  expect(test.record.builder.deleted).not.toBe(true);
  expect(test.context.release).not.toHaveBeenCalled();
  expect(test.ledger().reservations.find((row: any) => row.snapshotName === test.candidate.snapshotId)?.releasedAt).toBeUndefined();
  expect(test.ledger().reservations.find((row: any) => row.snapshotName === test.candidate.snapshotId)?.snapshotReleasedAt).toBeUndefined();
}
function imageHold(test: Awaited<ReturnType<typeof fixture>>) {
  const reservation = test.ledger().reservations.find((row: any) => row.kind === "builder" && row.snapshotName === test.candidate.snapshotId);
  expect(reservation).toBeDefined(); return reservation;
}
function nativeHarness(test: Awaited<ReturnType<typeof fixture>>, blocked = false, deferStorage = false, qualificationProfile: "smoke" | "full" = "smoke") {
  const base = test.request.getMockImplementation()!, sandboxes = new Map<string, any>(), operations = new Map<string, any>();
  let recorded = 0;
  test.request.mockImplementation(async (method, route, ...settings: any[]) => {
    if (method === "POST" && route === "/sandboxes") {
      throw new Error("Historical cleanup cannot allocate a fresh native canary");
    }
    if (route.startsWith("/sandboxes/bx_native")) {
      const id = route.slice("/sandboxes/".length);
      if (method === "DELETE") {
        const operation = { id: `bdop_${id.slice("bx_native".length).padStart(32, "0")}`, kind: "sandbox", targetId: id,
          status: blocked ? "blocked" : "completed", stage: blocked ? "waiting_for_uploads" : "completed",
          expectedBy: test.operation.expectedBy, requestedAt: new Date().toISOString(), completedAt: blocked ? null : new Date().toISOString() };
        operations.set(operation.id, operation); sandboxes.delete(id); return { status: 202, body: { operation } } as any;
      }
      return sandboxes.has(id) ? { status: 200, body: { sandbox: sandboxes.get(id) } } as any : { status: 404 } as any;
    }
    if (route.startsWith("/deletion-operations/") && operations.has(route.slice("/deletion-operations/".length)))
      return { status: 200, body: { operation: operations.get(route.slice("/deletion-operations/".length)) } } as any;
    return base(method, route, ...settings);
  });
  const release = () => releaseHostedAdmission(test.store, test.context.lease, test.profile);
  const native = nativeAgentCanary(test.context.lease, { ...test.profile, boat: { ...test.profile.boat, builderBudgetHours: 0.25 } }, test.request, {
    reserve: (job: any) => reserveHostedAdmission(test.store, test.state, test.profile, { kind: "builder", computeId: `canary:${job.id}` }), release,
  }, { strictCleanup: true, releaseStorageDeferral: deferStorage, maxUsedHours: 2, cleanupTimeoutMs: 0, nativeDeadlineSeconds: 420 });
  const connections = workerConnections(), audits: any[] = [];
  const archivedOutcome = (job: any) => fixedCanaryOutcome({
    code: 0, retirement: 0, renewal: { accountBinding: true, accessChanged: true, cachePublished: true, consentPreserved: true },
    report: { version: 3, qualified: true, qualificationProfile, executionProfile: "zeros-cloud-native-v1", authority: "isolated-image-canary",
      qualifiedAt: new Date().toISOString(), identity: { sourceCommit: test.candidate.sourceCommit, buildSha256: test.candidate.buildSha256,
        contractSha256: "c".repeat(64), kind: job.kind, model: job.model },
      checks: ["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission", "stopAndRevocation", "nativeTurn", "nativeResume",
        "authentication", "nativePermissionSelection", "nativeAccessRefresh", "nativeMcp", ...(qualificationProfile === "full"
          ? ["transcriptFork", ...(job.kind === "codex-chatgpt" ? ["nativeGoals", "nativeFork", "nativeReview", "nativeApps", "nativeMultiAgent"] : [])] : [])] } },
    { kind: job.kind, model: job.model, image: test.candidate });
  const core = { ...native, ready: vi.fn(), start: vi.fn(), poll: vi.fn() };
  const seedAdmission = (job: any) => {
    const actor = "44444444-4444-4444-8444-444444444444", organizationId = "33333333-3333-4333-8333-333333333333";
    const row = test.state.resources.images.find((value: any) => value.agentQualificationId === job.id);
    const request = releaseCanaryRequest({ version: 1, ownerUserId: actor, organizationId, channel: test.config.channel, sourceSha: test.config.sourceSha,
      repository: test.config.repository, qualificationProfile, operationId: job.id, runId: test.run.runId, runAttempt: test.config.runAttempt,
      branch: test.config.branch, ...connections.find(connection => connection.kind === job.kind), target: native.target(job) },
    { ownerUserId: actor, organizationId, channel: test.config.channel, sourceSha: test.config.sourceSha, repository: test.config.repository });
    job.admissionRequest = request;
    audits.push({ id: String(audits.length + 1), action: "cloud.release_canary.started", subject: { ...connections.find(connection => connection.kind === job.kind),
      operationId: job.id, requestSha256: digest(request), qualificationProfile, channel: request.channel, sourceSha: request.sourceSha,
      repository: request.repository, runId: request.runId, runAttempt: request.runAttempt, targetId: row.builder.id,
      imageRef: `boat:${test.candidate.snapshotId}@sha256:${test.candidate.buildSha256}`, allowanceOwnerUserId: actor } });
  };
  {
    const actor = "44444444-4444-4444-8444-444444444444", organizationId = "33333333-3333-4333-8333-333333333333";
    const token = "synthetic-release-storage-authorization";
    test.state.lease = { token: "77777777-7777-4777-8777-777777777777", expiresAt: Date.now() + 60_000 };
    test.run.actorUserId = actor; test.run.qualificationProfile = qualificationProfile; test.run.releaseCanaryBindings = connections;
    const admission = new BoatAccountAdmission({ ...test.store, readDocument: async () => ({ state: test.state, etag: "native-journal" }) } as any, test.profile);
    const query = vi.fn(async (sql: string, values: any[] = []): Promise<any> => {
      if (sql.includes("FROM users account")) return { rowCount: 1, rows: [] };
      if (sql.includes("FROM cloud_agent_credentials")) return { rowCount: 1, rows: [{ owner_user_id: actor }] };
      if (sql.includes("FROM audit_log")) return { rowCount: 1, rows: [structuredClone(audits.filter(audit => audit.subject.operationId === values[3]).at(-1))] };
      if (sql.startsWith("INSERT INTO audit_log")) {
        const audit = { id: String(audits.length + 1), createdAt: new Date().toISOString(), action: values[2], subject: JSON.parse(values[3]) }; audits.push(audit);
        return { rowCount: 1, rows: [{ id: audit.id }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const service = new DatabaseReleaseCanaryService({ connect: async () => ({ query, release: vi.fn() }) } as any, {
      ownerUserId: actor, organizationId, channel: test.config.channel, repository: test.config.repository, sourceSha: test.config.sourceSha,
      tokenSha256: createHash("sha256").update(token).digest("hex"), keys: {} as any, admission,
      boat: { apiKey: "synthetic-boat-authority", apiUrl: "https://boat.example.test", billingOrg: test.profile.boat.billingOrg },
    });
    vi.stubGlobal("fetch", vi.fn(async (url: any, options: any) => {
      expect(options.method).toBe("GET");
      const reply = await test.request("GET", new URL(url).pathname);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }));
    core.retire = (job: any) => retireReleaseCanary(test.context.lease, native, async (operationId, deletionOperationId, leaseToken) => {
      const reply = await service.retire({ version: 1, operationId, deletionOperationId, leaseToken }, `Bearer ${token}`);
      return "storagePending" in reply ? "storage-pending" : "physically-deleted";
    }, job);
  }
  const canary = releaseCanaryAdapter(test.context.lease, test.run, new Map(connections.map(row => [row.kind, row])), core, { qualificationProfile });
  const seed = async (kind: string) => {
    // Seed an already-dispatched historical journal and primary admission
    // audit. Only the maintained retirement adapter runs against these rows.
    const index = ++recorded, id = `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
    const now = Date.now(), builderId = `bx_native${index}`;
    const job: any = { id, ...connections.find(connection => connection.kind === kind), qualificationProfile, phase: "completed", startedAt: now - 5000,
      image: { snapshotId: test.candidate.snapshotId, sourceCommit: test.candidate.sourceCommit, buildSha256: test.candidate.buildSha256 } };
    await reserveHostedAdmission(test.store, test.state, test.profile, { kind: "builder", computeId: `canary:${id}` });
    test.state.resources.images.push({ purpose: "native-agent-qualification", agentQualificationId: id,
      inputsSha256: createHash("sha256").update(`native-agent:${id}`).digest("hex"),
      sourceCommit: job.image.sourceCommit, sourceImage: job.image.snapshotId, maxUsedHours: 2, snapshotPolicyVersion: 1,
      machineAttestationStarted: true, nativeDispatchStarted: true, builderCreate: { phase: "acknowledged" }, builder: { id: builderId },
      builderIntent: { key: id, at: now - 10_000, body: { type: "default", from: job.image.snapshotId, ttlSeconds: 420, noEnv: true, env: {}, snapshots: false } },
      snapshotPolicyObserved: { version: 1, targetId: builderId, snapshots: false, observedAt: new Date(now - 5000).toISOString() } });
    sandboxes.set(builderId, { id: builderId, team: { id: test.profile.boat.billingOrg }, state: "running", snapshots: false });
    job.outcome = archivedOutcome(job); test.run.canaries.push(job); seedAdmission(job);
    await test.context.lease.save(); return job;
  };
  const input = { ...test.config, kinds: connections.map(row => row.kind), actorUserId: "44444444-4444-4444-8444-444444444444",
    operationId: "55555555-5555-4555-8555-555555555555", inputsSha256: test.run.inputsSha256, qualificationProfile, releaseCanaryBindings: connections };
  const owner = vi.fn(async (action: any) => ({ value: await action({ loginIdentity: "synthetic-owner", manage: async (_document: any, approval: string) =>
    ({ state: approval ? "changed" : "planned", planSha256: "d".repeat(64), targetSha256: "f".repeat(64) }) }), deleted: true }));
  const tuple = vi.fn(async () => {});
  const deps = { build: () => test.adapter.build(), cleanupBuilder: () => test.adapter.cleanup(), qualify: (image: any, kind: string) => canary.qualify(image, kind),
    cleanup: async () => {
      const deleted = await canary.cleanup(), imageBuilder = await test.adapter.cleanup();
      return deleted && imageBuilder ? { ...releaseCanaryCleanup(test.context.lease, test.run), imageBuilder } : null;
    }, withOwner: owner, updateIdentity: tuple };
  return { native, canary, core, input, deps, owner, tuple, sandboxes, operations, audits, seed, recorded: () => recorded,
    allocations: () => test.request.mock.calls.filter(([method, route]) => method === "POST" && route === "/sandboxes").length };
}

async function historicalReceipt(test: Awaited<ReturnType<typeof fixture>>, native: ReturnType<typeof nativeHarness>) {
  await test.adapter.cleanup();
  for (const kind of native.input.kinds) {
    await native.seed(kind); expect(await native.canary.cleanup()).toBe(true);
  }
  const cleanup = await native.deps.cleanup(); expect(cleanup).not.toBeNull();
  const evidence = test.run.canaries.map((job: any) => nativeRuntimeEvidence(test.candidate, job, job.outcome, job.startedAt));
  // Retained approval/owner-role receipts are fixture history, not new
  // approval or provider tuple operations from the retired promotion lane.
  test.run.approval = { phase: "applied", planSha256: "d".repeat(64), targetSha256: "f".repeat(64) };
  test.run.ownerRole = { deleted: true };
  return WorkerReceipt.parse({ version: cleanup!.credentialCanaryResourcesDeleted ? 2 : 3, status: "success", channel: native.input.channel,
    sourceSha: native.input.sourceSha, repository: native.input.repository, branch: native.input.branch, runId: native.input.runId,
    runAttempt: native.input.runAttempt, inputsSha256: native.input.inputsSha256,
    worker: { provider: "boat", imageRef: `boat:${test.candidate.snapshotId}@sha256:${test.candidate.buildSha256}`, sourceSha: test.candidate.sourceCommit,
      architecture: test.candidate.architecture, storageMiB: test.candidate.storageMiB },
    qualifiedKinds: native.input.kinds, qualificationProfile: native.input.qualificationProfile, runtimeContractSha256: evidence[0].runtimeContractSha256,
    evidenceSha256: digest(evidence), approvalPlanSha256: test.run.approval.planSha256, approvalTargetSha256: test.run.approval.targetSha256,
    roleDeleted: test.run.ownerRole.deleted, cleanup, completedAt: new Date().toISOString() });
}

function namedRetirementEvidence(test: Awaited<ReturnType<typeof fixture>>, native: ReturnType<typeof nativeHarness>, names: string[]) {
  const now = Date.now(), at = (offset: number) => new Date(now + offset).toISOString();
  const natives = test.run.canaries.map((job: any) => {
    const row = test.state.resources.images.find((value: any) => value.agentQualificationId === job.id);
    const audit = native.audits.filter(value => value.subject.operationId === job.id).at(-1);
    return { admissionRequest: structuredClone(job.admissionRequest), creation: structuredClone(row.builderIntent),
      cleanup: structuredClone(row.builder.physicalCleanup ?? row.builder.storageRetirement),
      marker: structuredClone(job.auditRetired), audit: { id: audit.id, organizationId: job.admissionRequest.organizationId,
        actorUserId: job.admissionRequest.ownerUserId, action: audit.action, subject: structuredClone(audit.subject), databaseKey: "synthetic-primary-audits",
        createdAt: audit.createdAt, observedAt: at(-40), primary: true, policyVisible: true, latestAcrossAllPhases: true } };
  });
  const domains = ["configurations", "deployments", "registries", "archives", "application", "primary-audits", "reference-writers"];
  return { version: 1, scope: structuredClone(test.record.builder.cleanup.provenance.scope),
    builder: structuredClone(test.record.builder.cleanup),
    creates: { builderSha256: digest(test.record.builderCreate), snapshotSha256: digest(test.record.snapshotCreate) }, audit: { natives },
    bundle: { sourceSha: "d".repeat(40), treeSha: "e".repeat(40), actionSha256: "f".repeat(64),
      collectorSha256: "c".repeat(64), reviewArtifactSha256: "a".repeat(64), reviewerId: "88888888-8888-4888-8888-888888888888", reviewedAt: at(-30) },
    observedAt: at(-40), expiresAt: at(59_000),
    inventory: { complete: true, observedAt: at(-40), names: [...names].sort() },
    references: domains.map(domain => ({ domain, observedAt: at(-40), complete: true,
      authorities: [{ namespace: `synthetic-${domain}`, accountBinding: test.ledger().account, identitySha256: "a".repeat(64), authenticated: true, policyVisible: true,
        projection: { domain, selectors: [], complete: true }, projectionSha256: namedDigest({ domain, selectors: [], complete: true }),
        records: [{ key: "complete-namespace", referenceCount: 0, unresolvedCount: 0, references: [], disposition: "unreferenced" }] }] })),
    exclusion: { id: "99999999-9999-4999-8999-999999999999", accountBinding: test.ledger().account,
      startedAt: at(-10_000), expiresAt: at(290_000), owners: [test.state.owner], namespaces: domains.map(domain => `synthetic-${domain}`),
      controllers: [{ identitySha256: "b".repeat(64), oldAndDrainingWritersCovered: true, inFlightWritersCovered: true, excluded: true,
        projection: { workflows: [], otherLeases: [], complete: true }, projectionSha256: namedDigest({ workflows: [], otherLeases: [], complete: true }) }] } };
}

function acknowledgeNamedRetirement(test: Awaited<ReturnType<typeof fixture>>, native: ReturnType<typeof nativeHarness>) {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
  const now = Date.now(), at = (offset: number) => new Date(now + offset).toISOString();
  const intent = { phase: "intent-saved", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", savedAt: at(-20),
    leaseToken: test.state.lease.token, reservation: structuredClone(imageHold(test)),
    target: { provider: "boat", name: test.candidate.snapshotId, sourceSandboxId: test.record.builder.id, candidate: structuredClone(test.candidate) },
    namedSnapshot: { name: test.candidate.snapshotId, sourceSandboxId: test.record.builder.id, status: "ready", observedAt: at(-40) },
    review: namedRetirementEvidence(test, native, test.inventory.map(row => row.id)) };
  // The separately authorized helper owns actual dispatch. This fixture keeps
  // its already-consumed, typed response; the maintained worker sends only GETs.
  const acknowledgement = { version: 2, kind: "release-owned-named-deletion", consumed: true, phase: "acknowledged", intent,
    dispatch: { phase: "dispatching", intentSha256: namedDigest(intent), intentFencedAt: at(-15), savedAt: at(-10), fencedAt: at(-5), leaseToken: intent.leaseToken },
    acknowledgedAt: at(0), response: { status: 200, type: "snapshot.named.deleted", name: test.candidate.snapshotId, statusText: "deleted" } };
  test.record.snapshotDeleteRequested = true; test.record.snapshotDeleteIntent = acknowledgement;
  test.record.snapshotRetirementReview = { version: 1, kind: "release-owned-name-retirement-review", acknowledgementSha256: namedDigest(acknowledgement),
    evidence: namedRetirementEvidence(test, native, [test.profile.boat.baseSnapshot]) };
}

async function namedFixture() {
  const test = await fixture(), native = nativeHarness(test, true, true, "full");
  await test.adapter.cleanup();
  for (const kind of native.input.kinds.slice(0, 2)) { await native.seed(kind); expect(await native.canary.cleanup()).toBe(true); }
  await native.canary.cleanup();
  test.run.canaries[1].outcome.code = 1; test.run.canaries[1].outcome.report.qualified = false;
  acknowledgeNamedRetirement(test, native);
  await test.context.lease.save(); await test.context.lease.fence();
  const original = test.request.getMockImplementation()!, absentInventory = [{ provider: "boat", id: test.profile.boat.baseSnapshot }];
  test.request.mockImplementation(async (method, route, settings) => route === `/named-snapshots/${test.candidate.snapshotId}`
    ? { status: 404, body: null } : route === "/named-snapshots" ? { status: 200, body: { snapshots: absentInventory.map(row => ({ name: row.id })) } }
      : original(method, route, settings));
  test.request.mockClear(); test.store.writeAdmission.mockClear();
  return { ...test, native, absentInventory, settle: () => settleWorkerNamedRetirement(test.store, test.context.lease, test.profile, test.record, absentInventory, test.request) };
}
function rebindNamedFixture(test: Awaited<ReturnType<typeof namedFixture>>) {
  const ack = test.record.snapshotDeleteIntent;
  if (ack?.dispatch) ack.dispatch.intentSha256 = namedDigest(ack.intent);
  test.record.snapshotRetirementReview.acknowledgementSha256 = namedDigest(ack);
}

describe("release-owned named retirement authority and recovery", () => {
  it.each([false, true])("retains strict original native audit parsing across the schema bridge (pending=%s)", async pending => {
    const test = await fixture(), native = nativeHarness(test, pending, true, "full");
    try {
      await test.adapter.cleanup();
      const job = await native.seed(native.input.kinds[0]!); await native.core.retire(job);
      expect(await native.canary.cleanup()).toBe(true);
      const subject = namedRetirementEvidence(test, native, test.inventory.map(row => row.id)).audit.natives[0]!.audit.subject;
      expect(subject.retirement.version).toBe(pending ? 2 : 1);
      expect(WorkerNamedNativeAuditSubjectSchema.parse(subject)).toEqual(subject);
      expect(WorkerNamedNativeAuditSubjectSchema.parse({ ...subject, beforeVersion: 2 })).toEqual({ ...subject, beforeVersion: 2 });
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"])
        expect(WorkerNamedNativeAuditSubjectSchema.safeParse({ ...subject, beforeVersion: value }).success).toBe(false);
      for (const change of [
        (value: any) => { value.unexpected = true; },
        (value: any) => { value.retirement.unexpected = true; },
        (value: any) => { value.retirement.operation.unexpected = true; },
        (value: any) => { value.retirement.operation.targetId = "bx_foreign"; },
        (value: any) => { value.retirement.unavailableObservedAt = "2000-01-01T00:00:00.000Z"; },
        (value: any) => { delete value.retirement; },
      ]) {
        const invalid = structuredClone(subject); change(invalid);
        expect(WorkerNamedNativeAuditSubjectSchema.safeParse(invalid).success).toBe(false);
      }
    } finally { vi.unstubAllGlobals(); }
  });
  it("validates complete pre-action evidence against the actual lease, original named row and primary native audits", async () => {
    const test = await namedFixture();
    try {
      const evidence = test.record.snapshotDeleteIntent.intent.review;
      expect(validateWorkerNamedRetirementEvidence(test.state, test.ledger(), test.profile, test.record, evidence)).toMatchObject({ version: 1 });
      const lease = test.state.lease; delete test.state.lease;
      expect(() => validateWorkerNamedRetirementEvidence(test.state, test.ledger(), test.profile, test.record, evidence)).toThrow("owning lease");
      test.state.lease = lease;
      const hold = imageHold(test); test.ledger().reservations = test.ledger().reservations.filter((row: any) => row !== hold);
      expect(() => validateWorkerNamedRetirementEvidence(test.state, test.ledger(), test.profile, test.record, evidence)).toThrow("reservation");
      expect(test.request).not.toHaveBeenCalled(); expect(test.store.writeAdmission).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("retains the reviewed capture through later revalidation and rejects replacing it with observations after the actual review", async () => {
    const test = await namedFixture();
    try {
      const retained = test.record.snapshotDeleteIntent.intent.review, fresh = structuredClone(retained), observedAt = new Date(Date.now()).toISOString();
      fresh.observedAt = observedAt; fresh.inventory.observedAt = observedAt;
      fresh.references.forEach((row: any) => { row.observedAt = observedAt; });
      fresh.audit.natives.forEach((row: any) => { row.audit.observedAt = observedAt; });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100);
      expect(validateWorkerNamedRetirementEvidence(test.state, test.ledger(), test.profile, test.record, retained)).toMatchObject({ observedAt: retained.observedAt });
      expect(() => validateWorkerNamedRetirementEvidence(test.state, test.ledger(), test.profile, test.record, fresh)).toThrow("stale");
      expect(fresh.bundle).toEqual(retained.bundle);
    } finally { vi.unstubAllGlobals(); }
  });
  const invalidEvidence: [string, (test: Awaited<ReturnType<typeof namedFixture>>) => void][] = [
    ["legacy acknowledgement", test => { test.record.snapshotDeleteIntent.version = 1; }],
    ["unknown acknowledgement version", test => { test.record.snapshotDeleteIntent.version = 3; }],
    ["lost response", test => { test.record.snapshotDeleteIntent.phase = "uncertain"; }],
    ["unconsumed intent", test => { test.record.snapshotDeleteIntent.consumed = false; }],
    ["HTTP404 acknowledgement", test => { test.record.snapshotDeleteIntent.response.status = 404; }],
    ["wrong typed response", test => { test.record.snapshotDeleteIntent.response.type = "snapshot.deleted"; }],
    ["another literal source builder", test => { test.record.snapshotDeleteIntent.intent.target.sourceSandboxId = "bx_other"; }],
    ["another candidate build", test => { test.record.snapshotDeleteIntent.intent.target.candidate.buildSha256 = "d".repeat(64); }],
    ["another original run", test => { test.record.snapshotDeleteIntent.intent.review.scope.runId = "999"; }],
    ["another account", test => { test.record.snapshotDeleteIntent.intent.review.scope.accountBinding = "a".repeat(64); }],
    ["reversed dispatch fences", test => { test.record.snapshotDeleteIntent.dispatch.intentFencedAt = new Date(Date.now() + 1).toISOString(); }],
    ["changed original creation", test => { test.record.builderIntent.key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; }],
    ["changed snapshot creation", test => { test.record.snapshotCreate.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; }],
    ["missing native", test => { test.record.snapshotRetirementReview.evidence.audit.natives.pop(); }],
    ["duplicate native", test => { test.record.snapshotRetirementReview.evidence.audit.natives.push(test.record.snapshotRetirementReview.evidence.audit.natives[0]); }],
    ["foreign native actor", test => { test.record.snapshotRetirementReview.evidence.audit.natives[0].audit.actorUserId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; }],
    ["unknown latest primary phase", test => { test.record.snapshotRetirementReview.evidence.audit.natives[0].audit.action = "cloud.release_canary.dispatched"; }],
    ["primary audit omitted retirement", test => { delete test.record.snapshotRetirementReview.evidence.audit.natives[0].audit.subject.retirement; }],
    ["transplanted primary provenance", test => { test.record.snapshotRetirementReview.evidence.audit.natives[0].audit.subject.retirement.provenanceSha256 = "a".repeat(64); }],
    ["primary operation mismatch", test => { const operation = test.record.snapshotRetirementReview.evidence.audit.natives[0].audit.subject.retirement.operation;
      operation.expectedBy = new Date(Date.parse(operation.expectedBy) + 1000).toISOString(); }],
    ["unmarked native snapshot policy", test => { delete test.state.resources.images.find((row: any) => row.agentQualificationId).snapshotPolicyVersion; }],
    ["unrecorded native allocation", test => { test.state.resources.images.push({ purpose: "native-agent-qualification", sourceImage: test.record.snapshotId,
      agentQualificationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", builder: { id: "bx_othernative" } }); }],
    ["expired current review", test => { test.record.snapshotRetirementReview.evidence.expiresAt = new Date(Date.now() - 1).toISOString(); }],
    ["expired pre-dispatch review", test => { test.record.snapshotDeleteIntent.intent.review.expiresAt = test.record.snapshotDeleteIntent.intent.savedAt; }],
    ["missing reference domain", test => { test.record.snapshotRetirementReview.evidence.references.pop(); }],
    ["live reference", test => { test.record.snapshotRetirementReview.evidence.references[0].authorities[0].records[0].referenceCount = 1; }],
    ["hidden primary rows", test => { test.record.snapshotRetirementReview.evidence.references[4].authorities[0].policyVisible = false; }],
    ["changed retained projection", test => { test.record.snapshotRetirementReview.evidence.references[0].authorities[0].projection.selectors.push(test.candidate.snapshotId); }],
    ["uncovered writer namespace", test => { test.record.snapshotRetirementReview.evidence.exclusion.namespaces.pop(); }],
    ["unbounded writer exclusion", test => { test.record.snapshotRetirementReview.evidence.exclusion.expiresAt = new Date(Date.now() + 300_001).toISOString(); }],
  ];
  it.each(invalidEvidence)("retains the exact named hold for %s", async (_label, change) => {
    const test = await namedFixture();
    try {
      const before = structuredClone(test.ledger()), cleanup = structuredClone(test.record.builder.cleanup);
      change(test); rebindNamedFixture(test); await test.context.lease.save();
      await expect(test.settle()).rejects.toThrow();
      expect(test.ledger()).toEqual(before); expect(test.store.writeAdmission).not.toHaveBeenCalled();
      expect(test.record.snapshotDeleted).not.toBe(true); expect(test.record.builder.cleanup).toEqual(cleanup);
      expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["replacement", "pruned"] as const)("rejects a %s reservation without committed history", async kind => {
    const test = await namedFixture();
    try {
      const hold = imageHold(test);
      if (kind === "replacement") hold.createdAt = new Date(Date.now()).toISOString();
      else test.ledger().reservations = test.ledger().reservations.filter((row: any) => row !== hold);
      await expect(test.settle()).rejects.toThrow("reservation");
      expect(test.store.writeAdmission).not.toHaveBeenCalled(); expect(test.record.snapshotNameRetirement).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["builder available", "native available", "name reappeared", "partial inventory", "duplicate inventory", "unknown builder stage", "foreign native operation"])(
    "rejects fresh provider evidence when %s", async scenario => {
      const test = await namedFixture();
      try {
        const before = structuredClone(test.ledger()), original = test.request.getMockImplementation()!;
        const native = test.record.snapshotDeleteIntent.intent.review.audit.natives[0].cleanup;
        test.request.mockImplementation(async (method, route, settings) => {
          if (scenario === "builder available" && route === `/sandboxes/${test.record.builder.id}` ||
              scenario === "native available" && route === `/sandboxes/${native.targetId}` ||
              scenario === "name reappeared" && route === `/named-snapshots/${test.record.snapshotId}`) return { status: 200, body: {} };
          if (scenario === "partial inventory" && route === "/named-snapshots") return { status: 200, body: { snapshots: [], hasMore: true } };
          if (scenario === "duplicate inventory" && route === "/named-snapshots") return { status: 200, body: {
            snapshots: [{ name: test.profile.boat.baseSnapshot }, { name: test.profile.boat.baseSnapshot }] } };
          if (scenario === "unknown builder stage" && route === `/deletion-operations/${test.operation.id}`) return { status: 200,
            body: { operation: { ...test.operation, stage: "unknown" } } };
          if (scenario === "foreign native operation" && route === `/deletion-operations/${native.operation.id}`) return { status: 200,
            body: { operation: { ...test.native.operations.get(native.operation.id), targetId: "bx_othernative" } } };
          return original(method, route, settings);
        });
        await expect(test.settle()).rejects.toThrow();
        expect(test.ledger()).toEqual(before); expect(test.store.writeAdmission).not.toHaveBeenCalled();
        expect(test.record.snapshotDeleted).not.toBe(true); expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
      } finally { vi.unstubAllGlobals(); }
    });
  it("persists a separate tombstone and removes only the exact named row, preserving all other ledger fields", async () => {
    const test = await namedFixture();
    try {
      test.ledger().reservations.push({ kind: "generation", owner: "f".repeat(24), generation: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        createdAt: test.state.createdAt, releasedAt: test.state.createdAt });
      const before = structuredClone(test.ledger()), write = test.store.writeAdmission.getMockImplementation()!;
      test.store.writeAdmission.mockImplementation(async (value, etag) => {
        const durable = test.saves.at(-1).resources.images.find((row: any) => row.snapshotId === test.record.snapshotId);
        expect(durable.snapshotNameRetirement.phase).toBe("tombstoned"); expect(durable.snapshotDeleted).not.toBe(true);
        expect(value).toEqual({ ...before, reservations: before.reservations.filter((row: any) => row.snapshotName !== test.record.snapshotId) });
        await write(value, etag);
      });
      await test.settle();
      expect(test.store.writeAdmission).toHaveBeenCalledTimes(1); expect(test.record.snapshotNameRetirement.phase).toBe("committed");
      expect(test.ledger().reservations.at(-1)).toEqual(before.reservations.at(-1));
      expect(test.record.builder.deleted).toBe(false); expect(test.run.canaries[1].outcome.report.qualified).toBe(false);
      const requests = test.request.mock.calls.map(([, route]) => route);
      expect(requests.indexOf(`/deletion-operations/${test.operation.id}`)).toBeLessThan(requests.indexOf(`/sandboxes/${test.record.builder.id}`));
      for (const native of test.record.snapshotDeleteIntent.intent.review.audit.natives) expect(requests.indexOf(`/deletion-operations/${native.cleanup.operation.id}`))
        .toBeLessThan(requests.indexOf(`/sandboxes/${native.cleanup.targetId}`));
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["prepared", "tombstoned", "committed"])("does not claim settlement when the %s journal save fails", async phase => {
    const test = await namedFixture();
    try {
      const save = test.context.lease.save.getMockImplementation()!;
      test.context.lease.save.mockImplementation(async () => {
        if (test.record.snapshotNameRetirement?.phase === phase) throw new Error("synthetic journal save failure");
        await save();
      });
      await expect(test.settle()).rejects.toThrow("save failure");
      expect(test.record.snapshotDeleted).not.toBe(true); expect(test.record.snapshotNameRetirement?.phase).not.toBe("committed");
      expect(test.store.writeAdmission).toHaveBeenCalledTimes(phase === "committed" ? 1 : 0);
      if (phase !== "committed") expect(imageHold(test)).toBeDefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([false, true])("recovers a failed CAS response (applied=%s) without another deletion or unrelated admission change", async applied => {
    const test = await namedFixture();
    try {
      const write = test.store.writeAdmission.getMockImplementation()!;
      test.store.writeAdmission.mockImplementationOnce(async (value, etag) => {
        if (applied) await write(value, etag);
        throw Object.assign(new Error("synthetic CAS response failure"), { code: "DEV_REGISTRY_CONFLICT" });
      });
      await expect(test.settle()).rejects.toThrow("CAS response failure");
      expect(test.record.snapshotNameRetirement.phase).toBe("tombstoned"); expect(test.record.snapshotDeleted).not.toBe(true);
      expect(test.store.writeAdmission).toHaveBeenCalledTimes(1);
      await test.settle();
      expect(test.record.snapshotNameRetirement.phase).toBe("committed");
      expect(test.store.writeAdmission).toHaveBeenCalledTimes(applied ? 1 : 2);
      expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("retains the prior transition if recovery persistence fails after the reservation was pruned", async () => {
    const test = await namedFixture();
    try {
      const write = test.store.writeAdmission.getMockImplementation()!, save = test.context.lease.save.getMockImplementation()!;
      test.store.writeAdmission.mockImplementationOnce(async (value, etag) => { await write(value, etag); throw new Error("lost CAS response"); });
      await expect(test.settle()).rejects.toThrow("lost CAS response");
      const before = structuredClone(test.record.snapshotNameRetirement);
      test.context.lease.save.mockRejectedValueOnce(new Error("recovery save failed"));
      await expect(test.settle()).rejects.toThrow("recovery save failed");
      expect(test.record.snapshotNameRetirement).toEqual(before);
      expect(test.saves.at(-1).resources.images.find((row: any) => row.snapshotId === test.record.snapshotId).snapshotNameRetirement).toEqual(before);
      test.context.lease.save.mockImplementation(save);
      await test.settle(); expect(test.store.writeAdmission).toHaveBeenCalledTimes(1);
      expect(test.record.snapshotNameRetirement.phase).toBe("committed");
    } finally { vi.unstubAllGlobals(); }
  });
  it("rechecks the review window immediately before the admission CAS", async () => {
    const test = await namedFixture();
    try {
      const save = test.context.lease.save.getMockImplementation()!;
      test.context.lease.save.mockImplementation(async () => {
        if (test.record.snapshotNameRetirement?.phase === "tombstoned") {
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000); test.state.lease.expiresAt = Date.now() + 60_000;
        }
        await save();
      });
      await expect(test.settle()).rejects.toThrow("stale");
      expect(test.store.writeAdmission).not.toHaveBeenCalled(); expect(imageHold(test)).toBeDefined();
      expect(test.record.snapshotDeleted).not.toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("rechecks the mutable alias after tombstone persistence and before admission CAS", async () => {
    const test = await namedFixture();
    try {
      const original = test.request.getMockImplementation()!;
      test.request.mockImplementation(async (method, route, settings) => route === `/named-snapshots/${test.record.snapshotId}` && test.record.snapshotNameRetirement?.phase === "tombstoned"
        ? { status: 200, body: {} } : original(method, route, settings));
      await expect(test.settle()).rejects.toThrow();
      expect(test.store.writeAdmission).not.toHaveBeenCalled(); expect(imageHold(test)).toBeDefined();
      expect(test.record.snapshotNameRetirement.phase).toBe("tombstoned"); expect(test.record.snapshotDeleted).not.toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("rechecks freshness after a slow final fence immediately before admission CAS", async () => {
    const test = await namedFixture();
    try {
      let advanced = false;
      test.context.lease.fence.mockImplementation(async () => {
        if (!advanced && test.record.snapshotNameRetirement?.phase === "tombstoned" &&
            test.request.mock.calls.filter(([, route]) => route === `/named-snapshots/${test.record.snapshotId}`).length >= 2) {
          advanced = true; vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000); test.state.lease.expiresAt = Date.now() + 60_000;
        }
      });
      await expect(test.settle()).rejects.toThrow();
      expect(advanced).toBe(true); expect(test.store.writeAdmission).not.toHaveBeenCalled(); expect(imageHold(test)).toBeDefined();
      expect(test.record.snapshotNameRetirement.phase).toBe("tombstoned"); expect(test.record.snapshotDeleted).not.toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["name reappeared", "review expired"])("keeps the transition uncommitted when %s during admission CAS", async scenario => {
    const test = await namedFixture();
    try {
      let applied = false;
      const write = test.store.writeAdmission.getMockImplementation()!, request = test.request.getMockImplementation()!;
      test.store.writeAdmission.mockImplementation(async (value, etag) => {
        await write(value, etag); applied = true;
        if (scenario === "review expired") {
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000); test.state.lease.expiresAt = Date.now() + 60_000;
        }
      });
      test.request.mockImplementation(async (method, route, settings) => applied && scenario === "name reappeared" && route === `/named-snapshots/${test.record.snapshotId}`
        ? { status: 200, body: {} } : request(method, route, settings));
      await expect(test.settle()).rejects.toThrow();
      expect(test.store.writeAdmission).toHaveBeenCalledTimes(1);
      expect(test.record.snapshotNameRetirement.phase).toBe("tombstoned"); expect(test.record.snapshotDeleted).not.toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("uses committed history only for historical observation, after review expiry and account-ledger advancement", async () => {
    const test = await namedFixture();
    try {
      await test.settle(); const witness = structuredClone(test.record.snapshotNameRetirement);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 360_000);
      test.state.lease = { token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", expiresAt: Date.now() + 60_000 };
      test.ledger().reservations.push({ kind: "generation", owner: "f".repeat(24), generation: "ffffffff-ffff-4fff-8fff-ffffffffffff", createdAt: new Date(Date.now()).toISOString() });
      await test.context.lease.save(); test.request.mockClear();
      await expect(releaseBuilderCreationScope(test.config, test.context)).rejects.toThrow("admission ownership");
      await expect(retireReleaseBuilder(test.config, test.context, { observeOnly: true })).rejects.toThrow("admission ownership");
      await expect(retireReleaseBuilder(test.config, test.context, { historical: true })).rejects.toThrow("admission ownership");
      await retireReleaseBuilder(test.config, test.context, { observeOnly: true, historical: true });
      expect(test.record.builder.deleted).toBe(false); expect(test.record.builder.cleanup.storage.physicalBytes).toBe("unmeasured");
      expect(test.request.mock.calls.map(([, route]) => route)).toEqual([`/deletion-operations/${test.operation.id}`, `/sandboxes/${test.record.builder.id}`, `/named-snapshots/${test.record.snapshotId}`]);
      expect(test.record.snapshotNameRetirement).toEqual(witness);
      test.operation.status = "completed"; test.operation.completedAt = new Date(Date.now()).toISOString();
      await retireReleaseBuilder(test.config, test.context, { observeOnly: true, historical: true });
      expect(test.record.builder.deleted).toBe(true); expect(test.record.snapshotNameRetirement).toEqual(witness);
      expect(test.record.builderProvenance).toEqual(witness.review.evidence.builder.provenance);
      expect(test.store.writeAdmission).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["missing witness", "replacement row", "reappeared alias", "tampered original audit"])("withholds historical observation for %s", async scenario => {
    const test = await namedFixture();
    try {
      await test.settle(); test.request.mockClear();
      if (scenario === "missing witness") delete test.record.snapshotNameRetirement;
      if (scenario === "replacement row") test.ledger().reservations.push({ ...test.record.snapshotDeleteIntent.intent.reservation, createdAt: new Date(Date.now()).toISOString() });
      if (scenario === "tampered original audit") test.record.snapshotNameRetirement.review.evidence.audit.natives[0].audit.subject.retirement.provenanceSha256 = "f".repeat(64);
      if (scenario === "reappeared alias") {
        const original = test.request.getMockImplementation()!;
        test.request.mockImplementation(async (method, route, settings) => route === `/named-snapshots/${test.record.snapshotId}`
          ? { status: 200, body: {} } : original(method, route, settings));
      }
      await expect(retireReleaseBuilder(test.config, test.context, { observeOnly: true, historical: true })).rejects.toThrow();
      expect(test.record.builder.deleted).toBe(false); expect(test.store.writeAdmission).toHaveBeenCalledTimes(1);
      expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("release-owned builder retirement composition", () => {
  it("refuses fresh build, qualify and promotion with the closed retirement code even when historical image data exists", async () => {
    const test = await fixture(), native = nativeHarness(test), before = structuredClone(test.state);
    test.request.mockClear(); test.context.lease.save.mockClear(); test.context.lease.fence.mockClear(); test.store.writeAdmission.mockClear();
    for (const action of [() => test.adapter.build(), () => native.canary.qualify(test.candidate, native.input.kinds[0]!),
      () => promoteWorker(native.input, native.deps)]) await expect(action()).rejects.toMatchObject({ code: "release_worker_images_retired",
      message: "v3 release worker images are retired; v4 runtime bundles are the supported artifact" });
    expect(test.state).toEqual(before); expect(test.request).not.toHaveBeenCalled(); expect(test.context.kit).not.toHaveBeenCalled();
    expect(test.context.lease.save).not.toHaveBeenCalled(); expect(test.context.lease.fence).not.toHaveBeenCalled();
    expect(test.store.writeAdmission).not.toHaveBeenCalled(); expect(test.context.reserve).not.toHaveBeenCalled();
    expect(native.core.start).not.toHaveBeenCalled(); expect(native.owner).not.toHaveBeenCalled(); expect(native.tuple).not.toHaveBeenCalled();
  });
  it("settles reviewed pending storage for two natives, observes the pruned reservation and later completes the original builder", async () => {
    const test = await fixture(), native = nativeHarness(test, true, true, "full");
    try {
      await test.adapter.cleanup();
      for (const kind of native.input.kinds.slice(0, 2)) { await native.seed(kind); expect(await native.canary.cleanup()).toBe(true); }
      await native.canary.cleanup();
      test.run.canaries[1].outcome.code = 1; test.run.canaries[1].outcome.report.qualified = false;
      expect(test.run.canaries).toHaveLength(2);
      expect(test.run.canaries.every((job: any) => job.retired && job.auditRetired.version === 2)).toBe(true);
      // Provider/readback JSON order is not semantic candidate identity.
      const candidate = test.record.candidate;
      test.record.candidate = { storageMiB: candidate.storageMiB, architecture: candidate.architecture,
        buildSha256: candidate.buildSha256, sourceCommit: candidate.sourceCommit, snapshotId: candidate.snapshotId };
      acknowledgeNamedRetirement(test, native);
      await test.context.lease.save(); await test.context.lease.fence();
      const original = test.request.getMockImplementation()!, inventory = [{ provider: "boat", id: test.profile.boat.baseSnapshot }];
      test.request.mockImplementation(async (method, route, settings) => route === `/named-snapshots/${test.candidate.snapshotId}`
        ? { status: 404, body: null } : route === "/named-snapshots" ? { status: 200, body: { snapshots: inventory.map(row => ({ name: row.id })) } }
          : original(method, route, settings));
      test.request.mockClear();
      await reconcileWorkerSnapshotHolds(test.store, test.context.lease, test.profile, inventory, test.request);
      expect(test.record.snapshotDeleted).toBe(true);
      expect(test.record.snapshotNameRetirement.phase).toBe("committed");
      expect(test.ledger().reservations.find((row: any) => row.snapshotName === test.candidate.snapshotId)).toBeUndefined();
      expect(test.record.builder.deleted).toBe(false);
      expect(test.record.builder.cleanup.storage.physicalBytes).toBe("unmeasured");
      const next = { ...test.config, runId: "124", sourceSha: "c".repeat(40) };
      await reconcileReleaseBuilderRetentions(next, test.context);
      expect(test.record.builder.deleted).toBe(false);
      test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString();
      await reconcileReleaseBuilderRetentions(next, test.context);
      expect(test.record.builder.deleted).toBe(true);
      expect(test.record.builder.cleanup).toMatchObject({ kind: "physically-deleted", deletionOperationId: test.operation.id });
      expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
      expect(test.run.canaries[1].outcome.report.qualified).toBe(false);
      expect(native.owner).not.toHaveBeenCalled(); expect(native.tuple).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["smoke", "full"] as const)("reads the historical three-kind %s receipt while reconciling pending native storage and named holds", async profile => {
    const test = await historicalFixture(), native = nativeHarness(test, true, true, profile);
    try {
      const receipt = await historicalReceipt(test, native);
      expect(receipt).toMatchObject({ version: 3, qualificationProfile: profile, cleanup: { credentialCanaryResourcesDeleted: false,
        pendingNativeStorage: { status: "pending", count: 3, physicalBytes: "unmeasured" } } });
      expect(validateWorkerReceipt(receipt, native.input)).toEqual(receipt);
      expect(native.recorded()).toBe(3); expect(native.allocations()).toBe(0); expect(native.core.poll).not.toHaveBeenCalled();
      expect(native.core.start).not.toHaveBeenCalled(); expect(native.owner).not.toHaveBeenCalled(); expect(native.tuple).not.toHaveBeenCalled();
      expect(test.run.approval).toMatchObject({ phase: "applied", planSha256: receipt.approvalPlanSha256, targetSha256: receipt.approvalTargetSha256 });
      expect(native.audits.filter(audit => audit.action === "cloud.release_canary.storage_retired")).toHaveLength(3);
      expect(native.audits.filter(audit => audit.action === "cloud.release_canary.retired")).toHaveLength(0);
      expect(test.run.canaries.every((job: any) => job.phase === "completed" && job.retired && job.auditRetired.version === 2)).toBe(true);
      expect(test.state.resources.images.filter((row: any) => row.purpose === "native-agent-qualification").every((row: any) =>
        row.builder.deleted !== true && row.builder.physicalCleanup === undefined && row.builder.storageRetirement.operation.status === "blocked")).toBe(true);
      expect(test.ledger().reservations.filter((row: any) => row.kind === "builder")).toEqual([expect.objectContaining({ snapshotName: test.candidate.snapshotId })]);
      expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
      expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(4);
      expect(test.request.mock.calls.some(([method, route]) => method === "DELETE" && route.startsWith("/named-snapshots"))).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
  it("persists truthful pending-storage provenance before freeing compute, retaining the named-image hold", async () => {
    const test = await fixture();
    expect(test.record.candidate).toEqual(test.candidate);
    await expect(test.adapter.cleanup()).resolves.toMatchObject({ kind: "release-owned-sanitized-unavailable", sandboxId: "bx_builder",
      deletionOperationId: test.operation.id, storage: { status: "pending", scope: "sandbox-unshared-snapshots-and-machine-data",
        stage: "waiting_for_uploads", expectedBy: test.operation.expectedBy, physicalBytes: "unmeasured" } });
    expect(test.record.builder.deleted).toBe(false);
    expect(test.record.builder.retiredAt).toEqual(expect.any(String));
    expect(test.record.builder.cleanup).toMatchObject({ kind: "release-owned-sanitized-unavailable", provenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const terminal = test.saves.find(saved => saved.resources.images[0].builder.retiredAt);
    expect(terminal.resources.images[0].builder.cleanup).toEqual(test.record.builder.cleanup);
    expect(test.ledger().reservations).toContainEqual(expect.objectContaining({ snapshotName: test.candidate.snapshotId, releasedAt: expect.any(String) }));
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    expect(test.record.kitFiles).toBeUndefined();
    expect(test.context.kit).not.toHaveBeenCalled();
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("reads a historical v2 receipt after actual strict retirement physically deletes every recorded native VM", async () => {
    const test = await fixture(), native = nativeHarness(test);
    const receipt = await historicalReceipt(test, native);
    expect(receipt).toMatchObject({ version: 2, cleanup: { credentialCanaryResourcesDeleted: true,
      imageBuilder: { kind: "release-owned-sanitized-unavailable", storage: { status: "pending", physicalBytes: "unmeasured" } } } });
    expect(receipt).not.toHaveProperty("resourcesDeleted");
    expect(validateWorkerReceipt(receipt, native.input)).toEqual(receipt);
    expect(native.recorded()).toBe(3); expect(native.allocations()).toBe(0);
    expect(native.owner).not.toHaveBeenCalled(); expect(native.tuple).not.toHaveBeenCalled();
    expect(test.run.approval).toMatchObject({ phase: "applied", planSha256: receipt.approvalPlanSha256, targetSha256: receipt.approvalTargetSha256 });
    expect(test.state.resources.images.filter((image: any) => image.purpose === "native-agent-qualification")).toHaveLength(3);
    expect(test.state.resources.images.filter((image: any) => image.purpose === "native-agent-qualification").every((image: any) => image.builder.deleted === true)).toBe(true);
    expect(test.state.resources.images.filter((row: any) => row.purpose === "native-agent-qualification").every((row: any) =>
      row.builderIntent.body.snapshots === false && row.builderIntent.body.noEnv === true && Object.keys(row.builderIntent.body.env).length === 0)).toBe(true);
    expect(test.record.builder.deleted).toBe(false);
    expect(test.ledger().reservations.filter((row: any) => row.kind === "builder")).toEqual([expect.objectContaining({ snapshotName: test.candidate.snapshotId, releasedAt: expect.any(String) })]);
    expect(test.ledger().reservations.filter((row: any) => row.kind === "generation")).toEqual([expect.objectContaining({ owner: test.state.owner, generation: test.state.generation })]);
    expect(test.ledger().reservations.find((row: any) => row.kind === "generation").releasedAt).toBeUndefined();
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    for (const name of ["BOAT_API_KEY", "RAILWAY_DEPLOY_TOKEN", "PLANETSCALE_SERVICE_TOKEN", "GH_TOKEN", "WORKER_CANARY_ADMISSION_TOKEN"])
      expect(JSON.stringify(receipt)).not.toContain(test.environment[name]);
  });
  it("never applies the builder deferred boundary to a native canary and retains its compute hold on blocked deletion", async () => {
    const test = await fixture(), native = nativeHarness(test, true);
    await test.adapter.cleanup(); const job = await native.seed(native.input.kinds[0]!);
    await expect(native.core.retire(job)).rejects.toThrow("blocked");
    expect(await native.canary.cleanup()).toBe(false);
    expect(native.recorded()).toBe(1); expect(native.allocations()).toBe(0); expect(native.owner).not.toHaveBeenCalled(); expect(native.tuple).not.toHaveBeenCalled();
    const canary = test.state.resources.images.find((image: any) => image.purpose === "native-agent-qualification");
    expect(canary.builder.deleted).not.toBe(true); expect(canary.builder.retiredAt).toBeUndefined();
    expect(test.ledger().reservations.find((row: any) => row.computeId === `canary:${canary.agentQualificationId}`).releasedAt).toBeUndefined();
    expect(test.request.mock.calls.filter(([method, route]) => method === "DELETE" && route.startsWith("/sandboxes/bx_native"))).toHaveLength(1);
  });
  it("does not allocate even a credential-free canary when the real builder proof is ineligible", async () => {
    const test = await fixture(), native = nativeHarness(test);
    patchProof(test, "source", value => { value.commit = "f".repeat(40); });
    await expect(test.adapter.cleanup()).rejects.toThrow();
    expect(native.allocations()).toBe(0); expect(native.core.start).not.toHaveBeenCalled();
    expect(native.owner).not.toHaveBeenCalled(); expect(native.tuple).not.toHaveBeenCalled(); assertHeld(test);
  });
  const invalidProofs: Array<[string, (test: Awaited<ReturnType<typeof fixture>>) => void]> = [
    ["wrong purpose", test => { test.record.purpose = "native-agent-qualification"; }],
    ["wrong authenticated owner", test => { test.state.owner = workerOwner("beta"); }],
    ["wrong repository identity", test => { test.state.identity = "f".repeat(64); }],
    ["wrong run", test => { test.record.releaseRunId = "124"; }],
    ["wrong original owner", test => { test.record.builderIntent.scope.owner = workerOwner("beta"); }],
    ["wrong original channel", test => { test.record.builderIntent.scope.channel = "beta"; }],
    ["wrong original generation", test => { test.record.builderIntent.scope.generation = "33333333-3333-4333-8333-333333333333"; }],
    ["wrong original account", test => { test.record.builderIntent.scope.accountBinding = "f".repeat(64); }],
    ["wrong original source", test => { test.record.builderIntent.scope.sourceSha = "f".repeat(40); }],
    ["wrong input digest", test => { test.record.builderIntent.scope.inputsSha256 = "f".repeat(64); }],
    ["unconfirmed wallet", test => { delete test.record.builder.billingOrgConfirmed; }],
    ["wrong wallet proof", test => { test.record.builder.accountBinding = "f".repeat(64); }],
    ["unprotected base", test => { test.record.builderIntent.body.from = test.candidate.snapshotId; }],
    ["environment inheritance", test => { test.record.builderIntent.body.noEnv = false; }],
    ["injected host authority", test => { test.record.builderIntent.body.env = { TOKEN: test.environment.BOAT_API_KEY }; }],
    ["native resource identity collision", test => { test.state.resources.images.push({ purpose: "native-agent-qualification", builder: { id: test.record.builder.id } }); }],
    ["persisted native target collision", test => { test.run.canaries.push({ target: { id: test.record.builder.id } }); }],
    ["wrong candidate build", test => { test.record.candidate.buildSha256 = "f".repeat(64); }],
    ["unacknowledged snapshot save", test => { test.record.snapshotCreate.phase = "uncertain"; }],
    ["invalid export tree", test => patchProof(test, "source", value => { value.tree = "not-a-tree"; })],
    ["wrong export source", test => patchProof(test, "source", value => { value.commit = "f".repeat(40); })],
    ["missing archive hash", test => patchProof(test, "source", value => { delete value.archiveSha256; })],
    ["unproven exact merged source", test => patchProof(test, "source", value => { value.exactMergedCommit = false; })],
    ["wrong generation contract", test => patchProof(test, "generation", value => { value.contract = "f".repeat(64); })],
    ["invalid generation attempt", test => patchProof(test, "generation", value => { value.attempt = "unowned-attempt"; })],
    ["missing script hash", test => patchProof(test, "generation", value => { delete value.scriptSha256; })],
    ["unqualified machine", test => patchProof(test, "native-attestation", value => { value.qualified = false; })],
    ["insecure Setup", test => patchProof(test, "native-attestation", value => { value.setupQualification.secure = false; })],
    ["wrong attested build", test => patchProof(test, "native-attestation", value => { value.metadata.buildSha256 = "f".repeat(64); })],
    ["wrong attested storage", test => patchProof(test, "native-attestation", value => { value.resources.allocation.storageBytes = 8192 * 1048576; })],
    ["wrong saved source builder", test => patchProof(test, "snapshot-ledger", value => { value.resourceId = "bx_other"; })],
    ["unready save ledger", test => patchProof(test, "snapshot-ledger", value => { value.state = "save-pending"; })],
    ["stale-at-save sanitation", test => patchProof(test, "snapshot-ledger", value => { value.sanitation.observedAt = new Date(Date.parse(value.createdAt) - 60_001).toISOString(); })],
    ["future-at-save sanitation", test => patchProof(test, "snapshot-ledger", value => { value.sanitation.observedAt = new Date(Date.parse(value.createdAt) + 1).toISOString(); })],
    ["malformed sanitation timestamp", test => patchProof(test, "snapshot-ledger", value => { value.sanitation.observedAt = "invalid"; })],
    ["future ready observation", test => patchProof(test, "snapshot-ledger", value => { value.lastObservedAt = new Date(Date.now() + 60_000).toISOString(); })],
  ];
  it.each(invalidProofs)("refuses %s before DELETE, compute release or native dispatch", async (_name, change) => {
    const test = await fixture(); change(test);
    await expect(test.adapter.cleanup()).rejects.toThrow();
    assertHeld(test);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(0);
  });
  it.each(["waiting_for_uploads", "kept_for_newer_snapshots", "waiting_for_restore"])("represents only documented %s retention without claiming erasure or inventing a dependency deadline", async stage => {
    const test = await fixture(); test.operation.stage = stage;
    if (stage !== "waiting_for_uploads") delete test.operation.expectedBy;
    expect(await test.adapter.cleanup()).toMatchObject({ kind: "release-owned-sanitized-unavailable", storage: {
      status: "pending", stage, expectedBy: stage === "waiting_for_uploads" ? test.operation.expectedBy : null, physicalBytes: "unmeasured" } });
    expect(test.record.builder.deleted).toBe(false);
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it.each([undefined, null, "invalid", "", 123, "1970-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])("refuses an invalid upload deadline %s while keeping both holds", async expectedBy => {
    const test = await fixture(); test.operation.expectedBy = expectedBy;
    await expect(test.adapter.cleanup()).rejects.toThrow(); assertHeld(test);
  });
  it.each([{ stage: "unknown-stage" }, { status: "unknown-status" }, { status: "completed", completedAt: "invalid" },
    { status: "completed", completedAt: "2099-01-01T00:00:00.000Z" }])("refuses unconfirmed operation state %j", async patch => {
    const test = await fixture(); Object.assign(test.operation, patch);
    await expect(test.adapter.cleanup()).rejects.toThrow(); assertHeld(test);
  });
  it.each([{ id: `bdop_${"d".repeat(32)}` }, { kind: "snapshot" }, { targetId: "bx_other" }])("refuses changed authenticated readback %j", async patch => {
    const test = await fixture(), base = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route) => route.startsWith("/deletion-operations/")
      ? { status: 200, body: { operation: { ...test.operation, ...patch } } } as any : base(method, route));
    await expect(test.adapter.cleanup()).rejects.toThrow("proof changed"); assertHeld(test);
  });
  it.each([200, 401, 500])("requires authenticated sandbox 404, not readback status %s", async status => {
    const test = await fixture(), base = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route) => method === "GET" && route === "/sandboxes/bx_builder" ? { status } as any : base(method, route));
    await expect(test.adapter.cleanup()).rejects.toThrow("unavailable"); assertHeld(test);
  });
  it("never uses a 404 or a replayed DELETE after the accepted deletion response was lost", async () => {
    const test = await fixture(), base = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route) => { if (method === "DELETE") throw new Error("synthetic lost deletion response"); return base(method, route); });
    await expect(test.adapter.cleanup()).rejects.toThrow("lost deletion response"); assertHeld(test);
    test.request.mockImplementation(base);
    await expect(test.adapter.cleanup()).rejects.toThrow("response was lost"); assertHeld(test);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("rejects pending retention for legacy intent without inventing scope, but still allows authenticated physical completion", async () => {
    const test = await fixture(); delete test.record.builderIntent.scope;
    await expect(test.adapter.cleanup()).rejects.toThrow("provenance"); assertHeld(test);
    test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString();
    const result = await test.adapter.cleanup();
    expect(result).toMatchObject({ kind: "physically-deleted", deletionOperationId: test.operation.id });
    expect(test.record.builder.deleted).toBe(true); expect(test.record.builderIntent.scope).toBeUndefined();
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("recovers from the persisted compact certificate with no kit, build, DELETE replay or fresh sanitation requirement", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    const certificate = structuredClone(test.record.builder.cleanup.provenance), originalIntent = JSON.stringify(test.record.builderIntent);
    const resumed = await boatImageAdapter(test.config, test.environment, path.join(test.directory, "resumed"), test.context);
    await expect(resumed.build()).rejects.toMatchObject({ code: "release_worker_images_retired" });
    expect(await resumed.cleanup()).toMatchObject({ kind: "release-owned-sanitized-unavailable", provenance: certificate });
    expect(JSON.stringify(test.record.builderIntent)).toBe(originalIntent);
    expect(test.record.kitFiles).toBeUndefined(); expect(test.context.reserve).not.toHaveBeenCalled(); expect(test.context.kit).not.toHaveBeenCalled();
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("never compacts or publishes a terminal marker when the complete pending proof save fails", async () => {
    const test = await fixture(), save = test.context.lease.save.getMockImplementation()!;
    test.context.lease.save.mockImplementation(async () => {
      if (test.record.builder.cleanup && !test.record.builder.retiredAt) throw new Error("synthetic proof persistence failure");
      await save();
    });
    await expect(test.adapter.cleanup()).rejects.toThrow("persistence failure"); assertHeld(test);
    expect(test.record.kitFiles).toBeDefined();
    expect(test.saves.at(-1).resources.images[0].builder.retiredAt).toBeUndefined();
    expect(test.saves.at(-1).resources.images[0].builderProvenance).toBeDefined();
    expect(test.saves.at(-1).resources.images[0].builder.deletionOperationId).toBe(test.operation.id);
  });
  it("never dispatches DELETE when the owned lease fence fails", async () => {
    const test = await fixture(); test.context.lease.fence.mockRejectedValue(new Error("synthetic lost lease"));
    await expect(test.adapter.cleanup()).rejects.toThrow("lost lease"); assertHeld(test);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(0);
  });
  it("does not release an admission hold after failed CAS and safely retries the retained operation", async () => {
    const test = await fixture(), write = test.store.writeAdmission.getMockImplementation()!;
    test.store.writeAdmission.mockRejectedValue(Object.assign(new Error("synthetic admission conflict"), { code: "DEV_REGISTRY_CONFLICT" }));
    await expect(test.adapter.cleanup()).rejects.toThrow("admission is busy");
    expect(test.record.builder.deleted).toBe(false); expect(test.record.builder.cleanup.storage.status).toBe("pending");
    expect(imageHold(test).releasedAt).toBeUndefined();
    test.store.writeAdmission.mockImplementation(write);
    await expect(test.adapter.cleanup()).resolves.toMatchObject({ kind: "release-owned-sanitized-unavailable" });
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(imageHold(test).releasedAt).toEqual(expect.any(String));
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it("reconciles an old-source pending operation on a later release without rebuild, DELETE replay, named retirement or age-only release", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    const certificate = structuredClone(test.record.builder.cleanup.provenance);
    test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString();
    await reconcileReleaseBuilderRetentions({ ...test.config, sourceSha: "f".repeat(40), runId: "124" }, test.context);
    expect(test.record.builder.cleanup).toMatchObject({ kind: "physically-deleted", deletionOperationId: test.operation.id });
    expect(test.record.builder.deleted).toBe(true); expect(test.record.builderProvenance).toEqual(certificate);
    expect(test.record.snapshotDeleted).toBeUndefined(); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.context.kit).not.toHaveBeenCalled();
  });
  it("reconciles a historical builder whose named image was retired using its saved physical operation and compact proof", async () => {
    const test = await historicalFixture(); await test.adapter.cleanup();
    const certificate = structuredClone(test.record.builder.cleanup.provenance), intent = structuredClone(test.record.builderIntent);
    expect(test.record.kitFiles).toBeUndefined(); expect(test.record.builder.deleted).toBe(false);
    const original = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, settings) => route === `/named-snapshots/${test.candidate.snapshotId}`
      ? { status: 404, body: null } : original(method, route, settings));
    test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString(); test.request.mockClear();
    await reconcileReleaseBuilderRetentions(test.nextConfig, test.context);
    expect(test.request.mock.calls.map(([method, route]) => [method, route])).toEqual([
      ["GET", `/deletion-operations/${test.operation.id}`], ["GET", `/sandboxes/${test.record.builder.id}`],
    ]);
    expect(test.record.builder.cleanup).toMatchObject({ kind: "physically-deleted", deletionOperationId: test.operation.id });
    expect(test.record.builder.deleted).toBe(true); expect(test.record.builderProvenance).toEqual(certificate);
    expect(test.record.builderIntent).toEqual(intent); expect(test.record.builder.reconcileUnconfirmed).toBeUndefined();
    expect(test.record.snapshotDeleted).toBeUndefined(); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    expect(test.context.kit).not.toHaveBeenCalled();
  });
  it("releases an actually retired named-image hold only after historical physical builder reconciliation and exact name readback", async () => {
    const test = await historicalFixture(); await test.adapter.cleanup();
    const original = test.request.getMockImplementation()!, inventory = [{ provider: "boat", id: test.profile.boat.baseSnapshot }];
    test.request.mockImplementation(async (method, route, settings) => route === `/named-snapshots/${test.candidate.snapshotId}`
      ? { status: 404, body: null } : original(method, route, settings));
    await reconcileWorkerSnapshotHolds(test.store, test.context.lease, test.profile, inventory, test.request);
    expect(test.record.builder.deleted).toBe(false); expect(test.record.snapshotDeleted).toBeUndefined();
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString(); test.request.mockClear();
    await reconcileReleaseBuilderRetentions(test.nextConfig, test.context);
    expect(test.record.builder.deleted).toBe(true); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    await reconcileWorkerSnapshotHolds(test.store, test.context.lease, test.profile, inventory, test.request);
    expect(test.record.snapshotDeleted).toBe(true); expect(test.record.snapshotRetirementReason).toBe("externally-pruned-after-builder-cleanup");
    expect(test.ledger().reservations.find((row: any) => row.snapshotName === test.candidate.snapshotId)).toBeUndefined();
    expect(test.request.mock.calls.map(([method, route]) => [method, route])).toEqual([
      ["GET", `/deletion-operations/${test.operation.id}`], ["GET", `/sandboxes/${test.record.builder.id}`],
      ["GET", `/named-snapshots/${test.candidate.snapshotId}`],
    ]);
    expect(test.context.kit).not.toHaveBeenCalled();
  });
  it.each(["missing", "wrong-name", "wrong-source-builder", "unready"])("does not authorize historical pending storage with a %s named image", async status => {
    const test = await historicalFixture(); await test.adapter.cleanup();
    const cleanup = structuredClone(test.record.builder.cleanup), intent = structuredClone(test.record.builderIntent);
    const original = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, settings) => route === `/named-snapshots/${test.candidate.snapshotId}`
      ? status === "missing" ? { status: 404, body: null } : { status: 200, body: { snapshot: {
        name: status === "wrong-name" ? "other" : test.candidate.snapshotId, status: status === "unready" ? "save-pending" : "ready",
        sourceSandboxId: status === "wrong-source-builder" ? "bx_other" : test.record.builder.id } } }
      : original(method, route, settings));
    test.request.mockClear(); test.context.release.mockClear();
    await expect(reconcileReleaseBuilderRetentions(test.nextConfig, test.context)).rejects.toThrow("unconfirmed");
    expect(test.request.mock.calls.map(([method, route]) => [method, route])).toEqual([
      ["GET", `/deletion-operations/${test.operation.id}`], ["GET", `/named-snapshots/${test.candidate.snapshotId}`],
    ]);
    expect(test.record.builder.deleted).toBe(false); expect(test.record.builder.cleanup).toEqual(cleanup);
    expect(test.record.builderIntent).toEqual(intent); expect(test.record.builder.reconcileUnconfirmed).toBe(true);
    expect(test.record.snapshotDeleted).toBeUndefined(); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    expect(test.context.release).not.toHaveBeenCalled(); expect(test.context.kit).not.toHaveBeenCalled();
  });
  it.each(["wrong-operation", "wrong-target", "early-completion", "available-sandbox"])("retains the retired name's hold for %s rather than inferring physical deletion", async status => {
    const test = await historicalFixture(); await test.adapter.cleanup();
    const cleanup = structuredClone(test.record.builder.cleanup), operationId = test.record.builder.deletionOperationId;
    test.operation.status = "completed"; test.operation.completedAt = status === "early-completion"
      ? new Date(test.record.builderIntent.at - 6000).toISOString() : new Date().toISOString();
    if (status === "wrong-operation") test.operation.id = `bdop_${"f".repeat(32)}`;
    if (status === "wrong-target") test.operation.targetId = "bx_other";
    const original = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, settings) => {
      if (route === `/named-snapshots/${test.candidate.snapshotId}`) return { status: 404, body: null };
      if (route === `/deletion-operations/${operationId}`) return { status: 200, body: { operation: structuredClone(test.operation) } };
      if (route === `/sandboxes/${test.record.builder.id}` && status === "available-sandbox") return { status: 200, body: { sandbox: { id: test.record.builder.id } } };
      return original(method, route, settings);
    });
    test.request.mockClear();
    await expect(reconcileReleaseBuilderRetentions(test.nextConfig, test.context)).rejects.toThrow("unconfirmed");
    expect(test.request.mock.calls[0]).toEqual(["GET", `/deletion-operations/${operationId}`, { timeoutMs: expect.any(Number) }]);
    expect(test.request.mock.calls.every(([method, route]) => method === "GET" && !route.startsWith("/named-snapshots/"))).toBe(true);
    expect(test.record.builder.deleted).toBe(false); expect(test.record.builder.cleanup).toEqual(cleanup);
    expect(test.record.snapshotDeleted).toBeUndefined(); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    expect(test.context.kit).not.toHaveBeenCalled();
  });
  it("retains malformed historical pending proof and blocks another release rather than trusting its terminal marker", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    test.record.builder.cleanup.kind = "unknown-retirement";
    await expect(reconcileReleaseBuilderRetentions(test.config, test.context)).rejects.toThrow("unconfirmed");
    expect(test.record.builder.deleted).toBe(false); expect(test.record.snapshotDeleted).toBeUndefined();
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it("makes physical completion explicit and rejects contradictory pending-vs-deleted receipt fields", async () => {
    const test = await fixture(), native = nativeHarness(test), receipt: any = await historicalReceipt(test, native);
    for (const patch of [{ resourcesDeleted: true }, { resourcesDeleted: false }, { cleanup: { ...receipt.cleanup, credentialCanaryResourcesDeleted: false } },
      { sourceSha: "f".repeat(40) }, { inputsSha256: "f".repeat(64) }, { runId: "124" }, { channel: "beta" },
      { worker: { ...receipt.worker, imageRef: `boat:other@sha256:${"b".repeat(64)}` } }])
      expect(WorkerReceipt.safeParse({ ...receipt, ...patch }).success).toBe(false);
    expect(WorkerBuilderCleanupSchema.safeParse({ ...receipt.cleanup.imageBuilder,
      storage: { ...receipt.cleanup.imageBuilder.storage, status: "deleted" } }).success).toBe(false);
    test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString();
    const result = await test.adapter.cleanup();
    expect(result).toMatchObject({ kind: "physically-deleted", completedAt: test.operation.completedAt });
    expect(result).not.toHaveProperty("storage"); expect(test.record.builder.deleted).toBe(true);
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it("validates sanitation freshness at the original save, not two hours later during retirement", async () => {
    const test = await fixture({ savedAgeMs: 2 * 3600_000 });
    await expect(test.adapter.cleanup()).resolves.toMatchObject({ kind: "release-owned-sanitized-unavailable" });
    expect(Date.now() - Date.parse(test.record.builder.cleanup.provenance.snapshot.sanitation.observedAt)).toBeGreaterThan(3600_000);
    expect(test.record.builder.deleted).toBe(false); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it("requires compact recovery to preserve the exact original creation timestamp", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    test.record.builderIntent.at += 1000;
    await expect(test.adapter.cleanup()).rejects.toThrow("provenance");
    expect(test.record.builder.deleted).toBe(false); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it("rejects physical completion predating the owned builder creation", async () => {
    const test = await fixture(); test.operation.status = "completed"; test.operation.completedAt = "1970-01-01T00:00:00.000Z";
    await expect(test.adapter.cleanup()).rejects.toThrow("physical deletion"); assertHeld(test);
  });
  it("reads retained image-kit files and the exact original creation intent without rerunning the producer", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "zeros-release-kit-source-")); directories.push(repository);
    const git = (...arguments_: string[]) => execFileSync("git", ["-c", "user.name=Release Kit Fixture", "-c", "user.email=release-kit@example.invalid", ...arguments_],
      { cwd: repository, encoding: "utf8" }).trim();
    git("init", "-q"); await writeFile(path.join(repository, "fixture.txt"), "committed source\n");
    git("add", "fixture.txt"); git("commit", "-q", "-m", "synthetic release source");
    const commit = git("rev-parse", "HEAD"), test = await fixture({ sourceCommit: commit }), prefix = commit.slice(0, 12);
    // Source export remains an independent, credential-free archive helper.
    // Generation, attestation, capture and allocation are recorded history.
    await imageKit(["export"], { boat: test.request as any, billingOrg: test.profile.boat.billingOrg, stateDir: test.directory, repoRoot: repository,
      imageContract: imageContractSha256, now: Date.now, randomHex: () => "f".repeat(32), randomUUID: () => "22222222-2222-4222-8222-222222222222" });
    test.record.kitFiles[`${prefix}/source.json`] = await readFile(path.join(test.directory, prefix, "source.json"), "utf8");
    for (const [file, content] of Object.entries(test.record.kitFiles)) {
      await mkdir(path.dirname(path.join(test.directory, file)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(test.directory, file), content as string, { mode: 0o600 });
    }
    const files = JSON.parse(await readFile(path.join(test.directory, prefix, "source.json"), "utf8"));
    const generated = JSON.parse(await readFile(path.join(test.directory, prefix, "generation.json"), "utf8"));
    const ledger = JSON.parse(await readFile(path.join(test.directory, prefix, "snapshot-ledger.json"), "utf8"));
    const attestation = JSON.parse(await readFile(path.join(test.directory, prefix, "native-attestation.json"), "utf8"));
    const archive = await readFile(path.join(test.directory, prefix, "source.tar.gz"));
    expect(files).toMatchObject({ commit, parent: commit, tree: git("rev-parse", "HEAD^{tree}"), exactMergedCommit: true,
      archiveBytes: archive.length, archiveSha256: createHash("sha256").update(archive).digest("hex") });
    expect(attestation).toMatchObject({ qualified: true, setupQualification: { secure: true }, metadata: { buildSha256: generated.buildSha256 } });
    const intent = structuredClone(test.record.builderIntent);
    expect(intent.scope).toMatchObject({ owner: test.state.owner, generation: test.state.generation,
      accountBinding: test.ledger().account, repository: test.config.repository, runId: test.config.runId });
    expect(intent.body).toEqual({ type: "default", from: test.profile.boat.baseSnapshot, ttlSeconds: 3600, noEnv: true, env: {} });
    expect(intent.body).not.toHaveProperty("snapshots");
    await test.context.lease.save();
    await expect(test.adapter.build()).rejects.toMatchObject({ code: "release_worker_images_retired" });
    const result: any = await test.adapter.cleanup();
    expect(result).toMatchObject({ kind: "release-owned-sanitized-unavailable", provenance: { source: { commit, parent: commit, tree: files.tree,
      archiveSha256: files.archiveSha256, exactMergedCommit: true }, generation: { attempt: generated.attempt, scriptSha256: generated.scriptSha256,
        contract: generated.contract }, snapshot: { savedAt: ledger.createdAt, readyObservedAt: ledger.lastObservedAt,
        sanitation: { observedAt: ledger.sanitation.observedAt } }, creation: { body: intent.body, key: intent.key, billingOrgConfirmed: true } } });
    expect(test.record.builderIntent).toEqual(intent); expect(test.record.kitFiles).toBeUndefined();
    const resumed = await boatImageAdapter(test.config, test.environment, path.join(test.directory, "compact-resume"), test.context);
    await expect(resumed.build()).rejects.toMatchObject({ code: "release_worker_images_retired" }); await resumed.cleanup();
    expect(test.request.mock.calls.some(([method]) => method === "POST" || method === "PUT")).toBe(false);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.context.kit).not.toHaveBeenCalled(); expect(test.context.reserve).not.toHaveBeenCalled();
  });
  it.each([{ id: "invalid-operation" }, { kind: "snapshot" }, { targetId: "bx_other" }])("does not retain or replay an unconfirmed DELETE response %j", async patch => {
    const test = await fixture(), base = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, settings) => method === "DELETE" ? { status: 202, body: { operation: { ...test.operation, ...patch } } } as any
      : base(method, route, settings));
    await expect(test.adapter.cleanup()).rejects.toThrow("unconfirmed"); assertHeld(test);
    expect(test.record.builder.deletionOperationId).toBeUndefined();
    await expect(test.adapter.cleanup()).rejects.toThrow("response was lost");
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("recovers a saved DELETE operation after unauthenticated readback without dispatching DELETE again", async () => {
    const test = await fixture(), base = test.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, settings) => route.startsWith("/deletion-operations/") ? { status: 403 } as any : base(method, route, settings));
    await expect(test.adapter.cleanup()).rejects.toThrow("proof changed"); assertHeld(test);
    test.request.mockImplementation(base);
    await expect(test.adapter.cleanup()).resolves.toMatchObject({ kind: "release-owned-sanitized-unavailable" });
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("restarts from the authenticated state saved before the compute marker, preserving operation and provenance", async () => {
    const test = await fixture(), save = test.context.lease.save.getMockImplementation()!;
    test.context.lease.save.mockImplementation(async () => {
      if (test.record.builder.retiredAt) throw new Error("synthetic marker save failure"); await save();
    });
    await expect(test.adapter.cleanup()).rejects.toThrow("marker save failure");
    const recovered = structuredClone(test.saves.at(-1)), record = recovered.resources.images[0];
    expect(record.builder.cleanup.provenance).toBeDefined(); expect(record.builder.retiredAt).toBeUndefined();
    const context = { ...test.context, lease: { ...test.context.lease, state: recovered, save: vi.fn(async () => {}) }, record };
    const resumed = await boatImageAdapter(test.config, test.environment, path.join(test.directory, "restart-before-marker"), context);
    await expect(resumed.cleanup()).resolves.toMatchObject({ kind: "release-owned-sanitized-unavailable" });
    expect(record.builder.deleted).toBe(false); expect(record.builder.retiredAt).toEqual(expect.any(String));
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(record.kitFiles).toBeUndefined();
  });
  it("keeps overdue upload storage pending; expectedBy is not an age-based erasure or named-slot release", async () => {
    const test = await fixture({ savedAgeMs: 2 * 3600_000 }); test.operation.expectedBy = new Date(Date.now() - 60_000).toISOString();
    await test.adapter.cleanup(); await reconcileReleaseBuilderRetentions(test.config, test.context);
    expect(test.record.builder.deleted).toBe(false); expect(test.record.builder.cleanup.storage.status).toBe("pending");
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
  });
  it("bounds historical observation by record count and rotates fairly while keeping unresolved storage and named holds", async () => {
    const test = await fixture(), second = await fixture({ runId: "124" }); await test.adapter.cleanup(); await second.adapter.cleanup();
    test.state.resources.images.push(second.record); test.state.releaseRuns.push(second.run);
    const first = await test.store.readAdmission();
    await test.store.writeAdmission({ ...first.state, reservations: [...first.state.reservations,
      ...second.ledger().reservations.filter((row: any) => row.kind === "builder")] }, first.etag);
    const base = test.request.getMockImplementation()!, other = second.request.getMockImplementation()!;
    test.request.mockImplementation(async (method, route, settings) => route.includes(second.record.builder.id) || route.includes(second.operation.id) ||
      route.includes(second.candidate.snapshotId) ? other(method, route, settings) : base(method, route, settings));
    test.request.mockClear();
    await reconcileReleaseBuilderRetentions({ ...test.config, runId: "125" }, test.context, { maxRecords: 1 });
    expect(test.request.mock.calls.filter(([_method, route]) => route.startsWith("/deletion-operations/"))).toHaveLength(1);
    expect(test.record.builder.lastReconcileAt).toEqual(expect.any(String)); expect(second.record.builder.lastReconcileAt).toBeUndefined();
    await reconcileReleaseBuilderRetentions({ ...test.config, runId: "125" }, test.context, { maxRecords: 1 });
    expect(second.record.builder.lastReconcileAt).toEqual(expect.any(String));
    expect(test.record.builder.deleted).toBe(false); expect(second.record.builder.deleted).toBe(false);
    expect(test.ledger().reservations.filter((row: any) => row.kind === "builder").every((row: any) => !row.snapshotReleasedAt)).toBe(true);
    expect(test.request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("keeps provenance durable across a crash between physical-result persistence and its terminal marker", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    const certificate = structuredClone(test.record.builder.cleanup.provenance), save = test.context.lease.save.getMockImplementation()!;
    test.operation.status = "completed"; test.operation.completedAt = new Date().toISOString();
    test.context.lease.save.mockImplementation(async () => {
      if (test.record.builder.deleted) throw new Error("synthetic physical marker save failure"); await save();
    });
    await expect(test.adapter.cleanup()).rejects.toThrow("physical marker save failure");
    const recovered = structuredClone(test.saves.at(-1)), record = recovered.resources.images[0];
    expect(record.builderProvenance).toEqual(certificate); expect(record.builder.deleted).toBe(false);
    const lease = { state: recovered, signal: new AbortController().signal, save: vi.fn(async () => {}), fence: vi.fn(async () => {}) };
    const context = { ...test.context, lease, record, release: vi.fn(async () => { await releaseHostedAdmission(test.store, lease, test.profile); }) };
    const resumed = await boatImageAdapter(test.config, test.environment, path.join(test.directory, "physical-marker-restart"), context);
    await expect(resumed.cleanup()).resolves.toMatchObject({ kind: "physically-deleted", deletionOperationId: test.operation.id });
    expect(record.builderProvenance).toEqual(certificate); expect(record.builder.deleted).toBe(true);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(test.record.snapshotDeleted).toBeUndefined(); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it("stops historical provider reads at the explicit budget without dropping storage proof or issuing mutations", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    const beginning = Date.now(), base = test.request.getMockImplementation()!;
    let elapsed = 0;
    test.request.mockImplementation(async (method, route, settings) => { elapsed = 600; return base(method, route, settings); });
    test.request.mockClear();
    await expect(reconcileReleaseBuilderRetentions(test.config, { ...test.context, now: () => beginning + elapsed }, { budgetMs: 500 })).rejects.toThrow("unconfirmed");
    expect(test.request.mock.calls).toHaveLength(1);
    expect(test.request.mock.calls[0]).toEqual(["GET", `/deletion-operations/${test.operation.id}`, { timeoutMs: 500 }]);
    expect(test.record.builder.deleted).toBe(false); expect(test.record.builder.reconcileUnconfirmed).toBe(true);
    expect(test.record.builder.cleanup.provenance).toBeDefined(); expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
  it("admits a third channel name after compute release while allowing only one concurrent builder", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    const next = workerSnapshotName(test.state, "f".repeat(64));
    const inventory = [...test.inventory, { provider: "boat", id: `dev-${test.state.owner}-${test.state.generation.slice(0, 8)}-rollback` }];
    expect(assertWorkerSnapshotSlots("alpha", next, test.profile, inventory, test.ledger().reservations).used).toBe(4);
    await expect(reserveWorkerSlot(test.store, test.context.lease, test.profile, "alpha", next, inventory)).resolves.toBeDefined();
    const first = "66666666-6666-4666-8666-666666666666";
    await expect(reserveHostedAdmission(test.store, test.state, test.profile, { kind: "builder", computeId: `canary:${first}` })).rejects.toThrow("admission cap");
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
});
