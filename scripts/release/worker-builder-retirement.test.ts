import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseHostedAdmission, reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { nativeAgentCanary } from "../dev-environment/native-agent-canary.mjs";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { main as imageKit } from "../cloud-workspace-validation/boat-image/boat-image";
import { boatImageAdapter } from "./worker-adapters";
import { assertWorkerSnapshotSlots, reconcileWorkerSnapshotHolds, reserveWorkerSlot, workerOwner, workerSnapshotName } from "./worker-admission";
import { workerExecutionConfig } from "./worker-config";
import { workerEnvironment, workerConnections } from "./worker-test-fixtures";
import { promoteWorker, validateWorkerReceipt, WorkerReceipt } from "./worker";
import { releaseCanaryAdapter } from "./worker-canary";
import { reconcileReleaseBuilderRetentions, WorkerBuilderCleanupSchema } from "./worker-builder-retirement";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

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
    readAdmission: vi.fn(async () => ({ state: structuredClone(ledger), etag: String(revision) })),
    writeAdmission: vi.fn(async (value: any, etag: string) => {
      expect(etag).toBe(String(revision)); ledger = structuredClone(value); revision++;
    }) };
  const inventory = [{ provider: "boat", id: profile.boat.baseSnapshot }, { provider: "boat", id: snapshotId }];
  await reserveWorkerSlot(store, lease, profile, config.channel, snapshotId, inventory);
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
function nativeHarness(test: Awaited<ReturnType<typeof fixture>>, blocked = false) {
  const base = test.request.getMockImplementation()!, sandboxes = new Map<string, any>(), operations = new Map<string, any>();
  let allocations = 0;
  test.request.mockImplementation(async (method, route, ...settings: any[]) => {
    if (method === "POST" && route === "/sandboxes") {
      allocations++;
      const id = `bx_native${allocations}`, sandbox = { id, team: { id: test.profile.boat.billingOrg }, state: "running" };
      sandboxes.set(id, sandbox); return { status: 201, body: { sandbox } } as any;
    }
    if (route.startsWith("/sandboxes/bx_native")) {
      const id = route.slice("/sandboxes/".length);
      if (method === "DELETE") {
        const operation = { id: `bdop_${String(allocations).padStart(32, "0")}`, kind: "sandbox", targetId: id,
          status: blocked ? "blocked" : "completed", stage: blocked ? "waiting_for_uploads" : "completed",
          expectedBy: test.operation.expectedBy, completedAt: new Date().toISOString() };
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
  }, { strictCleanup: true, maxUsedHours: 2, cleanupTimeoutMs: 0, nativeDeadlineSeconds: 420 });
  const connections = workerConnections(), core = { ...native, ready: vi.fn(async () => true), start: vi.fn(async () => {}), poll: vi.fn(async (job: any) => ({
    code: 0, retirement: 0, renewal: { accountBinding: true, accessChanged: true, cachePublished: true, consentPreserved: true },
    report: { version: 3, qualified: true, qualificationProfile: "smoke", executionProfile: "zeros-cloud-native-v1", authority: "isolated-image-canary",
      qualifiedAt: new Date().toISOString(), identity: { sourceCommit: test.candidate.sourceCommit, buildSha256: test.candidate.buildSha256,
        contractSha256: "c".repeat(64), kind: job.kind, model: job.model },
      checks: ["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission", "stopAndRevocation", "nativeTurn", "nativeResume",
        "authentication", "nativePermissionSelection", "nativeAccessRefresh", "nativeMcp"] } })) };
  const canary = releaseCanaryAdapter(test.context.lease, test.run, new Map(connections.map(row => [row.kind, row])), core, { qualificationProfile: "smoke" });
  const input = { ...test.config, kinds: connections.map(row => row.kind), actorUserId: "44444444-4444-4444-8444-444444444444",
    operationId: "55555555-5555-4555-8555-555555555555", inputsSha256: test.run.inputsSha256, qualificationProfile: "smoke" as const, releaseCanaryBindings: connections };
  const owner = vi.fn(async (action: any) => ({ value: await action({ loginIdentity: "synthetic-owner", manage: async (_document: any, approval: string) =>
    ({ state: approval ? "changed" : "planned", planSha256: "d".repeat(64), targetSha256: "f".repeat(64) }) }), deleted: true }));
  const tuple = vi.fn(async () => {});
  const deps = { build: () => test.adapter.build(), cleanupBuilder: () => test.adapter.cleanup(), qualify: (image: any, kind: string) => canary.qualify(image, kind),
    cleanup: async () => {
      const deleted = await canary.cleanup(), imageBuilder = await test.adapter.cleanup();
      return deleted && imageBuilder ? { credentialCanaryResourcesDeleted: true as const, imageBuilder } : null;
    }, withOwner: owner, updateIdentity: tuple };
  return { native, canary, core, input, deps, owner, tuple, sandboxes, operations, allocations: () => allocations };
}

describe("release-owned builder retirement composition", () => {
  it("persists truthful pending-storage provenance before freeing compute, retaining the named-image hold", async () => {
    const test = await fixture();
    expect(await test.adapter.build()).toEqual(test.candidate);
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
  it("qualifies through actual canary allocation/strict retirement and publishes v2 only after every native VM is physically deleted", async () => {
    const test = await fixture(), native = nativeHarness(test);
    const receipt = await promoteWorker(native.input, native.deps);
    expect(receipt).toMatchObject({ version: 2, cleanup: { credentialCanaryResourcesDeleted: true,
      imageBuilder: { kind: "release-owned-sanitized-unavailable", storage: { status: "pending", physicalBytes: "unmeasured" } } } });
    expect(receipt).not.toHaveProperty("resourcesDeleted");
    expect(validateWorkerReceipt(receipt, native.input)).toEqual(receipt);
    expect(native.allocations()).toBe(3); expect(native.owner).toHaveBeenCalledOnce(); expect(native.tuple).toHaveBeenCalledOnce();
    expect(test.state.resources.images.filter((image: any) => image.purpose === "native-agent-qualification")).toHaveLength(3);
    expect(test.state.resources.images.filter((image: any) => image.purpose === "native-agent-qualification").every((image: any) => image.builder.deleted === true)).toBe(true);
    expect(test.request.mock.calls.filter(([method, route]) => method === "POST" && route === "/sandboxes").every(call =>
      (call as any)[2].body.snapshots === false && (call as any)[2].body.noEnv === true && Object.keys((call as any)[2].body.env).length === 0)).toBe(true);
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
    await expect(promoteWorker(native.input, native.deps)).rejects.toThrow("blocked");
    expect(native.allocations()).toBe(1); expect(native.owner).not.toHaveBeenCalled(); expect(native.tuple).not.toHaveBeenCalled();
    const canary = test.state.resources.images.find((image: any) => image.purpose === "native-agent-qualification");
    expect(canary.builder.deleted).not.toBe(true); expect(canary.builder.retiredAt).toBeUndefined();
    expect(test.ledger().reservations.find((row: any) => row.computeId === `canary:${canary.agentQualificationId}`).releasedAt).toBeUndefined();
    expect(test.request.mock.calls.filter(([method, route]) => method === "DELETE" && route.startsWith("/sandboxes/bx_native"))).toHaveLength(1);
  });
  it("does not allocate even a credential-free canary when the real builder proof is ineligible", async () => {
    const test = await fixture(), native = nativeHarness(test);
    patchProof(test, "source", value => { value.commit = "f".repeat(40); });
    await expect(promoteWorker(native.input, native.deps)).rejects.toThrow();
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
    expect(await resumed.build()).toEqual(test.candidate);
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
    const test = await fixture(), native = nativeHarness(test), receipt: any = await promoteWorker(native.input, native.deps);
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
  it("extracts provenance from the actual image-kit export/generation/attestation/save files and original creation dispatch", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "zeros-release-kit-source-")); directories.push(repository);
    const git = (...arguments_: string[]) => execFileSync("git", ["-c", "user.name=Release Kit Fixture", "-c", "user.email=release-kit@example.invalid", ...arguments_],
      { cwd: repository, encoding: "utf8" }).trim();
    git("init", "-q"); await writeFile(path.join(repository, "fixture.txt"), "committed source\n");
    git("add", "fixture.txt"); git("commit", "-q", "-m", "synthetic release source");
    const commit = git("rev-parse", "HEAD"), test = await fixture({ sourceCommit: commit });
    await rm(test.directory, { recursive: true, force: true }); await mkdir(test.directory, { mode: 0o700 });
    for (const key of ["candidate", "buildSha256", "qualified", "snapshotRequested", "builderCreate", "snapshotCreate", "builder", "builderIntent", "kitFiles"])
      delete test.record[key];
    const commands: string[][] = [], original = test.request.getMockImplementation()!;
    let available = true, saving = false, command: string[] = [];
    test.request.mockImplementation(async (method, route, settings: any = {}) => {
      if (method === "POST" && route === "/sandboxes") {
        expect(test.record.builderIntent.scope).toMatchObject({ owner: test.state.owner, generation: test.state.generation,
          accountBinding: test.ledger().account, repository: test.config.repository, runId: test.config.runId });
        expect(settings.headers).toMatchObject({ "idempotency-key": test.record.builderIntent.key, "x-boat-org": test.profile.boat.billingOrg });
        expect(settings.body).toEqual({ type: "default", from: test.profile.boat.baseSnapshot, ttlSeconds: 3600, noEnv: true, env: {} });
        expect(settings.body).not.toHaveProperty("snapshots");
        return { status: 201, body: { sandbox: { id: "bx_builder", team: { id: test.profile.boat.billingOrg }, state: "running" } } } as any;
      }
      if (method === "GET" && route === "/sandboxes/bx_builder") return available ? { status: 200,
        body: { sandbox: { id: "bx_builder", team: { id: test.profile.boat.billingOrg }, state: "running" } } } as any : { status: 404 } as any;
      if (method === "PUT" && route.endsWith("/files")) return { status: 200, body: { size: Buffer.from(settings.body.content, "base64").length } } as any;
      if (method === "POST" && route.endsWith("/commands")) {
        let result: unknown = {};
        if (command[0] === "attestation") result = { exit: { code: 0, retirement: 0, scopePresent: false }, error: "", report: JSON.stringify({ qualified: true,
          setupQualification: { secure: true }, metadata: { buildSha256: "b".repeat(64), build: { source: { commit, contractSha256: "c".repeat(64) },
            imageContractSha256: imageContractSha256() } }, resources: { allocation: { storageBytes: 4096 * 1048576 } } }) };
        else if (command[0] === "generate-post" || command[2]?.endsWith("build-hash.sh")) result = {
          commit: command[0] === "generate-post" ? commit : "f".repeat(40), contract: imageContractSha256(), buildSha256: "b".repeat(64) };
        else if (command[2]?.endsWith("build-status.sh")) result = { result: { passed: true } };
        else if (command[0] === "snapshot" && command[1] === "save") result = { qualified: true, sourceCommit: commit, buildSha256: "b".repeat(64),
          knownCredentialFiles: 0, nativeCredentialPresent: false, activeBackhaulService: false, staleAdmissionRemoved: true,
          observedAt: new Date().toISOString().replace("Z", "+00:00") };
        return { status: 200, body: { exitCode: 0, timedOut: false, stdoutTruncated: false, stdout: JSON.stringify(result) } } as any;
      }
      if (method === "GET" && route === "/named-snapshots") return { status: 200, body: { snapshots: [{ name: test.profile.boat.baseSnapshot }] } } as any;
      if (method === "POST" && route === "/named-snapshots") {
        expect(settings.body).toEqual({ name: test.candidate.snapshotId, sandboxId: "bx_builder" }); saving = true;
        return { status: 201, body: { snapshot: { name: settings.body.name, sourceSandboxId: "bx_builder", status: "ready" } } } as any;
      }
      if (route === `/named-snapshots/${test.candidate.snapshotId}`) {
        expect(saving).toBe(true); return { status: 200, body: { snapshot: { name: test.candidate.snapshotId, sourceSandboxId: "bx_builder", status: "ready",
          snapshotId: "provider-snapshot-fixture", sizeBytes: 12345 } } } as any;
      }
      if (method === "DELETE") available = false;
      return original(method, route, settings);
    });
    test.context.kit.mockImplementation(async (arguments_: string[], dependencies: any) => {
      command = arguments_; commands.push([...arguments_]); return imageKit(arguments_, { ...dependencies, repoRoot: repository });
    });
    test.context.reserve.mockImplementation(async () => reserveWorkerSlot(test.store, test.context.lease, test.profile, "alpha", test.candidate.snapshotId,
      [{ provider: "boat", id: test.profile.boat.baseSnapshot }]));
    expect(await test.adapter.build()).toEqual(test.candidate);
    const files = JSON.parse(await readFile(path.join(test.directory, commit.slice(0, 12), "source.json"), "utf8"));
    const generated = JSON.parse(await readFile(path.join(test.directory, commit.slice(0, 12), "generation.json"), "utf8"));
    const ledger = JSON.parse(await readFile(path.join(test.directory, commit.slice(0, 12), "snapshot-ledger.json"), "utf8"));
    const intent = structuredClone(test.record.builderIntent), result: any = await test.adapter.cleanup();
    expect(result).toMatchObject({ kind: "release-owned-sanitized-unavailable", provenance: { source: { commit, parent: commit, tree: files.tree,
      archiveSha256: files.archiveSha256, exactMergedCommit: true }, generation: { attempt: generated.attempt, scriptSha256: generated.scriptSha256,
        contract: generated.contract }, snapshot: { savedAt: ledger.createdAt, readyObservedAt: ledger.lastObservedAt,
        sanitation: { observedAt: ledger.sanitation.observedAt } }, creation: { body: intent.body, key: intent.key, billingOrgConfirmed: true } } });
    expect(test.record.builderIntent).toEqual(intent); expect(test.record.kitFiles).toBeUndefined();
    expect(commands.map(arguments_ => arguments_.slice(0, 2).join(" "))).toContain("snapshot save");
    const resumed = await boatImageAdapter(test.config, test.environment, path.join(test.directory, "compact-resume"), test.context);
    expect(await resumed.build()).toEqual(test.candidate); await resumed.cleanup();
    expect(test.request.mock.calls.filter(([method, route]) => method === "POST" && route === "/sandboxes")).toHaveLength(1);
    expect(test.request.mock.calls.filter(([method]) => method === "DELETE")).toHaveLength(1);
    expect(commands.filter(arguments_ => arguments_[0] === "snapshot" && arguments_[1] === "save")).toHaveLength(1);
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
  it("refuses a third channel name after compute release while allowing only one concurrent native builder", async () => {
    const test = await fixture(); await test.adapter.cleanup();
    const next = workerSnapshotName(test.state, "f".repeat(64));
    const inventory = [...test.inventory, { provider: "boat", id: `dev-${test.state.owner}-${test.state.generation.slice(0, 8)}-rollback` }];
    expect(() => assertWorkerSnapshotSlots("alpha", next, test.profile, inventory, test.ledger().reservations)).toThrow("channel slot");
    await expect(reserveWorkerSlot(test.store, test.context.lease, test.profile, "alpha", next, inventory)).rejects.toThrow("image capacity reached");
    const first = "66666666-6666-4666-8666-666666666666", second = "77777777-7777-4777-8777-777777777777";
    await reserveHostedAdmission(test.store, test.state, test.profile, { kind: "builder", computeId: `canary:${first}` });
    await expect(reserveHostedAdmission(test.store, test.state, test.profile, { kind: "builder", computeId: `canary:${second}` })).rejects.toThrow("admission cap");
    expect(imageHold(test).snapshotReleasedAt).toBeUndefined();
  });
});
