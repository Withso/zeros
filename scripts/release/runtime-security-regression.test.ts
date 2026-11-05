import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationPool } from "../../apps/control-plane/src/db";
import { resetMigratedTestDatabase } from "../../apps/control-plane/src/test-database";
import { qualifiedRuntime, verifyRuntimeQualification } from "./runtime-proof";
import { releaseRuntime, type RuntimeReleaseDependencies } from "./runtime-release";
import { runtimeDrain } from "./runtime-drain";
import type { RuntimeReleaseConfig, RuntimeLiveState } from "./runtime-contracts";

function proofFixture() {
  const config = { channel: "alpha" as const, action: "publish" as const, repository: "example/project", workflowSha: "1".repeat(40), branch: "main",
    runId: "123", runAttempt: 2, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const manifest = { version: 1 as const, repository: config.repository, sha256: "b".repeat(64), sourceSha: config.sourceSha, sourceSha256: "c".repeat(64), bytes: 123 };
  const now = Math.floor(Date.now() / 1000), workspaceId = randomUUID();
  const claims = { version: 1 as const, iss: "zeros-runtime-release" as const, aud: "zeros-cloud-runtime-canary" as const, channel: "alpha" as const,
    jti: randomUUID(), iat: now, exp: now + 900, runId: config.runId, runAttempt: config.runAttempt,
    runtimeSha256: manifest.sha256, sourceSha: manifest.sourceSha, creatorUserId: randomUUID(), organizationId: randomUUID(), repositoryId: "42", createKey: randomUUID() };
  const canary = { token: "synthetic-grant", claims };
  const receipt = { version: 1 as const, channel: "alpha" as const, cpSourceSha: config.expectedCpSha, previousRuntimeSha256: config.expectedRuntimeSha256,
    runtimeSha256: manifest.sha256, sourceSha: manifest.sourceSha, runId: config.runId, runAttempt: config.runAttempt,
    grantId: claims.jti, workspaceId, creatorUserId: claims.creatorUserId, organizationId: claims.organizationId, repositoryId: claims.repositoryId,
    agents: ["codex", "claude", "cursor"] as const, deleted: true as const, completedAt: new Date().toISOString() };
  const cleanup = { deleted: true as const, workspaceId }, record = qualifiedRuntime(config, manifest, canary, receipt, cleanup);
  const run = { id: 123, run_attempt: 2, head_sha: config.workflowSha, head_branch: "main", path: ".github/workflows/runtime-release.yml",
    event: "workflow_dispatch", status: "completed", conclusion: "success", repository: { full_name: config.repository }, head_repository: { full_name: config.repository } };
  const jobs = { total_count: 1, jobs: [{ run_id: 123, run_attempt: 2, head_sha: config.workflowSha, name: "Runtime release transaction", status: "completed", conclusion: "success",
    steps: [{ name: "Qualify and pin runtime", conclusion: "success" }, { name: "Save runtime receipt", conclusion: "success" }] }] };
  const deps = { read: vi.fn(async path => path.includes("/jobs?") ? jobs : run), artifact: vi.fn(async () => record), sameControlPlane: vi.fn(async () => true),
    mainSource: vi.fn(async () => {}), buildArtifact: vi.fn(async () => ({ version: 1, repository: config.repository, workflowSha: config.workflowSha, runId: config.runId, runAttempt: config.runAttempt, manifest })) };
  return { config, manifest, canary, receipt, cleanup, record, run, jobs, deps };
}

function releaseFixture(action: "publish" | "promote" | "rollback" = "publish") {
  const config: RuntimeReleaseConfig = { channel: action === "promote" ? "beta" : "alpha", action, repository: "example/project",
    branch: action === "promote" ? "release/1.2.3" : "main", workflowSha: "1".repeat(40), runId: "123", runAttempt: 1,
    expectedCpSha: "2".repeat(40), expectedRuntimeSha256: "a".repeat(64),
    ...(action === "publish" ? { sourceSha: "3".repeat(40) } : action === "promote" ? { runtimeSha256: "b".repeat(64), alphaRunId: "100", alphaRunAttempt: 1 } : {}) };
  const release = { version: 1 as const, sha256: "b".repeat(64), sourceSha: "3".repeat(40), sourceSha256: "c".repeat(64),
    qualification: { channel: "alpha" as const, runId: action === "promote" ? "100" : "123", runAttempt: 1, completedAt: "2026-11-01T00:00:00.000Z", receiptSha256: "d".repeat(64), deleted: true as const } };
  const live: RuntimeLiveState = { branch: config.branch, current: { sha256: config.expectedRuntimeSha256, release: null },
    previous: { sha256: release.sha256, release },
    identity: { version: 1, channel: config.channel, sourceSha: config.expectedCpSha, ready: true, maintenance: false,
      migrations: { state: "current", head: "0221_fixture.sql", expectedHead: "0221_fixture.sql", manifestSha256: "e".repeat(64) },
      cloud: { enabled: true, ready: true, state: "healthy" }, worker: { sha256: config.expectedRuntimeSha256 }, workerQualified: false, runtimeCanaryAdmission: 1, runtimeBuildDrainVersion: 1 } };
  const manifest = { version: 1 as const, repository: config.repository, sha256: release.sha256, sourceSha: release.sourceSha, sourceSha256: release.sourceSha256, bytes: 123 };
  const lease = { version: 1 as const, id: randomUUID(), runId: config.runId,
    liveCpSha: config.expectedCpSha, priorRuntimeSha256: config.expectedRuntimeSha256, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  const status = { version: 1 as const, lease, state: "active" as const, liveCount: 0, unresolvedCount: 0, runtimeAdoptionCount: 0, ready: true };
  const events: string[] = [];
  const record = <T>(name: string, value: T) => vi.fn(async () => { events.push(name); return value; });
  const deps: RuntimeReleaseDependencies = {
    current: record("current", live), source: record("source", undefined),
    prepare: record("prepare", manifest), qualify: record("qualify_deleted", release),
    qualification: record("qualification", release), retain: record("retain", undefined),
    beginDrain: record("begin", status), inspectDrain: record("inspect", status),
    endDrain: record("end", { version: 1, lease, released: true }), pause: record("pause", undefined),
    stage: record("stage", undefined), deploy: record("deploy", "deployment-fixture"),
    wait: record("wait", undefined), recover: record("recover", { releaseDrain: true }), record: record("record", undefined),
  };
  return { config, release, live, manifest, lease, status, events, deps, run: () => releaseRuntime(config, deps) };
}

afterEach(() => { vi.restoreAllMocks(); });

it("S1 refuses promotion from a successful Alpha rollback whose archive-build job was skipped", async () => {
  const f = proofFixture();
  const rollback = qualifiedRuntime({ ...f.config, action: "rollback", sourceSha: undefined }, f.manifest, f.canary, f.receipt, f.cleanup);
  f.deps.artifact.mockResolvedValue(rollback);
  f.jobs.jobs.push({ run_id: 123, run_attempt: 2, head_sha: f.config.workflowSha, name: "Runtime archive build", status: "completed", conclusion: "skipped", steps: [] });
  f.jobs.total_count++;
  await expect(verifyRuntimeQualification({ ...f.config, channel: "production", action: "promote", branch: "release/1.2.3" }, f.manifest, rollback, f.deps)).rejects.toThrow();
});

it("S1 control keeps the channel's already-pinned rollback proof when workflow artifacts have expired", async () => {
  const f = proofFixture();
  f.deps.read.mockRejectedValue(new Error("expired"));
  f.deps.artifact.mockRejectedValue(new Error("expired"));
  await expect(verifyRuntimeQualification({ ...f.config, channel: "production", action: "rollback", branch: "release/1.2.3" }, f.manifest, f.record, f.deps, f.record.release)).resolves.toEqual(f.record);
});

it("S2 refuses staging when only 65 seconds remain, before a provider can leave a half-staged pin", async () => {
  const f = releaseFixture(), now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.mocked(f.deps.beginDrain).mockImplementation(async () => {
    vi.mocked(Date.now).mockReturnValue(now + 835_000);
    return f.status;
  });
  vi.mocked(f.deps.stage).mockImplementation(async () => { vi.mocked(Date.now).mockReturnValue(now + 840_000); });
  await f.run().catch(() => undefined);
  expect(f.deps.stage).not.toHaveBeenCalled();
  expect(f.deps.deploy).not.toHaveBeenCalled();
  expect(f.deps.record).not.toHaveBeenCalled();
  expect(f.deps.endDrain).toHaveBeenCalledOnce();
});

it("S2 control can stage and finish under a newly acquired empty lease", async () => {
  const f = releaseFixture();
  await expect(f.run()).resolves.toMatchObject({ status: "success" });
  expect(f.deps.stage).toHaveBeenCalledOnce();
  expect(f.deps.deploy).toHaveBeenCalledOnce();
  expect(f.deps.endDrain).toHaveBeenCalledOnce();
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("S4 lost begin acknowledgement with the real drain transaction", () => {
  let pool: ReturnType<typeof createMigrationPool>;
  beforeAll(() => { pool = createMigrationPool(process.env.TEST_DATABASE_URL!, { role: "none", maxConnections: 4 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterAll(() => pool.end());
  it.each([true, false])("retires only the same committed lease (lost=%s)", async lost => {
    const f = releaseFixture(), drain = runtimeDrain(f.config, pool);
    let initial: Awaited<ReturnType<typeof drain.beginDrain>> | undefined;
    let first = true;
    f.deps.beginDrain = vi.fn(async () => {
      const status = await drain.beginDrain();
      initial ??= status;
      Object.assign(f.lease, status.lease);
      if (first && lost) {
        first = false;
        throw Object.assign(new Error("reply unavailable after commit"), { code: "runtime_build_drain_unavailable" });
      }
      return status;
    });
    f.deps.inspectDrain = vi.fn(async lease => drain.inspectDrain(lease));
    f.deps.endDrain = vi.fn(async lease => drain.endDrain(lease));
    try {
      const result = await f.run().catch(error => error);
      const status = await drain.inspectDrain(initial!.lease);
      expect(status.state).toBe("ended");
      expect(status.lease.id).toBe(initial!.lease.id);
      if (lost) {
        expect(result).toBeInstanceOf(Error);
        expect(f.deps.beginDrain).toHaveBeenCalledTimes(2);
        expect(f.deps.stage).not.toHaveBeenCalled();
        expect(f.deps.record).not.toHaveBeenCalled();
      } else expect(result).toMatchObject({ status: "success" });
    } finally { if (initial) await drain.endDrain(initial.lease); }
  });
});
