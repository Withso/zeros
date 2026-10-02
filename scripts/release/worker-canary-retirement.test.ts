import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseReleaseCanaryService, releaseCanaryRequest } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";
import { BoatAccountAdmission, releaseWorkerOwner } from "../../apps/control-plane/src/cloud-workspaces/boat-account-admission";
import { createReleaseCanaryAdmissionRoutes } from "../../apps/control-plane/src/cloud-workspaces/release-canary-routes";
import { WorkerBuilderProvenanceSchema } from "./worker-builder-retirement";
import { workerSnapshotName } from "./worker-admission";
import { workerConnections } from "./worker-test-fixtures";
import { workerEnvironment } from "./worker-test-fixtures";
import { workerExecutionConfig } from "./worker-config";
import { releaseCanaryBroker } from "./worker-broker";
import { reconcileReleaseCanaryRetirements } from "./worker-canary-recovery";
import { nativeAgentCanary } from "../dev-environment/native-agent-canary.mjs";
import { releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { runReleaseCanaryAdmission } from "../../apps/control-plane/src/cloud-workspaces/release-canaries";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const owner = "11111111-1111-4111-8111-111111111111", organizationId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444", deletionOperationId = `bdop_${"c".repeat(32)}`;
const token = "synthetic-protected-retirement-authority";
const leaseToken = "77777777-7777-4777-8777-777777777777";
const retirementInput = () => ({ version: 1, operationId, deletionOperationId, leaseToken });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
  const now = Date.now(), at = (age: number) => new Date(now - age).toISOString();
  const profile = { boat: { accountScope: "shared-test-account", billingOrg: "test-wallet", baseSnapshot: "test-base" },
    railway: { projectId: "test-project" }, planetscale: { organization: "test-org", database: "test-db" }, cloudflare: { accountId: "test-account" } };
  const accountBinding = hash([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId,
    profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId]);
  const state: any = { version: 2, owner: releaseWorkerOwner("alpha"), generation: "55555555-5555-4555-8555-555555555555",
    identity: hash(["release-worker", "example/zeros", "alpha"]), status: "provisioning", lease: { token: leaseToken, expiresAt: now + 60_000 }, resources: { images: [] }, releaseRuns: [] };
  const sourceSha = "a".repeat(40), snapshotId = workerSnapshotName(state, hash([sourceSha, "123"]));
  const candidate = { snapshotId, sourceCommit: sourceSha, buildSha256: "b".repeat(64), architecture: "linux/amd64", storageMiB: 4096 };
  const connection = workerConnections().find(row => row.kind === "codex-chatgpt")!;
  const request = releaseCanaryRequest({ version: 1, ownerUserId: owner, organizationId, channel: "alpha", sourceSha, repository: "example/zeros",
    operationId, runId: "123", runAttempt: "1", branch: "main", qualificationProfile: "smoke", ...connection,
    target: { id: "bx_canary", attempt: operationId, snapshotId, sourceCommit: sourceSha, buildSha256: candidate.buildSha256 } },
  { ownerUserId: owner, organizationId, channel: "alpha", sourceSha, repository: "example/zeros" });
  const body = { type: "default", from: profile.boat.baseSnapshot, ttlSeconds: 3600, noEnv: true, env: {} };
  const scope = { repository: request.repository, channel: request.channel, runId: request.runId, runAttempt: request.runAttempt,
    sourceSha, inputsSha256: "e".repeat(64), owner: state.owner, generation: state.generation, accountBinding, protectedBaseSnapshot: profile.boat.baseSnapshot };
  const sanitation = { qualified: true, sourceCommit: sourceSha, buildSha256: candidate.buildSha256, observedAt: at(100_000) };
  const provenance = WorkerBuilderProvenanceSchema.parse({ version: 1, purpose: "release-worker", scope,
    creation: { sandboxId: "bx_builder", key: "66666666-6666-4666-8666-666666666666", requestedAt: at(120_000), createdAt: at(120_000),
      body, bodySha256: hash(body), billingOrgConfirmed: true, billingObservedAt: at(119_000) },
    source: { commit: sourceSha, parent: sourceSha, tree: "c".repeat(40), archiveSha256: "d".repeat(64), exactMergedCommit: true },
    generation: { commit: sourceSha, previous: "f".repeat(40), contract: "f".repeat(64), attempt: `m2-build-${"f".repeat(32)}`,
      scriptSha256: "a".repeat(64), buildSha256: candidate.buildSha256, snapshotName: snapshotId },
    attestation: { qualified: true, secureSetup: true, sourceCommit: sourceSha, buildSha256: candidate.buildSha256, storageMiB: 4096, sha256: "d".repeat(64) },
    snapshot: { name: snapshotId, sourceSandboxId: "bx_builder", sourceCommit: sourceSha, buildSha256: candidate.buildSha256, savedAt: at(100_000),
      readyObservedAt: at(99_000), sanitation, sanitationSha256: hash(sanitation), sanitationReportSha256: "e".repeat(64) }, candidate });
  const parent: any = { purpose: "release-worker", releaseRunId: request.runId, sourceCommit: sourceSha, inputsSha256: scope.inputsSha256,
    snapshotId, candidate, buildSha256: candidate.buildSha256, qualified: true, snapshotRequested: true, snapshotCreate: { phase: "acknowledged" },
    builderIntent: { key: provenance.creation.key, body, at: Date.parse(provenance.creation.requestedAt), scope },
    builder: { id: "bx_builder", cleanup: { kind: "release-owned-sanitized-unavailable", provenance, provenanceSha256: hash(provenance) } } };
  const row: any = { purpose: "native-agent-qualification", agentQualificationId: operationId, sourceImage: snapshotId, sourceCommit: sourceSha,
    inputsSha256: createHash("sha256").update(`native-agent:${operationId}`).digest("hex"),
    builderIntent: { key: operationId, at: now - 60_000, body: { type: "default", from: snapshotId, ttlSeconds: 2700, noEnv: true, env: {}, snapshots: false } },
    builderCreate: { phase: "acknowledged" }, machineAttestationStarted: true, nativeDispatchStarted: true,
    builder: { id: request.target.id, deleteRequested: true, deletionOperationId } };
  const job: any = { id: operationId, ...connection, qualificationProfile: "smoke", phase: "starting", startedAt: now - 61_000, image: candidate };
  state.resources.images.push(parent, row);
  state.releaseRuns.push({ runId: request.runId, sourceSha, actorUserId: owner, inputsSha256: scope.inputsSha256,
    qualificationProfile: "smoke", releaseCanaryBindings: workerConnections(), canaries: [job] });
  const ledger: any = { version: 1, owner: "account-admission", account: accountBinding, reservations: [{ kind: "builder", owner: state.owner,
    generation: state.generation, computeId: `canary:${operationId}`, createdAt: at(61_000) }] };
  const store: any = { readDocument: vi.fn(async () => ({ state, etag: "original-journal" })), readAdmission: vi.fn(async () => ({ state: ledger, etag: "original-ledger" })) };
  const admission = new BoatAccountAdmission(store, profile);
  const subject = { operationId, requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), ...connection,
    qualificationProfile: "smoke", channel: request.channel, sourceSha, repository: request.repository, runId: request.runId, runAttempt: request.runAttempt,
    targetId: request.target.id, imageRef: `boat:${snapshotId}@sha256:${candidate.buildSha256}`, allowanceOwnerUserId: owner, beforeVersion: 1 };
  const audits: any[] = [{ id: "50", action: "cloud.release_canary.dispatched", subject, created_at: new Date(now - 40_000) }];
  const query = vi.fn(async (sql: string, values: any[] = []): Promise<any> => {
    if (sql.includes("FROM users account")) return { rowCount: 1, rows: [] };
    if (sql.includes("FROM audit_log") && sql.includes("operationId")) return { rowCount: 1, rows: [structuredClone(audits.at(-1))] };
    if (sql.startsWith("INSERT INTO audit_log")) {
      const audit = { id: String(50 + audits.length), action: values[2], subject: JSON.parse(values[3]) }; audits.push(audit);
      return { rowCount: 1, rows: [{ id: audit.id }] };
    }
    return { rowCount: 0, rows: [] };
  });
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as any;
  const config: any = { ownerUserId: owner, organizationId, channel: "alpha", sourceSha: "d".repeat(40), repository: request.repository,
    tokenSha256: createHash("sha256").update(token).digest("hex"), keys: {}, admission, boat: { apiKey: "synthetic-boat-authority", apiUrl: "https://boat.example.test", billingOrg: profile.boat.billingOrg } };
  const operation: any = { id: deletionOperationId, kind: "sandbox", targetId: request.target.id, status: "completed", stage: "completed",
    reason: "explicit", requestedAt: at(20_000), completedAt: at(10_000) };
  row.builder.physicalCleanup = { version: 1, operationId, targetId: request.target.id, snapshotId, sourceCommit: sourceSha,
    buildSha256: candidate.buildSha256, creationIntentSha256: hash(row.builderIntent), accountBinding, billingOrg: profile.boat.billingOrg,
    operation: { id: operation.id, kind: operation.kind, targetId: operation.targetId, status: operation.status, requestedAt: operation.requestedAt, completedAt: operation.completedAt },
    operationObservedAt: at(9000), unavailableObservedAt: at(8000) };
  const provider: any = { operationStatus: 200, sandboxStatus: 404 };
  const fetcher = vi.fn(async (url: any, options: any) => {
    expect(options.method).toBe("GET");
    if (String(url).endsWith(`/deletion-operations/${deletionOperationId}`)) return new Response(JSON.stringify({ operation }), { status: provider.operationStatus });
    if (String(url).endsWith(`/sandboxes/${request.target.id}`)) return new Response(JSON.stringify({}), { status: provider.sandboxStatus });
    throw new Error("Unexpected synthetic retirement request");
  });
  vi.stubGlobal("fetch", fetcher);
  const service = new DatabaseReleaseCanaryService(pool, config);
  return { state, parent, row, job, ledger, store, admission, request, subject, audits, query, config, service, operation, provider, fetcher, profile };
}

describe("marked release canary policy admission", () => {
  it("requires the retained snapshots-off observation for marked intents before the server's fresh read", async () => {
    const test = fixture(); test.row.builder = { id: test.request.target.id }; test.row.snapshotPolicyVersion = 1;
    await expect(test.admission.assertCanary(test.request)).rejects.toThrow("snapshots-off policy");
    const observation = { version: 1, targetId: test.request.target.id, snapshots: false, observedAt: new Date().toISOString() };
    test.row.snapshotPolicyObserved = observation;
    expect(await test.admission.assertCanary(test.request)).toEqual({ snapshotsOffRequired: true });
    for (const change of [{ version: 2 }, { targetId: "bx_other" }, { snapshots: true }, { observedAt: "invalid" }]) {
      test.row.snapshotPolicyObserved = { ...observation, ...change };
      await expect(test.admission.assertCanary(test.request)).rejects.toThrow("snapshots-off policy");
    }
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.audits).toHaveLength(1);
  });
  it.each([undefined, true, false])("does not retrofit a readback requirement onto a historical snapshots=%s intent", async snapshots => {
    const test = fixture(); test.row.builder = { id: test.request.target.id };
    if (snapshots === undefined) delete test.row.builderIntent.body.snapshots;
    else test.row.builderIntent.body.snapshots = snapshots;
    expect(await test.admission.assertCanary(test.request)).toBeUndefined();
    expect(test.row.snapshotPolicyVersion).toBeUndefined(); expect(test.row.snapshotPolicyObserved).toBeUndefined();
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.audits).toHaveLength(1);
  });
});

describe("truthful release-only native retirement reconciliation", () => {
  it("reconciles an exact terminal audit after JSONB reorders the saved operation fields", async () => {
    const test = fixture();
    await test.service.retire(retirementInput(), `Bearer ${token}`);
    const retired = test.audits[1];
    retired.subject.retirement.operation = Object.fromEntries(Object.entries(retired.subject.retirement.operation).reverse());
    expect(await test.service.retire(retirementInput(), `Bearer ${token}`)).toEqual({ retired: true });
    expect(test.audits).toHaveLength(2); expect(test.fetcher).toHaveBeenCalledTimes(4);
    expect(test.query.mock.calls.some(([sql]) => sql.includes("cloud_agent_credential_versions"))).toBe(false);
  });
  it("appends retired across API source changes after reacquiring the old owning lease, without dispatch or rewriting history", async () => {
    const test = fixture(), original = structuredClone(test.audits[0]);
    test.state.lease.expiresAt = Date.now() - 1000;
    await expect(test.admission.assertCanary(test.request)).rejects.toThrow("fenced");
    test.state.lease.expiresAt = Date.now() + 60_000;
    expect(await test.service.retire(retirementInput(), `Bearer ${token}`)).toEqual({ retired: true });
    expect(test.audits).toHaveLength(2); expect(test.audits[0]).toEqual(original);
    expect(test.audits[1]).toMatchObject({ action: "cloud.release_canary.retired", subject: { ...test.subject,
      retirement: { version: 1, deletionOperationId, targetId: "bx_canary", operation: { status: "completed" } } } });
    expect(test.fetcher).toHaveBeenCalledTimes(2);
    expect(test.query.mock.calls.some(([sql]) => sql.includes("cloud_agent_credential_versions"))).toBe(false);
    expect(test.row.builder.deleted).not.toBe(true); expect(test.job.outcome).toBeUndefined();
    expect(test.ledger.reservations).toHaveLength(1);
  });
  it("rejects the real pending-stage shape despite sandbox404 and preserves the audit and compute reservation", async () => {
    const test = fixture(); Object.assign(test.operation, { status: "blocked", stage: "waiting_for_uploads", completedAt: null,
      expectedBy: new Date(Date.now() + 6 * 3600_000).toISOString() });
    await expect(test.service.retire(retirementInput(), `Bearer ${token}`)).rejects.toThrow("retirement");
    expect(test.audits).toHaveLength(1); expect(test.ledger.reservations).toHaveLength(1);
    expect(test.row.builder.deleted).not.toBe(true); expect(test.job.retired).not.toBe(true);
  });
  it("exposes a bounded authenticated retirement route, not a credential or customer endpoint", async () => {
    const test = fixture(), app = createReleaseCanaryAdmissionRoutes(test.service);
    const response = await app.request("/internal/v1/release-canaries/retirements", { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(retirementInput()) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ retired: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    ["pending operation", (test: any) => { test.operation.status = "pending"; }],
    ["unknown operation status", (test: any) => { test.operation.status = "unknown"; }],
    ["wrong operation", (test: any) => { test.operation.id = `bdop_${"e".repeat(32)}`; }],
    ["wrong target", (test: any) => { test.operation.targetId = "bx_other"; }],
    ["snapshot operation", (test: any) => { test.operation.kind = "snapshot"; }],
    ["missing deletion response", (test: any) => { delete test.row.builder.deletionOperationId; }],
    ["404 without retained proof", (test: any) => { test.provider.operationStatus = 404; }],
    ["still available sandbox", (test: any) => { test.provider.sandboxStatus = 200; }],
    ["wrong old source", (test: any) => { test.state.releaseRuns[0].sourceSha = "e".repeat(40); }],
    ["wrong run", (test: any) => { test.state.releaseRuns[0].runId = "124"; }],
    ["wrong actor", (test: any) => { test.state.releaseRuns[0].actorUserId = organizationId; }],
    ["wrong journal owner", (test: any) => { test.state.owner = "f".repeat(24); }],
    ["wrong repository", (test: any) => { test.state.identity = hash(["release-worker", "other/zeros", "alpha"]); }],
    ["wrong account", (test: any) => { test.ledger.account = "e".repeat(64); }],
    ["conflicting admission hold", (test: any) => { test.ledger.reservations[0].owner = "f".repeat(24); }],
    ["missing account certificate", (test: any) => { delete test.parent.builder.cleanup.provenance; }],
    ["changed compact certificate", (test: any) => { test.parent.builder.cleanup.provenanceSha256 = "f".repeat(64); }],
    ["wrong generation", (test: any) => { test.state.generation = operationId; }],
    ["expired lease", (test: any) => { test.state.lease.expiresAt = Date.now() - 1; }],
    ["changed lease", (test: any) => { test.state.lease.token = operationId; }],
    ["changed credential binding", (test: any) => { test.job.credentialRevision = 2; }],
    ["changed request hash", (test: any) => { test.subject.requestSha256 = "e".repeat(64); }],
    ["customer resource purpose", (test: any) => { test.row.purpose = "customer-workspace"; }],
    ["shared builder target", (test: any) => { test.parent.builder.id = test.row.builder.id; }],
    ["deleted boolean without proof", (test: any) => { test.row.builder.deleted = true; delete test.row.builder.physicalCleanup; }],
    ["wrong original intent", (test: any) => { test.row.builderIntent.body.from = "another-worker"; }],
    ["native environment injection", (test: any) => { test.row.builderIntent.body.env = { OTHER: "synthetic-private-diagnostic" }; }],
    ["invalid completed timestamp", (test: any) => { test.operation.completedAt = "invalid"; }],
    ["future completed timestamp", (test: any) => { test.operation.completedAt = new Date(Date.now() + 60_000).toISOString(); }],
    ["deletion predates allocation", (test: any) => { test.operation.requestedAt = new Date(test.row.builderIntent.at - 1).toISOString(); }],
  ] as const)("rejects %s without changing history, releasing holds or reflecting private data", async (_name, change) => {
    const test = fixture(); change(test);
    const error = await test.service.retire(retirementInput(), `Bearer ${token}`).catch(value => value);
    expect(error.message).toMatch(/retirement/); expect(error.message).not.toContain("synthetic-private-diagnostic");
    expect(test.audits).toHaveLength(1); expect(test.ledger.reservations).toHaveLength(1);
    expect(test.job.retired).not.toBe(true);
  });
  it("requires current protected authority and original scope before any provider observation", async () => {
    const test = fixture();
    for (const authorization of [undefined, "Bearer synthetic-wrong-authority"])
      await expect(test.service.retire(retirementInput(), authorization)).rejects.toMatchObject({ status: 401 });
    await expect(test.service.retire({ ...retirementInput(), deleted: true }, `Bearer ${token}`)).rejects.toThrow("invalid");
    test.subject.allowanceOwnerUserId = organizationId;
    await expect(test.service.retire(retirementInput(), `Bearer ${token}`)).rejects.toThrow("scope");
    expect(test.fetcher).not.toHaveBeenCalled(); expect(test.audits).toHaveLength(1);
  });
  it("does not require current executable consent or a remaining reservation for truthful cleanup", async () => {
    const test = fixture(), original = test.query.getMockImplementation()!;
    test.ledger.reservations = [];
    test.query.mockImplementation(async (sql, values) => sql.startsWith("SELECT owner_user_id")
      ? { rows: [{ owner_user_id: owner, revoked_at: new Date(), revision: "2" }], rowCount: 1 } : original(sql, values));
    expect(await test.service.retire(retirementInput(), `Bearer ${token}`)).toEqual({ retired: true });
    expect(test.audits).toHaveLength(2);
    expect(test.query.mock.calls.some(([sql]) => sql.includes("cloud_agent_credential_versions"))).toBe(false);
    expect(() => releaseCanaryRequest(test.request, test.config)).toThrow("scope");
  });
  it("replays terminal settlement idempotently and never resurrects a retired operation", async () => {
    const test = fixture();
    await test.service.retire(retirementInput(), `Bearer ${token}`);
    await test.service.retire(retirementInput(), `Bearer ${token}`);
    expect(test.audits).toHaveLength(2);
    const deps = { phase: "retired", transition: vi.fn(), read: vi.fn(), renew: vi.fn(), assertFresh: vi.fn(), start: vi.fn(), observeStarted: vi.fn() };
    await expect(runReleaseCanaryAdmission(test.request, deps as any)).rejects.toThrow("reconciliation");
    expect(deps.read).not.toHaveBeenCalled(); expect(deps.renew).not.toHaveBeenCalled(); expect(deps.start).not.toHaveBeenCalled();
    expect(deps.observeStarted).not.toHaveBeenCalled(); expect(deps.transition).not.toHaveBeenCalled();
  });
  it("rejects an intervening start transition, then permits exact reconciliation of its latest immutable phase", async () => {
    const test = fixture(), original = test.fetcher.getMockImplementation()!; let transitioned = false;
    test.fetcher.mockImplementation(async (url, options) => {
      const result = await original(url, options);
      if (!transitioned) { transitioned = true; test.audits.push({ id: "51", action: "cloud.release_canary.started", subject: structuredClone(test.subject) }); }
      return result;
    });
    await expect(test.service.retire(retirementInput(), `Bearer ${token}`)).rejects.toThrow("phase changed");
    expect(test.audits).toHaveLength(2);
    expect(await test.service.retire(retirementInput(), `Bearer ${token}`)).toEqual({ retired: true });
    expect(test.audits).toHaveLength(3); expect(test.audits[2].action).toBe("cloud.release_canary.retired");
  });
  it("recovers the cancelled historical run through real native cleanup, admission CAS and audited replay after a lost response", async () => {
    const test = fixture();
    delete test.row.builder.physicalCleanup; test.row.builder.deleted = true;
    test.parent.builder.retiredAt = new Date(Date.now() - 40_000).toISOString();
    const namedHold = { kind: "builder", owner: test.state.owner, generation: test.state.generation, computeId: `snapshot:${test.parent.snapshotId}`,
      snapshotName: test.parent.snapshotId, createdAt: new Date(Date.now() - 120_000).toISOString(), releasedAt: new Date(Date.now() - 40_000).toISOString() };
    test.ledger.reservations.push(namedHold);
    const saves: any[] = [], lease = { state: test.state, signal: new AbortController().signal, fence: vi.fn(async () => {}),
      save: vi.fn(async () => { saves.push(structuredClone(test.state)); }) };
    test.store.list = async () => ({ records: [{ state: test.state }], quarantine: [] });
    test.store.writeAdmission = vi.fn(async (ledger: any) => {
      expect(test.row.builder.physicalCleanup).toMatchObject({ operationId, operation: { status: "completed" } });
      expect(saves.some(saved => saved.resources.images[1].builder.physicalCleanup && saved.resources.images[1].builder.deleted === false)).toBe(true);
      Object.assign(test.ledger, ledger); return "released-ledger";
    });
    const providerRequest = vi.fn(async (method: string, route: string) => {
      expect(method).toBe("GET");
      if (route === `/deletion-operations/${deletionOperationId}`) return { status: 200, body: { operation: structuredClone(test.operation) } };
      if (route === "/sandboxes/bx_canary") return { status: 404, body: null };
      throw new Error("Unexpected synthetic historical request");
    });
    const native = nativeAgentCanary(lease, test.profile, providerRequest, { release: () => releaseHostedAdmission(test.store, lease, test.profile) },
      { strictCleanup: true, cleanupTimeoutMs: 0 });
    const env = { ...workerEnvironment(), GITHUB_RUN_ID: "124", GITHUB_SHA: test.config.sourceSha, RELEASE_SHA: test.config.sourceSha,
      RUNTIME_QUALIFICATION_ACTOR_USER_ID: owner, WORKER_CANARY_ORGANIZATION_ID: organizationId, WORKER_CANARY_ADMISSION_TOKEN: token };
    const { config } = workerExecutionConfig(env); let lost = true;
    const api = vi.fn(async (_url: any, options: any) => {
      const result = await test.service.retire(JSON.parse(options.body), options.headers.authorization);
      if (lost) { lost = false; throw new Error("synthetic lost reconciliation response"); }
      return new Response(JSON.stringify(result));
    });
    const broker = releaseCanaryBroker(config, env, "smoke", api as any);
    await expect(reconcileReleaseCanaryRetirements(config, owner, lease, native, broker.retire)).rejects.toThrow("unconfirmed");
    expect(test.audits).toHaveLength(2); expect(test.row.builder.deleted).toBe(true);
    expect(test.ledger.reservations).toEqual([namedHold]); expect(test.job.auditRetired).toBeUndefined();
    expect(await reconcileReleaseCanaryRetirements(config, owner, lease, native, broker.retire)).toBe(1);
    expect(test.audits).toHaveLength(2); expect(test.job.retired).toBe(true);
    expect(test.job.auditRetired).toEqual({ version: 1, operationId, deletionOperationId });
    expect(test.job.outcome).toBeUndefined(); expect(test.job.phase).toBe("starting");
    expect(test.ledger.reservations).toEqual([namedHold]);
    expect(providerRequest.mock.calls.every(([method, route]) => method === "GET" && !route.includes("named-snapshots"))).toBe(true);
    expect(await reconcileReleaseCanaryRetirements(config, owner, lease, native, broker.retire)).toBe(0);
  });
});
