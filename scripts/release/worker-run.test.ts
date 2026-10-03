import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import type { Channel } from "./contracts";
import { workerOwner } from "./worker-admission";
import { workerExecutionConfig } from "./worker-config";
import { executeWorkerPromotion, reconcileWorkerNativeStorage } from "./worker-run";
import { workerConnections, workerEnvironment } from "./worker-test-fixtures";

const dependencies = vi.hoisted(() => ({ registry: vi.fn(), requiredChecks: vi.fn(), current: vi.fn() }));
vi.mock("../dev-environment/hosted-state.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../dev-environment/hosted-state.mjs")>(),
  r2Registry: dependencies.registry,
}));
vi.mock("./github", () => ({ githubClient: () => ({ assertRequiredChecks: dependencies.requiredChecks, assertCurrent: dependencies.current }) }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

function fixture(channel: Channel = "production", existing = true) {
  const env = { ...workerEnvironment(), RELEASE_CHANNEL: channel, RELEASE_BRANCH: channel === "alpha" ? "main" : "release/1.2.3",
    PLANETSCALE_DATABASE: `zeros-control-plane-${channel}` };
  const profile = { boat: { accountScope: env.BOAT_ACCOUNT_SCOPE, billingOrg: env.BOAT_BILLING_ORG, baseSnapshot: env.BOAT_BASE_SNAPSHOT },
    railway: { projectId: env.RAILWAY_PROJECT_ID }, planetscale: { organization: "synthetic-org", database: "synthetic-db" },
    cloudflare: { accountId: "synthetic-account" } };
  env.WORKER_ADMISSION_CONFIG_JSON = JSON.stringify({ version: 1, profile, registry: {
    endpoint: "https://synthetic-r2.invalid", bucket: "synthetic-registry", accessKeyId: "synthetic-access-key",
    secretAccessKey: "synthetic-secret-key", encryptionKey: "c".repeat(64),
  } });
  const { config } = workerExecutionConfig(env), owner = workerOwner(channel);
  const identity = createHash("sha256").update(JSON.stringify(["release-worker", config.repository, channel])).digest("hex");
  const state: any = newHostedGeneration({ owner, identity });
  state.releaseRuns = [];
  let durable: any = existing ? state : undefined, revision = existing ? "1" : undefined;
  const key = `release-workers/v1/${channel}.json`;
  const registry = {
    readDocument: vi.fn(async (requestedKey: string, requestedOwner: string, project: (value: any) => any) => {
      expect(requestedKey).toBe(key); expect(requestedOwner).toBe(owner);
      return durable ? { state: project(structuredClone(durable)), etag: revision } : null;
    }),
    writeDocument: vi.fn(async (requestedKey: string, next: any, etag?: string) => {
      expect(requestedKey).toBe(key); expect(etag).toBe(revision);
      durable = structuredClone(next); revision = String(Number(revision ?? "0") + 1); return revision;
    }),
    readAdmission: vi.fn(async () => ({ state: { version: 1, owner: "account-admission", account: "d".repeat(64), reservations: [] }, etag: "1" })),
    writeAdmission: vi.fn(async (_ledger: unknown, _etag?: string): Promise<string> => { throw new Error("Unexpected admission mutation in synthetic preflight test"); }),
    close: vi.fn(),
  };
  dependencies.registry.mockReturnValue(registry);
  const preflight = vi.fn(async (scope: unknown) => {
    expect(scope).toMatchObject({ channel, sourceSha: config.sourceSha, runId: config.runId, runAttempt: config.runAttempt });
    return Response.json({ error: { code: "release_canary_unavailable", message: "Release canary designation missing for claude-setup-token" } }, { status: 409 });
  });
  const fetcher = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    if (String(url) === `${config.api}/v1/release-identity`) return Response.json({
      version: 1, ready: true, sourceSha: config.sourceSha, channel, maintenance: false,
      migrations: { state: "current", head: "0123_synthetic_expand.sql", expectedHead: "0123_synthetic_expand.sql", manifestSha256: "e".repeat(64) },
      cloud: { enabled: false, ready: true, state: "disabled" }, worker: null, workerQualified: false,
    });
    if (String(url) === `${config.api}/internal/v1/release-canaries/preflight`) {
      expect(init.method).toBe("POST"); return preflight(JSON.parse(String(init.body)));
    }
    throw new Error("Unexpected provider request in synthetic preflight test");
  });
  vi.stubGlobal("fetch", fetcher);
  const run = { runId: "122", sourceSha: config.sourceSha, inputsSha256: "f".repeat(64), actorUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID,
    qualificationProfile: "full", operationId: "77777777-7777-4777-8777-777777777777", releaseCanaryBindings: workerConnections(), canaries: [] as any[] };
  return { env, state, run, registry, preflight, fetcher, saved: () => durable,
    execute: () => executeWorkerPromotion(env, "f".repeat(64), "full") };
}

describe("worker runner first-generation recovery ordering", () => {
  it.each(["alpha", "beta", "production"] as const)("reaches the real broker preflight from a canonical fresh %s receipt", async channel => {
    const test = fixture(channel);
    expect(test.state.resources).toEqual({}); expect(test.state.releaseRuns).toEqual([]);
    await expect(test.execute()).rejects.toThrow("Release canary designation missing for claude-setup-token");
    expect(test.preflight).toHaveBeenCalledOnce();
    expect(dependencies.requiredChecks).toHaveBeenCalledTimes(2); expect(dependencies.current).toHaveBeenCalledTimes(2);
    expect(test.saved().resources.images).toEqual([]); expect(test.saved().releaseRuns).toEqual([]);
    expect(test.saved().owner).toBe(test.state.owner); expect(test.saved().generation).toBe(test.state.generation);
    expect(test.saved()).not.toHaveProperty("lease"); expect(test.registry.close).toHaveBeenCalledOnce();
    expect(test.registry.writeAdmission).not.toHaveBeenCalled(); expect(test.fetcher).toHaveBeenCalledTimes(3);
  });
  it("also initializes the generation created by the real lease when no registry document exists", async () => {
    const test = fixture("production", false);
    await expect(test.execute()).rejects.toThrow("Release canary designation missing for claude-setup-token");
    expect(test.preflight).toHaveBeenCalledOnce();
    expect(test.saved().resources.images).toEqual([]); expect(test.saved().releaseRuns).toEqual([]);
    expect(test.saved().owner).toBe(test.state.owner); expect(test.saved().identity).toBe(test.state.identity);
    expect(test.saved()).not.toHaveProperty("lease"); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
  });
  it.each([
    ["null images", (state: any) => { state.resources.images = null; }],
    ["object images", (state: any) => { state.resources.images = {}; }],
    ["string images", (state: any) => { state.resources.images = "invalid"; }],
    ["null release history", (state: any) => { state.releaseRuns = null; state.resources.images = []; }],
    ["object release history", (state: any) => { state.releaseRuns = {}; }],
    ["array resource container", (state: any) => { state.resources = []; }],
    ["ready receipt missing images", (state: any) => { state.status = "ready"; }],
    ["populated resource container without images", (state: any) => { state.resources.railway = { id: "synthetic-service" }; }],
    ["missing release history with retained images", (state: any) => { delete state.releaseRuns; state.resources.images = [{ snapshotId: "synthetic-old-image" }]; }],
  ] as const)("does not repair %s or reach preflight", async (_label, change) => {
    const test = fixture(); change(test.state);
    const resources = structuredClone(test.state.resources), history = structuredClone(test.state.releaseRuns);
    await expect(test.execute()).rejects.toThrow();
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
    expect(test.saved().resources).toEqual(resources); expect(test.saved().releaseRuns).toEqual(history);
  });
  it("does not invent an image inventory for a populated historical run even when it has no canaries", async () => {
    const test = fixture(); test.state.releaseRuns.push(test.run);
    await expect(test.execute()).rejects.toThrow("historical ownership is unconfirmed");
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.saved().resources).toEqual({});
    expect(test.saved().releaseRuns).toEqual([test.run]); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
  });
  it("keeps a historical starting job with a missing allocation row fenced", async () => {
    const test = fixture(); test.state.resources.images = [];
    test.run.canaries.push({ ...workerConnections()[0], id: "88888888-8888-4888-8888-888888888888", startedAt: Date.now(),
      phase: "starting", qualificationProfile: "full", image: { snapshotId: "synthetic-image", sourceCommit: test.run.sourceSha, buildSha256: "b".repeat(64) } });
    test.state.releaseRuns.push(test.run);
    await expect(test.execute()).rejects.toThrow("historical allocation journal is missing or ambiguous");
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.saved().resources.images).toEqual([]);
    expect(test.saved().releaseRuns).toEqual([test.run]); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
  });
  it("preserves an existing image array and valid empty-canary historical run", async () => {
    const test = fixture(), record = { purpose: "release-worker", releaseRunId: test.run.runId, sourceCommit: test.run.sourceSha, snapshotId: "synthetic-old-image" };
    test.state.resources.images = [record]; test.state.releaseRuns.push(test.run);
    await expect(test.execute()).rejects.toThrow("Release canary designation missing for claude-setup-token");
    expect(test.preflight).toHaveBeenCalledOnce(); expect(test.saved().resources.images).toEqual([record]);
    expect(test.saved().releaseRuns).toEqual([test.run]); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
  });
  it("refuses a different authenticated owner before any recovery or broker preflight", async () => {
    const test = fixture(); test.state.owner = workerOwner("beta");
    await expect(test.execute()).rejects.toThrow("ownership receipt");
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.registry.writeDocument).not.toHaveBeenCalled();
    expect(test.registry.writeAdmission).not.toHaveBeenCalled();
  });
});

describe("reconciliation-only worker runner", () => {
  it.each(["promotion", "reconciliation"])("bounds %s history under the real lease before any fresh canary", async mode => {
    const test = fixture("alpha"), now = Date.now(), at = (age: number) => new Date(now - age).toISOString();
    const profile = JSON.parse(test.env.WORKER_ADMISSION_CONFIG_JSON).profile;
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const account = hash([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId,
      profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId]);
    test.registry.readAdmission.mockImplementation(async () => ({ state: { version: 1, owner: "account-admission", account, reservations: [] }, etag: "1" }));
    test.registry.writeAdmission.mockImplementation(async (ledger, etag) => {
      expect(ledger).toEqual({ version: 1, owner: "account-admission", account, reservations: [] });
      expect(etag).toBe("1"); return "2";
    });
    const rows = [0, 1].map(index => {
      const id = `88888888-8888-4888-8888-${String(index + 1).padStart(12, "0")}`, targetId = `bx_history${index}`;
      const operationId = `bdop_${index.toString(16).padStart(32, "0")}`;
      const image = { snapshotId: "synthetic-image", sourceCommit: test.run.sourceSha, buildSha256: "b".repeat(64) };
      const intent = { key: id, at: now - 40_000, body: { from: image.snapshotId, snapshots: false, noEnv: true, env: {} } };
      const snapshotsOff = { version: 1, targetId, snapshots: false, observedAt: at(30_000) };
      test.run.canaries.push({ ...workerConnections()[index], id, startedAt: now - 50_000, image,
        phase: "completed", qualificationProfile: "full", retired: true,
        auditRetired: { version: 2, operationId: id, deletionOperationId: operationId, storagePending: true } });
      return { purpose: "native-agent-qualification", agentQualificationId: id, sourceCommit: image.sourceCommit, sourceImage: image.snapshotId,
        nativeDispatchStarted: true, builderIntent: intent, snapshotPolicyVersion: 1, snapshotPolicyObserved: snapshotsOff, retired: true, deleted: false,
        builder: { id: targetId, deleteRequested: true, deleted: false, retiredAt: at(5000), deletionOperationId: operationId,
          storageRetirement: { version: 1, kind: "storage-pending", operationId: id, targetId, snapshotId: image.snapshotId,
            sourceCommit: image.sourceCommit, buildSha256: image.buildSha256, creationIntentSha256: hash(intent),
            accountBinding: account, billingOrg: profile.boat.billingOrg, snapshotsOff,
            operation: { id: operationId, kind: "sandbox", targetId, status: "blocked", stage: "waiting_for_restore", requestedAt: at(20_000), expectedBy: null },
            operationObservedAt: at(10_000), unavailableObservedAt: at(9000) } } };
    });
    test.state.resources.images = rows; test.state.releaseRuns.push(test.run);
    const original = test.fetcher.getMockImplementation()!, observations: string[] = [];
    test.fetcher.mockImplementation(async (url, init = {}) => {
      const route = new URL(String(url)).pathname;
      if (route.startsWith("/api/v1/")) {
        expect(init.method).toBe("GET"); observations.push(route);
        if (route.endsWith(`/deletion-operations/${rows[0].builder.deletionOperationId}`)) return Response.json({ operation: {
          ...rows[0].builder.storageRetirement.operation, status: "processing", stage: "removing" } });
        if (route.endsWith(`/sandboxes/${rows[0].builder.id}`)) return Response.json({}, { status: 404 });
        throw new Error("An unselected historical canary was observed");
      }
      if (route.endsWith("/release-canaries/retirements")) {
        expect(JSON.parse(String(init.body))).toMatchObject({ operationId: test.run.canaries[0].id,
          deletionOperationId: rows[0].builder.deletionOperationId });
        return Response.json({ retired: true, storagePending: true });
      }
      return original(url, init);
    });
    if (mode === "promotion") {
      await expect(test.execute()).rejects.toThrow("Release canary designation missing for claude-setup-token");
      expect(test.preflight).toHaveBeenCalledOnce();
    } else await expect(reconcileWorkerNativeStorage(test.env)).resolves.toBe(1);
    expect(observations).toHaveLength(2);
    expect(test.saved().resources.images[0].builder.lastReconcileAt).toEqual(expect.any(String));
    expect(test.saved().resources.images[1]).toEqual(rows[1]);
    expect(test.saved().releaseRuns).toEqual([test.run]); expect(test.saved()).not.toHaveProperty("lease");
    expect(test.registry.writeAdmission).toHaveBeenCalledOnce();
  });
  it("does not create a registry generation when the exact release receipt is absent", async () => {
    const test = fixture("alpha", false);
    await expect(reconcileWorkerNativeStorage(test.env)).resolves.toBe(0);
    expect(test.saved()).toBeUndefined(); expect(test.registry.writeDocument).not.toHaveBeenCalled();
    expect(test.registry.writeAdmission).not.toHaveBeenCalled(); expect(test.preflight).not.toHaveBeenCalled();
    expect(test.fetcher).toHaveBeenCalledOnce(); expect(test.registry.close).toHaveBeenCalledOnce();
  });
  it("observes existing empty history under its real lease without preflight, admission changes or qualification", async () => {
    const test = fixture("alpha"); test.state.resources.images = [];
    await expect(reconcileWorkerNativeStorage(test.env)).resolves.toBe(0);
    expect(dependencies.requiredChecks).toHaveBeenCalledTimes(2); expect(dependencies.current).toHaveBeenCalledTimes(2);
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
    expect(test.fetcher).toHaveBeenCalledTimes(2); expect(test.saved().releaseRuns).toEqual([]);
    expect(test.saved().resources.images).toEqual([]); expect(test.saved()).not.toHaveProperty("lease");
    expect(test.saved().generation).toBe(test.state.generation);
  });
  it("keeps a missing starting allocation fenced without creating or executing work", async () => {
    const test = fixture("alpha"); test.state.resources.images = [];
    test.run.canaries.push({ ...workerConnections()[0], id: "88888888-8888-4888-8888-888888888888", startedAt: Date.now(),
      phase: "starting", qualificationProfile: "full", image: { snapshotId: "synthetic-image", sourceCommit: test.run.sourceSha, buildSha256: "b".repeat(64) } });
    test.state.releaseRuns.push(test.run);
    await expect(reconcileWorkerNativeStorage(test.env)).rejects.toThrow("historical allocation journal is missing or ambiguous");
    expect(test.preflight).not.toHaveBeenCalled(); expect(test.registry.writeAdmission).not.toHaveBeenCalled();
    expect(test.saved().releaseRuns).toEqual([test.run]); expect(test.saved().resources.images).toEqual([]);
  });
});
