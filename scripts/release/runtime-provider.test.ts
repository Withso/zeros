import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runtimeReleaseIdentity } from "../../apps/control-plane/src/cloud/runtime-release";
import { runtimeProvider } from "./runtime-provider";
import { releaseRuntime, type RuntimeReleaseDependencies } from "./runtime-release";
import type { RuntimeReleaseConfig } from "./runtime-contracts";
import type { RuntimeProviderIntent } from "./runtime-journal";

function databaseRoute(username: string, password = "synthetic") {
  const url = new URL("postgresql://region.pg.psdb.cloud:5432/postgres?sslmode=verify-full");
  url.username = username; url.password = password;
  return url.toString();
}

function fixture(channel: "alpha" | "beta" = "alpha") {
  const config: RuntimeReleaseConfig = { channel, action: channel === "alpha" ? "publish" : "promote", repository: "example/project", workflowSha: "1".repeat(40), branch: channel === "alpha" ? "main" : "release/1.2.3",
    runId: "123", runAttempt: 1, ...(channel === "alpha" ? { sourceSha: "2".repeat(40) } : { runtimeSha256: "b".repeat(64), alphaRunId: "100", alphaRunAttempt: 1 }), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const env = { RAILWAY_PROJECT_ID: randomUUID(), RAILWAY_ENVIRONMENT_ID: randomUUID(), RAILWAY_SERVICE_ID: randomUUID(), RAILWAY_DEPLOY_TOKEN: "synthetic-private-token" };
  const target = { projectId: env.RAILWAY_PROJECT_ID, environmentId: env.RAILWAY_ENVIRONMENT_ID, serviceId: env.RAILWAY_SERVICE_ID };
  const storage = { endpoint: "https://store.example.test", bucket: "runtime-fixture", accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" };
  const release = { version: 1 as const, sha256: "b".repeat(64), sourceSha: "2".repeat(40), sourceSha256: "c".repeat(64),
    qualification: { channel: "alpha" as const, runId: config.runId, runAttempt: 1, completedAt: new Date().toISOString(), receiptSha256: "d".repeat(64), deleted: true as const } };
  const pin = { sha256: release.sha256, release }, previous = { sha256: config.expectedRuntimeSha256, release: null };
  const variables: Record<string, string> = { CLOUD_V2_RUNTIME_SHA256: previous.sha256,
    CLOUD_V2_RUNTIME_STORE_ENDPOINT: storage.endpoint, CLOUD_V2_RUNTIME_STORE_BUCKET: storage.bucket,
    CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: storage.accessKeyId, CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: storage.secretAccessKey };
  const state = { serviceInstanceAutoDeployStatus: { enabled: false },
    environment: { id: target.environmentId, name: config.channel, projectId: target.projectId, unmergedChangesCount: null,
      config: { services: { [target.serviceId]: { source: { repo: config.repository, branch: config.branch, rootDirectory: "apps/control-plane", checkSuites: false } } } } },
    serviceInstance: { serviceId: target.serviceId, environmentId: target.environmentId, domains: { customDomains: [{ domain: `api-${channel}.zeros.build` }] } },
    environmentStagedChanges: { id: "<empty>", patch: {} }, variables };
  const identity = { version: 1, channel: config.channel, sourceSha: config.expectedCpSha, ready: true, maintenance: false,
    migrations: { state: "current", head: "0221_fixture.sql", expectedHead: "0221_fixture.sql", manifestSha256: "e".repeat(64) },
    cloud: { enabled: true, ready: true, state: "healthy" }, ...runtimeReleaseIdentity({ sha256: previous.sha256 }), runtimeCanaryAdmission: 1, runtimeBuildDrainVersion: 1 };
  const deployed = (id: string, status = "SUCCESS") => ({ id, status, ...target, meta: { commitHash: config.expectedCpSha, branch: config.branch } });
  const deployments = [deployed("old-deployment")], calls: Array<{ query: string; variables: any }> = [];
  const lease = { version: 1 as const, id: randomUUID(), runId: config.runId,
    liveCpSha: config.expectedCpSha, priorRuntimeSha256: config.expectedRuntimeSha256, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  const inspectDrain = vi.fn(async () => ({ version: 1 as const, lease, state: "active" as const, liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0, ready: true }));
  let loseMutation = false, deployPending = false;
  const identityStatuses: number[] = [];
  const intents: RuntimeProviderIntent[] = [];
  const record = vi.fn(async (intent: RuntimeProviderIntent) => { intents.push(structuredClone(intent)); });
  const controller = new AbortController();
  const inventoryRead = vi.fn(async () => {});
  const alphaRead = vi.fn(async () => Response.json({ version: 1, channel: "alpha", ready: true, worker: { sha256: pin.sha256 } }));
  const fetcher: typeof fetch = async (url, init) => {
    if (channel === "beta" && String(url) === "https://api-alpha.zeros.build/v1/release-identity") return alphaRead();
    if (String(url).endsWith("/v1/release-identity")) return Response.json(identity, { status: identityStatuses.shift() ?? 200 });
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (body.query.includes("RuntimeState")) return Response.json({ data: state });
    if (body.query.includes("RuntimeDeployments")) {
      await inventoryRead();
      return Response.json({ data: { deployments: { edges: deployments.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (body.query.includes("RuntimeStage")) {
      Object.assign(variables, body.variables.input.variables);
      if (loseMutation) throw new Error("synthetic-provider-secret");
      return Response.json({ data: { variableCollectionUpsert: true } });
    }
    if (body.query.includes("RuntimeRestore")) {
      Object.assign(variables, body.variables.input.variables);
      if (loseMutation) throw new Error("synthetic-provider-secret");
      return Response.json({ data: { variableCollectionUpsert: true } });
    }
    if (body.query.includes("RuntimeDeploy(")) {
      if (loseMutation) throw new Error("synthetic-provider-secret");
      if (!deployPending) deployments[0].status = "REMOVED";
      deployments.push(deployed("new-deployment", deployPending ? "BUILDING" : "SUCCESS"));
      if (!deployPending) Object.assign(identity, runtimeReleaseIdentity({ sha256: pin.sha256, release: pin.release }));
      return Response.json({ data: { serviceInstanceDeployV2: "new-deployment" } });
    }
    throw new Error("unexpected test request");
  };
  const provider = runtimeProvider(config, env, storage, { fetch: fetcher, pause: async () => {}, inspectDrain, record, signal: controller.signal });
  return { config, env, target, storage, pin, previous, variables, state, identity, deployments, calls, lease, inspectDrain, provider, identityStatuses,
    restart: () => runtimeProvider(config, env, storage, { fetch: fetcher, pause: async () => {}, inspectDrain, record,
      recovery: { stage: intents.findLast(intent => intent.kind === "stage"), deploy: intents.findLast(intent => intent.kind === "deploy") } } as never),
    intents, record, controller, inventoryRead, alphaRead, loseMutation: () => { loseMutation = true; }, pendingDeployment: () => { deployPending = true; } };
}

function transaction(f: ReturnType<typeof fixture>) {
  const deps: RuntimeReleaseDependencies = { ...f.provider, source: async () => {},
    prepare: async () => ({ version: 1, repository: f.config.repository, sha256: f.pin.sha256,
      sourceSha: f.pin.release.sourceSha, sourceSha256: f.pin.release.sourceSha256, bytes: 123 }),
    qualify: async () => f.pin.release, qualification: async () => f.pin.release, retain: async () => {},
    beginDrain: f.inspectDrain, inspectDrain: f.inspectDrain,
    endDrain: vi.fn(async () => ({ version: 1, lease: f.lease, released: true })), record: vi.fn(async () => {}) };
  return { deps, run: () => releaseRuntime(f.config, deps) };
}

describe("runtime-only Railway boundary", () => {
  it("publishes a qualified support set and preserves it through a failed publication cleanup", async () => {
    const f = fixture();
    const previous = { ...f.previous, release: { ...f.pin.release, sha256: f.previous.sha256, sourceSha: "4".repeat(40) } };
    const retained = { ...previous.release, sha256: "e".repeat(64), sourceSha: "5".repeat(40) };
    const support = { version: 1, currentSha256: previous.sha256, releases: [previous.release, retained] };
    f.variables.CLOUD_V2_RUNTIME_RELEASE_METADATA = JSON.stringify(previous.release);
    f.variables.CLOUD_V2_RUNTIME_SUPPORT = JSON.stringify(support);
    Object.assign(f.identity, runtimeReleaseIdentity(previous));
    await f.provider.stage(f.pin, previous, f.lease);
    expect(JSON.parse(f.variables.CLOUD_V2_RUNTIME_SUPPORT)).toEqual({ version: 1, currentSha256: f.pin.sha256,
      releases: [f.pin.release, previous.release] });
    expect(await f.restart().recover(f.lease)).toEqual({ releaseDrain: true });
    expect(JSON.parse(f.variables.CLOUD_V2_RUNTIME_SUPPORT)).toEqual(support);
  });
  it("does not advertise an unqualified previous runtime as supported", async () => {
    const f = fixture(); await f.provider.stage(f.pin, f.previous, f.lease);
    expect(JSON.parse(f.variables.CLOUD_V2_RUNTIME_SUPPORT)).toEqual({ version: 1, currentSha256: f.pin.sha256, releases: [f.pin.release] });
  });
  it("refuses a support-set change between staging and deploy", async () => {
    const f = fixture(); await f.provider.stage(f.pin, f.previous, f.lease);
    f.variables.CLOUD_V2_RUNTIME_SUPPORT = JSON.stringify({ version: 1, currentSha256: f.pin.sha256,
      releases: [f.pin.release, { ...f.pin.release, sha256: "e".repeat(64) }] });
    await expect(f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow(/support/);
    expect(f.calls.some(call => call.query.includes("RuntimeDeploy("))).toBe(false);
  });
  it.each(["stage", "deploy"] as const)("refuses %s when Alpha no longer serves the exact ready digest", async phase => {
    const f = fixture("beta");
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    f.alphaRead.mockResolvedValue(Response.json({ version: 1, channel: "alpha", ready: true, worker: { sha256: "f".repeat(64) } }));
    const before = f.calls.filter(call => call.query.startsWith("mutation")).length;
    await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow(/Alpha/);
    expect(f.calls.filter(call => call.query.startsWith("mutation"))).toHaveLength(before);
  });
  it.each(["stage", "deploy"] as const)("refuses %s while Alpha is unreachable", async phase => {
    const f = fixture("beta");
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    f.alphaRead.mockRejectedValue(new Error("private fixture upstream body"));
    const before = f.calls.filter(call => call.query.startsWith("mutation")).length;
    await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow(/Alpha/);
    expect(f.calls.filter(call => call.query.startsWith("mutation"))).toHaveLength(before);
  });
  it.each(["stage", "deploy"] as const)("refuses %s while Alpha is unready", async phase => {
    const f = fixture("beta");
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    f.alphaRead.mockImplementation(async () => Response.json({ version: 1, channel: "alpha", ready: false, worker: { sha256: f.pin.sha256 } }));
    const before = f.calls.filter(call => call.query.startsWith("mutation")).length;
    await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow(/Alpha/);
    expect(f.calls.filter(call => call.query.startsWith("mutation"))).toHaveLength(before);
  });
  it.each(["stage", "deploy"] as const)("refreshes serving ownership, expiry and cancellation after the final Alpha read for %s", async phase => {
    for (const change of ["unchanged", "serving", "pin", "expiry", "cancelled"]) {
      const f = fixture("beta");
      if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
      const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
      f.alphaRead.mockImplementation(async () => {
        entered.resolve(); await finish.promise;
        return Response.json({ version: 1, channel: "alpha", ready: true, worker: { sha256: f.pin.sha256 } });
      });
      const before = f.calls.filter(call => call.query.startsWith("mutation")).length;
      const running = (phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease))
        .then(() => "success", () => "refused");
      await entered.promise;
      expect(f.calls.filter(call => call.query.startsWith("mutation"))).toHaveLength(before);
      if (change === "serving") f.deployments[0].id = "replacement-deployment";
      if (change === "pin") f.variables.CLOUD_V2_RUNTIME_SHA256 = "f".repeat(64);
      if (change === "expiry") f.lease.expiresAt = new Date(Date.now() + 59_000).toISOString();
      if (change === "cancelled") f.controller.abort();
      finish.resolve();
      expect(await running).toBe(change === "unchanged" ? "success" : "refused");
      expect(f.calls.filter(call => call.query.startsWith("mutation"))).toHaveLength(before + (change === "unchanged" ? 1 : 0));
    }
  });
  it("restores its owned staged pin if Alpha stops qualifying before deploy", async () => {
    const f = fixture("beta"), t = transaction(f);
    f.alphaRead.mockImplementationOnce(async () => Response.json({ version: 1, channel: "alpha", ready: true, worker: { sha256: f.pin.sha256 } }))
      .mockRejectedValue(new Error("Alpha unavailable"));
    await expect(t.run()).rejects.toThrow(/Alpha/);
    expect(f.calls.filter(call => call.query.includes("RuntimeStage("))).toHaveLength(1);
    expect(f.calls.filter(call => call.query.includes("RuntimeDeploy("))).toHaveLength(0);
    expect(f.calls.filter(call => call.query.includes("RuntimeRestore("))).toHaveLength(1);
    expect(f.variables.CLOUD_V2_RUNTIME_SHA256).toBe(f.previous.sha256);
    expect(t.deps.endDrain).toHaveBeenCalledExactlyOnceWith(f.lease); expect(t.deps.record).not.toHaveBeenCalled();
  });
  it("restores only its persisted stage after the original process is gone", async () => {
    const f = fixture(); await f.provider.stage(f.pin, f.previous, f.lease);
    expect(await f.restart().recover(f.lease)).toEqual({ releaseDrain: true });
    expect(f.variables.CLOUD_V2_RUNTIME_SHA256).toBe(f.previous.sha256);
    expect(f.calls.filter(c => c.query.includes("RuntimeRestore("))).toHaveLength(1);
    expect(f.calls.filter(c => c.query.includes("RuntimeStage("))).toHaveLength(1);
    expect(f.calls.filter(c => c.query.includes("RuntimeDeploy("))).toHaveLength(0);
  });
  it("does not release a persisted acknowledged deployment that is still building", async () => {
    const f = fixture(); f.pendingDeployment(); await f.provider.stage(f.pin, f.previous, f.lease);
    await f.provider.deploy(f.config.expectedCpSha, f.lease);
    expect(await f.restart().recover(f.lease)).toEqual({ releaseDrain: false });
    expect(f.calls.some(c => c.query.includes("RuntimeRestore("))).toBe(false);
  });
  it.each(["readiness", "cleanup"])("refuses a foreign previous pin during %s after deployment", async phase => {
    const f = fixture(); await f.provider.stage(f.pin, f.previous, f.lease);
    const id = await f.provider.deploy(f.config.expectedCpSha, f.lease);
    f.variables.CLOUD_V2_RUNTIME_PREVIOUS_SHA256 = "f".repeat(64);
    await expect(phase === "readiness" ? f.provider.wait(id, f.pin, f.lease) : f.restart().recover(f.lease)).rejects.toThrow();
    expect(f.calls.some(call => call.query.includes("RuntimeRestore("))).toBe(false);
  });
  it("checks the live pin, stages only runtime variables, and deploys the unchanged control plane once", async () => {
    const f = fixture();
    expect(await f.provider.current()).toMatchObject({ branch: "main", current: f.previous, previous: null });
    await f.provider.stage(f.pin, f.previous, f.lease);
    expect(await f.provider.current(f.pin)).toMatchObject({ current: f.previous, previous: f.previous });
    const id = await f.provider.deploy(f.config.expectedCpSha, f.lease); await f.provider.wait(id, f.pin, f.lease);
    const stage = f.calls.find(c => c.query.includes("RuntimeStage"))!;
    expect(stage.variables.input).toEqual({ ...f.target, replace: false, skipDeploys: true, variables: {
      CLOUD_V2_RUNTIME_SHA256: f.pin.sha256, CLOUD_V2_RUNTIME_RELEASE_METADATA: JSON.stringify(f.pin.release),
      CLOUD_V2_RUNTIME_PREVIOUS_SHA256: f.previous.sha256, CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA: "",
      CLOUD_V2_RUNTIME_SUPPORT: JSON.stringify({ version: 1, currentSha256: f.pin.sha256, releases: [f.pin.release] }),
    } });
    const deployments = f.calls.filter(c => c.query.includes("RuntimeDeploy("));
    expect(deployments).toHaveLength(1); expect(deployments[0].variables.commitSha).toBe(f.config.expectedCpSha);
    expect(f.inspectDrain).toHaveBeenCalled();
    await expect(f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow();
  });

  it.each(["autodeploy", "staged", "repository", "branch", "root", "domain", "pin", "storage", "identity", "capability"])("refuses changed %s before any mutation", async change => {
    const f = fixture(), source = f.state.environment.config.services[f.target.serviceId].source;
    if (change === "autodeploy") f.state.serviceInstanceAutoDeployStatus.enabled = true;
    if (change === "staged") f.state.environmentStagedChanges.patch = { variables: {} };
    if (change === "repository") source.repo = "other/repo";
    if (change === "branch") source.branch = "other";
    if (change === "root") source.rootDirectory = "/";
    if (change === "domain") f.state.serviceInstance.domains.customDomains = [{ domain: "other.example.test" }];
    if (change === "pin") f.variables.CLOUD_V2_RUNTIME_SHA256 = "f".repeat(64);
    if (change === "storage") f.variables.CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY = "different-secret";
    if (change === "identity") f.identity.sourceSha = "f".repeat(40);
    if (change === "capability") f.identity.runtimeBuildDrainVersion = 0;
    await expect(f.provider.current()).rejects.toThrow();
    expect(f.calls.every(c => c.query.startsWith("query"))).toBe(true);
  });

  it.each(["BUILDING", "CRASHED", "SUCCESS", "unknown"])("refuses a competing or unresolved %s deployment", async status => {
    const f = fixture(); f.deployments.push({ ...f.deployments[0], id: "competing", status });
    await expect(f.provider.current()).rejects.toThrow();
    expect(f.calls.every(c => c.query.startsWith("query"))).toBe(true);
  });

  it("rechecks live identity after an approval wait and refuses staged variable interference", async () => {
    const f = fixture(); await f.provider.current(); f.identity.sourceSha = "f".repeat(40);
    await expect(f.provider.stage(f.pin, f.previous, f.lease)).rejects.toThrow();
    expect(f.calls.some(c => c.query.startsWith("mutation"))).toBe(false);
    const g = fixture(); await g.provider.stage(g.pin, g.previous, g.lease); g.variables.CLOUD_V2_RUNTIME_PREVIOUS_SHA256 = "f".repeat(64);
    await expect(g.provider.current(g.pin)).rejects.toThrow();
  });

  it("never retries or reflects an uncertain stage or deploy response", async () => {
    const f = fixture(); f.loseMutation();
    await expect(f.provider.stage(f.pin, f.previous, f.lease)).rejects.toThrow(/withheld/);
    await expect(f.provider.stage(f.pin, f.previous, f.lease)).rejects.toThrow();
    expect(f.calls.filter(c => c.query.includes("RuntimeStage"))).toHaveLength(1);
    const g = fixture(); await g.provider.stage(g.pin, g.previous, g.lease); g.loseMutation();
    await expect(g.provider.deploy(g.config.expectedCpSha, g.lease)).rejects.toThrow(/withheld/);
    await expect(g.provider.deploy(g.config.expectedCpSha, g.lease)).rejects.toThrow();
    expect(g.calls.filter(c => c.query.includes("RuntimeDeploy("))).toHaveLength(1);
  });

  it.each(["stage", "deploy"] as const)("rechecks the lease immediately before the %s mutation", async phase => {
    const f = fixture();
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    f.inspectDrain.mockResolvedValue({ version: 1, lease: f.lease, state: "active", liveCount: 1, unresolvedCount: 0, runtimeAdoptionCount: 0, ready: false });
    const before = f.calls.filter(c => c.query.startsWith("mutation")).length;
    await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow(/drain/);
    expect(f.calls.filter(c => c.query.startsWith("mutation"))).toHaveLength(before);
  });

  it("requires an empty current drain throughout deployed readiness", async () => {
    const f = fixture(); await f.provider.stage(f.pin, f.previous, f.lease); const id = await f.provider.deploy(f.config.expectedCpSha, f.lease);
    f.inspectDrain.mockResolvedValue({ version: 1, lease: f.lease, state: "active", liveCount: 0, unresolvedCount: 1, runtimeAdoptionCount: 0, ready: false });
    await expect(f.provider.wait(id, f.pin, f.lease)).rejects.toThrow(/drain/);
  });

  it("rejects a deployment whose runtime or exact source proof differs", async () => {
    const f = fixture(); await f.provider.stage(f.pin, f.previous, f.lease); const id = await f.provider.deploy(f.config.expectedCpSha, f.lease);
    f.deployments[1].meta.commitHash = "f".repeat(40);
    await expect(f.provider.wait(id, f.pin, f.lease)).rejects.toThrow();
  });

  it("waits through transient deployed readiness without repeating the deploy", async () => {
    const f = fixture(); await f.provider.stage(f.pin, f.previous, f.lease);
    const id = await f.provider.deploy(f.config.expectedCpSha, f.lease);
    f.identityStatuses.push(503, 503, 503, 503);
    await f.provider.wait(id, f.pin, f.lease);
    expect(f.identityStatuses).toEqual([]);
    expect(f.calls.filter(c => c.query.includes("RuntimeDeploy("))).toHaveLength(1);
  });

  it("checks the migration login against the exact configured runtime database route", async () => {
    const f = fixture();
    f.variables.DATABASE_URL = databaseRoute("runtime.branchone");
    await expect(f.provider.verifyDatabaseRoute(databaseRoute("owner.branchone"))).resolves.toBeUndefined();
    expect(f.calls.every(c => c.query.startsWith("query"))).toBe(true);
  });

  it.each(["branch", "host", "database", "missing", "tls"])("refuses a foreign or invalid %s database route without exposing a login", async change => {
    const f = fixture();
    f.variables.DATABASE_URL = databaseRoute("runtime.branchone");
    let url = databaseRoute("owner.branchone", "synthetic-route-secret");
    if (change === "branch") url = url.replace("branchone", "branchtwo");
    if (change === "host") url = url.replace("region.pg", "different.pg");
    if (change === "database") url = url.replace("/postgres?", "/other?");
    if (change === "missing") delete f.variables.DATABASE_URL;
    if (change === "tls") url = url.replace("verify-full", "disable");
    await expect(f.provider.verifyDatabaseRoute(url)).rejects.toThrow("Runtime database route differs from the serving channel; details withheld");
    expect(f.calls.every(c => c.query.startsWith("query"))).toBe(true);
  });

  it.each(["stage", "deploy"] as const)("refuses a %s mutation when its durable intent cannot be written", async phase => {
    const f = fixture();
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    f.record.mockRejectedValueOnce(new Error("synthetic-intent-write-failure"));
    const before = f.calls.filter(c => c.query.startsWith("mutation")).length;
    await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow();
    expect(f.calls.filter(c => c.query.startsWith("mutation"))).toHaveLength(before);
  });

  it.each(["stage", "deploy"] as const)("rechecks the live source after the %s intent persistence wait", async phase => {
    const f = fixture();
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    f.record.mockImplementationOnce(async () => { f.identity.sourceSha = "9".repeat(40); });
    const before = f.calls.filter(c => c.query.startsWith("mutation")).length;
    await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow();
    expect(f.calls.filter(c => c.query.startsWith("mutation"))).toHaveLength(before);
  });

  it("keeps the exact requested intent when a provider response is lost", async () => {
    const f = fixture(); f.loseMutation();
    await expect(f.provider.stage(f.pin, f.previous, f.lease)).rejects.toThrow();
    expect(f.intents).toEqual([{ kind: "stage", phase: "requested", previous: f.previous, retainedPrevious: null, next: f.pin, lease: f.lease, servingDeploymentId: "old-deployment",
      support: { previous: null, next: { version: 1, currentSha256: f.pin.sha256, releases: [f.pin.release] } } }]);
    expect(JSON.stringify(f.intents)).not.toContain(f.storage.secretAccessKey);
    expect(JSON.stringify(f.intents)).not.toContain(f.env.RAILWAY_DEPLOY_TOKEN);
  });
  it.each(["stage", "deploy"] as const)("honors cancellation delivered during the final %s drain read", async phase => {
    const f = fixture();
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    f.inspectDrain.mockImplementationOnce(async () => { f.controller.abort(); return { version: 1, lease: f.lease, state: "active", liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0, ready: true }; });
    const before = f.calls.filter(c => c.query.startsWith("mutation")).length;
    await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease)).rejects.toThrow(/cancelled/);
    expect(f.calls.filter(c => c.query.startsWith("mutation"))).toHaveLength(before);
  });
  it("refuses a previous-pin change while the release is preparing its target", async () => {
    const f = fixture(); await f.provider.current();
    f.variables.CLOUD_V2_RUNTIME_PREVIOUS_SHA256 = "f".repeat(64);
    f.variables.CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA = "";
    await expect(f.provider.current()).rejects.toThrow(/previous pin changed/);
    expect(f.calls.every(c => c.query.startsWith("query"))).toBe(true);
  });
  it("refuses staging with only 65 seconds left before changing any runtime variable", async () => {
    const f = fixture(); f.lease.expiresAt = new Date(Date.now() + 65_000).toISOString();
    await expect(f.provider.stage(f.pin, f.previous, f.lease)).rejects.toThrow(/budget|drain/);
    expect(f.calls.some(c => c.query.startsWith("mutation"))).toBe(false);
  });
  it("restores its staged variables before releasing a lease that cannot admit deployment", async () => {
    const f = fixture(), tx = transaction(f), initial = structuredClone(f.variables), now = Date.now;
    let elapsed = false;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed ? Date.parse(f.lease.expiresAt) - 60_000 : now());
    f.record.mockImplementation(async intent => { f.intents.push(intent); if (intent.kind === "stage" && intent.phase === "confirmed") elapsed = true; });
    try {
      await expect(tx.run()).rejects.toThrow();
      expect(f.variables.CLOUD_V2_RUNTIME_SHA256).toBe(initial.CLOUD_V2_RUNTIME_SHA256);
      expect(f.variables.CLOUD_V2_RUNTIME_RELEASE_METADATA || "").toBe(initial.CLOUD_V2_RUNTIME_RELEASE_METADATA || "");
      expect(f.variables.CLOUD_V2_RUNTIME_PREVIOUS_SHA256 || "").toBe(initial.CLOUD_V2_RUNTIME_PREVIOUS_SHA256 || "");
      expect(f.variables.CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA || "").toBe(initial.CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA || "");
      expect(f.calls.some(c => c.query.includes("RuntimeDeploy("))).toBe(false);
      expect(tx.deps.endDrain).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });
  it("does not release a drain while its acknowledged deployment is still pending", async () => {
    const f = fixture(), tx = transaction(f); f.pendingDeployment();
    await expect(tx.run()).rejects.toThrow();
    expect(f.calls.filter(c => c.query.includes("RuntimeDeploy("))).toHaveLength(1);
    expect(tx.deps.endDrain).not.toHaveBeenCalled(); expect(tx.deps.record).not.toHaveBeenCalled();
  });
  it.each([
    ["stage", "expiry"], ["stage", "cancellation"], ["deploy", "expiry"], ["deploy", "cancellation"],
  ] as const)("retains the %s %s fence after the final serving-identity read", async (phase, event) => {
    const f = fixture();
    if (phase === "deploy") await f.provider.stage(f.pin, f.previous, f.lease);
    else await f.provider.current();
    const before = f.calls.filter(c => c.query.startsWith("mutation")).length, now = Date.now;
    let elapsed = false;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed ? Date.parse(f.lease.expiresAt) - 60_000 : now());
    let reads = 0;
    f.inventoryRead.mockImplementation(async () => {
      if (++reads < (phase === "stage" ? 2 : 1)) return;
      if (event === "expiry") elapsed = true;
      else f.controller.abort();
    });
    try {
      await expect(phase === "stage" ? f.provider.stage(f.pin, f.previous, f.lease) : f.provider.deploy(f.config.expectedCpSha, f.lease))
        .rejects.toThrow(event === "expiry" ? /drain/ : /cancelled/);
      expect(f.calls.filter(c => c.query.startsWith("mutation"))).toHaveLength(before);
    } finally { clock.mockRestore(); }
  });
});
