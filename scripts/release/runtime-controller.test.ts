import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runtimeReleaseConfig } from "./runtime-contracts";
import { runRuntimeController } from "./runtime-controller";
import { prepareRuntimePublication, completeRuntimePublication } from "./runtime-proof";

function fixture(action: "publish" | "promote" | "rollback" = "publish") {
  const channel = action === "promote" ? "beta" : "alpha", branch = channel === "alpha" ? "main" : "release/1.2.3";
  const env = { RUNNER_ENVIRONMENT: "github-hosted", ZEROS_RUNTIME_RELEASE: "enabled", ZEROS_HOSTED_PROMOTION: "enabled", RUNTIME_RELEASE_CHANNEL: channel, RUNTIME_RELEASE_ACTION: action,
    ...(action === "publish" ? { RUNTIME_RELEASE_SOURCE_SHA: "2".repeat(40) } : action === "promote" ? { RUNTIME_RELEASE_SHA256: "b".repeat(64), RUNTIME_RELEASE_ALPHA_RUN_ID: "100", RUNTIME_RELEASE_ALPHA_RUN_ATTEMPT: "1" } : {}),
    RUNTIME_RELEASE_EXPECTED_CP_SHA: "3".repeat(40), RUNTIME_RELEASE_EXPECTED_SHA256: "a".repeat(64),
    GITHUB_REPOSITORY: "example/project", GITHUB_SHA: "1".repeat(40), GITHUB_WORKFLOW_SHA: "1".repeat(40), GITHUB_REF_NAME: branch, GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_WORKFLOW_REF: `example/project/.github/workflows/runtime-release.yml@refs/heads/${branch}`, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    CLOUD_V2_RUNTIME_STORE_ENDPOINT: "https://target.example.test", CLOUD_V2_RUNTIME_STORE_BUCKET: "runtime-fixture", CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: "synthetic-access", CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: "synthetic-storage-secret",
    CLOUD_RUNTIME_ALPHA_STORE_ENDPOINT: "https://alpha.example.test", CLOUD_RUNTIME_ALPHA_STORE_BUCKET: "runtime-fixture", CLOUD_RUNTIME_ALPHA_STORE_ACCESS_KEY_ID: "synthetic-read-access", CLOUD_RUNTIME_ALPHA_STORE_SECRET_ACCESS_KEY: "synthetic-read-secret",
    PLANETSCALE_ORG: "fixture", PLANETSCALE_DATABASE: `zeros-control-plane-${channel}`, PLANETSCALE_BRANCH: "main", PLANETSCALE_SERVICE_TOKEN_ID: "synthetic-token-id", PLANETSCALE_SERVICE_TOKEN: "synthetic-private-token" };
  const config = runtimeReleaseConfig(env), events: string[] = [];
  const manifest = { version: 1 as const, repository: config.repository, sourceSha: "2".repeat(40), sourceSha256: "c".repeat(64), sha256: "b".repeat(64), bytes: 123 };
  const prepared = prepareRuntimePublication({ ...config, channel: "alpha", action: "publish", branch: "main", sourceSha: manifest.sourceSha,
    runId: action === "promote" ? "100" : "123" }, manifest);
  const receipt = { version: 1 as const, status: "success" as const, channel: "alpha" as const, action: "publish" as const,
    repository: config.repository, workflowSha: config.workflowSha, cpSourceSha: config.expectedCpSha, previousRuntimeSha256: "a".repeat(64),
    runtime: prepared.release, runId: prepared.intent.runId, runAttempt: 1, deploymentId: "alpha-deployment", completedAt: new Date().toISOString() };
  const proof = completeRuntimePublication(prepared, receipt);
  const live = { branch: config.branch, current: { sha256: config.expectedRuntimeSha256, release: null }, previous: { sha256: manifest.sha256, release: proof.release },
    identity: { version: 1, channel, ready: true, sourceSha: config.expectedCpSha, maintenance: false, migrations: { state: "current", head: "0221_fixture.sql", expectedHead: "0221_fixture.sql", manifestSha256: "d".repeat(64) },
      cloud: { enabled: true, ready: true, state: "healthy" }, worker: { sha256: config.expectedRuntimeSha256 }, workerQualified: false, runtimeCanaryAdmission: 1, runtimeBuildDrainVersion: 1 } };
  const lease = { version: 1 as const, id: randomUUID(), runId: config.runId, liveCpSha: config.expectedCpSha, priorRuntimeSha256: config.expectedRuntimeSha256, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  const status = { version: 1 as const, lease, state: "active" as const, ready: true, liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0 };
  const target = { close: vi.fn(() => { events.push("store-close"); }), publish: vi.fn(async () => { events.push("publish"); return manifest; }),
    copy: vi.fn(async () => { events.push("copy"); return manifest; }), retain: vi.fn(async () => {}),
    qualification: vi.fn(async () => proof), saveQualification: vi.fn(async () => { events.push("qualification-save"); }),
    saveReceipt: vi.fn(async () => { events.push("receipt-save"); }), saveEvent: vi.fn(async () => { events.push("event-save"); }) };
  const alpha = { ...target, close: vi.fn(), qualification: vi.fn(async () => proof) };
  const provider = { current: vi.fn(async () => live), verifyDatabaseRoute: vi.fn(async () => { events.push("route"); }),
    stage: vi.fn(async () => { events.push("stage"); }), deploy: vi.fn(async () => { events.push("deploy"); return "deployment-fixture"; }),
    wait: vi.fn(async () => { events.push("ready"); }), recover: vi.fn(async () => ({ releaseDrain: true })) };
  const drain = { beginDrain: vi.fn(async () => { events.push("drain"); return status; }), inspectDrain: vi.fn(async () => status),
    endDrain: vi.fn(async () => { events.push("release"); return { version: 1, lease, released: true }; }) };
  let cleanupFails = false;
  const database = vi.fn(async (_config, _env, journal, deps, operation) => {
    events.push("database"); await deps.verifyDatabaseRoute("synthetic-private-dsn"); await deps.save(journal);
    const result = await operation({ query: "owned-pool-fixture" }); events.push("database-cleanup");
    if (cleanupFails) throw new Error("synthetic-private-cleanup-error"); return result;
  });
  const read = vi.fn(async () => ({ version: 1, repository: config.repository, workflowSha: config.workflowSha, runId: config.runId, runAttempt: 1, manifest }));
  const write = vi.fn(async () => {}), qualify = vi.fn(async () => { events.push("qualify-deleted"); return proof; });
  const github = { source: vi.fn(async () => {}), sameControlPlane: vi.fn(async () => true), artifact: vi.fn(async () => proof), alphaCurrent: vi.fn(async () => {}),
    mainSource: vi.fn(async () => {}), buildArtifact: vi.fn(async () => ({ version: 1, repository: config.repository, workflowSha: config.workflowSha,
      runId: receipt.runId, runAttempt: 1, manifest })),
    read: vi.fn(async path => path.includes("/jobs?") ? { total_count: 2, jobs: [
      { name: "Runtime archive build", steps: ["Build exact runtime", "Save runtime archive"] },
      { name: "Runtime release transaction", steps: ["Qualify and pin runtime", "Save runtime receipt"] },
    ].map(job => ({ run_id: action === "promote" ? 100 : 123, run_attempt: 1, head_sha: config.workflowSha,
      name: job.name, status: "completed", conclusion: "success", steps: job.steps.map(name => ({ name, conclusion: "success" })) })) }
      : { id: 100, run_attempt: 1, head_sha: config.workflowSha, head_branch: "main", path: ".github/workflows/runtime-release.yml", event: "workflow_dispatch", status: "completed", conclusion: "success",
        repository: { full_name: config.repository }, head_repository: { full_name: config.repository } }) };
  const services = { store: vi.fn(input => input.endpoint === "https://alpha.example.test" ? alpha : target), github: vi.fn(() => github), provider: vi.fn(() => provider),
    database, drain: vi.fn(() => drain), qualify, read, write, planetScale: vi.fn(() => {}) };
  const controller = new AbortController();
  const execute = () => runRuntimeController(env, { root: "/synthetic/controller", signal: controller.signal, services: services as never });
  return { env, config, live, events, target, alpha, provider, drain, services, github, database, read, write, qualify, controller, execute, failCleanup: () => { cleanupFails = true; } };
}

describe("runtime controller production composition", () => {
  it("publishes on Alpha without a canary grant, fixture login or canary admission configuration", async () => {
    const f = fixture();
    delete (f.live.identity as { runtimeCanaryAdmission?: number }).runtimeCanaryAdmission;
    f.qualify.mockRejectedValue(new Error("candidate canary must not execute"));
    await expect(f.execute()).resolves.toMatchObject({ status: "success", action: "publish", runtime: { sha256: "b".repeat(64) } });
    expect(f.qualify).not.toHaveBeenCalled();
    expect(f.events.indexOf("ready")).toBeLessThan(f.events.indexOf("qualification-save"));
    expect(f.events.indexOf("database-cleanup")).toBeLessThan(f.events.indexOf("qualification-save"));
  });
  it("publishes success only after confirmed drain release and database-role cleanup", async () => {
    const f = fixture(), receipt = await f.execute();
    expect(receipt.status).toBe("success"); expect(f.qualify).not.toHaveBeenCalled();
    expect(f.events.indexOf("release")).toBeLessThan(f.events.indexOf("database-cleanup"));
    expect(f.events.indexOf("database-cleanup")).toBeLessThan(f.events.indexOf("receipt-save"));
    expect(f.events.indexOf("receipt-save")).toBeLessThan(f.events.indexOf("qualification-save"));
    expect(f.target.saveQualification).toHaveBeenCalledWith(expect.objectContaining({ version: 2,
      receipt: expect.objectContaining({ status: "success", channel: "alpha", action: "publish", runtime: receipt.runtime }) }));
    expect(JSON.stringify(f.target.saveQualification.mock.calls)).not.toMatch(/grantId|workspaceId|creatorUserId|password|synthetic-private/);
    expect(f.services.drain).toHaveBeenCalledWith(f.config, { query: "owned-pool-fixture" });
    expect(f.write.mock.calls.some(([path]) => String(path).endsWith("runtime-receipt.json"))).toBe(true);
    expect(JSON.stringify(f.write.mock.calls)).not.toContain("synthetic-private-token");
  });
  it("does not grant success when temporary database cleanup is unknown", async () => {
    const f = fixture(); f.failCleanup(); await expect(f.execute()).rejects.toThrow(/withheld/);
    expect(f.target.saveReceipt).not.toHaveBeenCalled(); expect(f.target.saveQualification).not.toHaveBeenCalled(); expect(f.target.close).toHaveBeenCalledOnce();
  });
  it("checks the serving identity and producer before allocating database authority", async () => {
    const f = fixture(); f.provider.current.mockRejectedValueOnce(new Error("old-control-plane"));
    await expect(f.execute()).rejects.toThrow(); expect(f.database).not.toHaveBeenCalled();
    const g = fixture(); g.read.mockResolvedValueOnce({ invalid: true } as never);
    await expect(g.execute()).rejects.toThrow(); expect(g.database).not.toHaveBeenCalled();
  });
  it("promotes the exact retained Alpha archive without a build or canary", async () => {
    const f = fixture("promote"); await f.execute();
    expect(f.target.copy).toHaveBeenCalledWith("b".repeat(64), f.alpha);
    expect(f.target.publish).not.toHaveBeenCalled(); expect(f.qualify).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(f.alpha.qualification).toHaveBeenCalledWith("b".repeat(64), "100", 1);
    expect(f.target.saveQualification).toHaveBeenCalledOnce(); expect(f.alpha.close).toHaveBeenCalledOnce();
  });
  it("selects the recorded previous pin for Alpha rollback without producing publish provenance", async () => {
    const f = fixture("rollback"); await f.execute();
    expect(f.target.copy).toHaveBeenCalledWith("b".repeat(64), undefined); expect(f.qualify).not.toHaveBeenCalled();
    expect(f.target.saveQualification).toHaveBeenCalledWith(expect.objectContaining({ version: 2, intent: expect.objectContaining({ action: "rollback" }), receipt: expect.objectContaining({ action: "rollback" }) }));
    expect(f.target.publish).not.toHaveBeenCalled();
  });
  it("refuses an unavailable Alpha pin before allocating destination mutation authority", async () => {
    const f = fixture("promote"); f.github.alphaCurrent.mockRejectedValue(new Error("unavailable"));
    await expect(f.execute()).rejects.toThrow();
    expect(f.database).not.toHaveBeenCalled(); expect(f.target.copy).not.toHaveBeenCalled(); expect(f.provider.stage).not.toHaveBeenCalled();
  });
  it.each(["stage", "deploy", "wait"] as const)("does not retain Alpha publication qualification when %s fails", async phase => {
    const f = fixture(); f.provider[phase].mockRejectedValue(new Error("operation failed"));
    await expect(f.execute()).rejects.toThrow();
    expect(f.target.saveQualification).not.toHaveBeenCalled(); expect(f.target.saveReceipt).not.toHaveBeenCalled();
  });
  it("refuses disabled execution before initializing any external authority", async () => {
    const f = fixture(); f.env.ZEROS_RUNTIME_RELEASE = "";
    await expect(f.execute()).rejects.toThrow(/disabled/); expect(f.services.store).not.toHaveBeenCalled();
  });
  it("refuses a persistent runner before allocating any release authority", async () => {
    const f = fixture(); f.env.RUNNER_ENVIRONMENT = "self-hosted";
    await expect(f.execute()).rejects.toThrow(/GitHub-hosted/); expect(f.services.store).not.toHaveBeenCalled();
  });
  it("refuses a cancelled operation before database allocation", async () => {
    const f = fixture(); f.controller.abort(); await expect(f.execute()).rejects.toThrow(/cancelled/);
    expect(f.database).not.toHaveBeenCalled(); expect(f.target.publish).not.toHaveBeenCalled();
  });
});
