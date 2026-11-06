import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { qualifiedRuntime, runtimeJsonSha256, verifyRuntimeQualification, prepareRuntimePublication, completeRuntimePublication } from "./runtime-proof";

function fixture() {
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
  const cleanup = { deleted: true as const, workspaceId }, legacy = qualifiedRuntime(config, manifest, canary, receipt, cleanup);
  const prepared = prepareRuntimePublication(config, manifest);
  const record = completeRuntimePublication(prepared, { version: 1, status: "success", channel: "alpha", action: "publish",
    repository: config.repository, workflowSha: config.workflowSha, runId: config.runId, runAttempt: config.runAttempt,
    cpSourceSha: config.expectedCpSha, previousRuntimeSha256: config.expectedRuntimeSha256, runtime: prepared.release,
    deploymentId: "alpha-deployment", completedAt: new Date().toISOString() });
  const promotion = { ...config, channel: "beta" as const, action: "promote" as const, branch: "release/1.2.3",
    runtimeSha256: manifest.sha256, alphaRunId: config.runId, alphaRunAttempt: config.runAttempt };
  const run = { id: 123, run_attempt: 2, head_sha: config.workflowSha, head_branch: "main", path: ".github/workflows/runtime-release.yml",
    event: "workflow_dispatch", status: "completed", conclusion: "success", repository: { full_name: config.repository }, head_repository: { full_name: config.repository } };
  const jobs = { total_count: 2, jobs: [{ run_id: 123, run_attempt: 2, head_sha: config.workflowSha, name: "Runtime release transaction", status: "completed", conclusion: "success",
    steps: [{ name: "Qualify and pin runtime", conclusion: "success" }, { name: "Save runtime receipt", conclusion: "success" }] },
  { run_id: 123, run_attempt: 2, head_sha: config.workflowSha, name: "Runtime archive build", status: "completed", conclusion: "success",
    steps: [{ name: "Build exact runtime", conclusion: "success" }, { name: "Save runtime archive", conclusion: "success" }] }] };
  const build = { version: 1 as const, repository: config.repository, workflowSha: config.workflowSha, runId: "123", runAttempt: 2, manifest: structuredClone(manifest) };
  const deps = { read: vi.fn(async path => path.includes("/jobs?") ? jobs : run), artifact: vi.fn(async () => record),
    buildArtifact: vi.fn(async () => build), mainSource: vi.fn(async (_sha: string) => {}), sameControlPlane: vi.fn(async () => true),
    alphaCurrent: vi.fn(async (_sha: string) => {}) };
  return { config, promotion, manifest, canary, receipt, cleanup, record, legacy, run, jobs, build, deps };
}

describe("immutable runtime qualification provenance", () => {
  it("refuses legacy gate0-only evidence for a new promotion even when its Alpha workflow succeeded", async () => {
    const f = fixture(), config = { ...f.config, channel: "beta" as const, action: "promote" as const,
      branch: "release/1.2.3", runtimeSha256: f.manifest.sha256, alphaRunId: "123", alphaRunAttempt: 2 };
    await expect(verifyRuntimeQualification(config, f.manifest, f.legacy, f.deps)).rejects.toThrow(/publication/);
  });
  it("binds exact receipt bytes and retrieves the recorded workflow attempt's own artifact", async () => {
    const f = fixture(); expect(f.record.release.qualification.receiptSha256).toBe(runtimeJsonSha256(f.record.intent));
    expect(await verifyRuntimeQualification(f.promotion, f.manifest, f.record, f.deps)).toEqual(f.record);
    expect(f.deps.read.mock.calls.map(([p]) => p)).toEqual(["/actions/runs/123/attempts/2", "/actions/runs/123/attempts/2/jobs?per_page=100"]);
    expect(f.deps.artifact).toHaveBeenCalledExactlyOnceWith("123", 2);
    expect(f.deps.mainSource.mock.calls).toEqual([[f.config.workflowSha], [f.manifest.sourceSha]]);
    expect(f.deps.alphaCurrent).toHaveBeenCalledExactlyOnceWith(f.manifest.sha256);
  });
  it.each([{ runId: "999" }, { deleted: false }, { workspaceId: randomUUID() }, { creatorUserId: randomUUID() },
    { runtimeSha256: "d".repeat(64) }, { cpSourceSha: "4".repeat(40) }, { agents: ["codex"] }])("refuses an unbound gate0 result (%j)", patch => {
    const f = fixture(); expect(() => qualifiedRuntime(f.config, f.manifest, f.canary, { ...f.receipt, ...patch }, f.cleanup)).toThrow();
  });
  it("cannot produce pin authority from an unused tombstone alone", () => {
    const f = fixture(); expect(() => qualifiedRuntime(f.config, f.manifest, f.canary, f.receipt, { deleted: true, workspaceId: null })).toThrow();
  });
  it.each([{ run_attempt: 3 }, { head_sha: "9".repeat(40) }, { head_branch: "other" }, { event: "pull_request" }, { conclusion: "failure" },
    { head_repository: { full_name: "foreign/fork" } }])("rejects foreign, failed or another-attempt workflow proof (%j)", async patch => {
    const f = fixture(); Object.assign(f.run, patch);
    await expect(verifyRuntimeQualification(f.promotion, f.manifest, f.record, f.deps)).rejects.toThrow(); expect(f.deps.artifact).not.toHaveBeenCalled();
  });
  it("refuses an absent producing step, substituted artifact or incompatible control plane", async () => {
    const f = fixture(); f.jobs.jobs[0].steps.pop(); await expect(verifyRuntimeQualification(f.promotion, f.manifest, f.record, f.deps)).rejects.toThrow();
    const a = fixture(); a.deps.artifact.mockResolvedValue({ ...a.record, workflowSha: "9".repeat(40) });
    await expect(verifyRuntimeQualification(a.promotion, a.manifest, a.record, a.deps)).rejects.toThrow();
    const c = fixture(); c.deps.sameControlPlane.mockResolvedValue(false); await expect(verifyRuntimeQualification(c.promotion, c.manifest, c.record, c.deps)).rejects.toThrow();
  });
  it.each(["rollback", "failed-build", "missing-build-step", "other-attempt", "other-digest", "other-source", "other-source-hash", "untrusted-main"])(
    "refuses promotion with %s publication provenance", async change => {
      const f = fixture(), promotion = { ...f.promotion, channel: "production" as const };
      if (change === "rollback") { f.jobs.jobs.pop(); f.jobs.total_count--; }
      if (change === "failed-build") f.jobs.jobs[1].conclusion = "failure";
      if (change === "missing-build-step") f.jobs.jobs[1].steps.pop();
      if (change === "other-attempt") f.build.runAttempt++;
      if (change === "other-digest") f.build.manifest.sha256 = "e".repeat(64);
      if (change === "other-source") f.build.manifest.sourceSha = "9".repeat(40);
      if (change === "other-source-hash") f.build.manifest.sourceSha256 = "e".repeat(64);
      if (change === "untrusted-main") f.deps.mainSource.mockRejectedValue(new Error("untrusted main or CI"));
      await expect(verifyRuntimeQualification(promotion, f.manifest, f.record, f.deps)).rejects.toThrow();
    });
  it("can roll back to the already pinned receipt after GitHub artifacts expire", async () => {
    const f = fixture(), config = { ...f.config, channel: "beta" as const, action: "rollback" as const, branch: "release/1.2.3" };
    f.deps.read.mockRejectedValue(new Error("expired-workflow-history")); f.deps.artifact.mockRejectedValue(new Error("expired-artifact"));
    f.deps.alphaCurrent.mockRejectedValue(new Error("Alpha unavailable"));
    expect(await verifyRuntimeQualification(config, f.manifest, f.record, f.deps, f.record.release)).toEqual(f.record);
    expect(f.deps.read).not.toHaveBeenCalled(); expect(f.deps.artifact).not.toHaveBeenCalled();
    expect(f.deps.sameControlPlane).toHaveBeenCalledExactlyOnceWith(f.receipt.cpSourceSha, config.expectedCpSha);
    expect(f.deps.alphaCurrent).not.toHaveBeenCalled();
  });
  it("retains recorded legacy previous-pin rollback without allowing a new promotion", async () => {
    const f = fixture(), config = { ...f.promotion, action: "rollback" as const };
    f.deps.read.mockRejectedValue(new Error("expired-workflow-history")); f.deps.alphaCurrent.mockRejectedValue(new Error("Alpha unavailable"));
    expect(await verifyRuntimeQualification(config, f.manifest, f.legacy, f.deps, f.legacy.release)).toEqual(f.legacy);
    expect(f.deps.read).not.toHaveBeenCalled(); expect(f.deps.alphaCurrent).not.toHaveBeenCalled();
    await expect(verifyRuntimeQualification(f.promotion, f.manifest, f.legacy, f.deps, f.legacy.release)).rejects.toThrow(/publication/);
  });
  it("rejects a rollback-produced terminal proof even if a build-job-shaped record is supplied", async () => {
    const f = fixture();
    const prepared = prepareRuntimePublication({ ...f.config, action: "rollback", sourceSha: undefined }, f.manifest);
    const rollback = completeRuntimePublication(prepared, { ...f.record.receipt, action: "rollback", runtime: prepared.release, completedAt: new Date().toISOString() });
    await expect(verifyRuntimeQualification(f.promotion, f.manifest, rollback, f.deps)).rejects.toThrow(/rollback/);
    expect(f.deps.read).not.toHaveBeenCalled();
  });
  it("checks Alpha's current pin after qualification evidence reads", async () => {
    const f = fixture(); f.deps.alphaCurrent.mockImplementation(async digest => {
      expect(digest).toBe(f.manifest.sha256); expect(f.deps.artifact).toHaveBeenCalled(); expect(f.deps.sameControlPlane).toHaveBeenCalled();
      throw new Error("Alpha unavailable or different");
    });
    await expect(verifyRuntimeQualification(f.promotion, f.manifest, f.record, f.deps)).rejects.toThrow(/Alpha/);
  });
  it.each(["receipt", "status", "digest", "source", "source-hash", "run", "attempt", "workflow", "cp", "previous", "action", "time", "intent", "requested-run"])(
    "refuses a substituted or missing %s publication binding", async change => {
      const f = fixture(), record = structuredClone(f.record), config = { ...f.promotion };
      if (change === "receipt") delete (record as { receipt?: unknown }).receipt;
      if (change === "status") (record.receipt as { status: string }).status = "failure";
      if (change === "digest") record.receipt.runtime.sha256 = "f".repeat(64);
      if (change === "source") record.receipt.runtime.sourceSha = "f".repeat(40);
      if (change === "source-hash") record.receipt.runtime.sourceSha256 = "f".repeat(64);
      if (change === "run") record.receipt.runId = "999";
      if (change === "attempt") record.receipt.runAttempt++;
      if (change === "workflow") record.receipt.workflowSha = "f".repeat(40);
      if (change === "cp") record.receipt.cpSourceSha = "f".repeat(40);
      if (change === "previous") record.receipt.previousRuntimeSha256 = "f".repeat(64);
      if (change === "action") record.receipt.action = "rollback";
      if (change === "time") record.receipt.completedAt = "2000-01-01T00:00:00.000Z";
      if (change === "intent") record.intent.previousRuntimeSha256 = "f".repeat(64);
      if (change === "requested-run") config.alphaRunId = "999";
      await expect(verifyRuntimeQualification(config, f.manifest, record, f.deps)).rejects.toThrow();
      expect(f.deps.read).not.toHaveBeenCalled();
    });
  it.each(["missing", "receipt", "digest", "cp", "promotion"])("refuses %s substitution at the pinned rollback boundary", async change => {
    const f = fixture(), config = { ...f.config, channel: "beta" as const, action: (change === "promotion" ? "promote" : "rollback") as "promote" | "rollback", branch: "release/1.2.3" };
    const pinned = structuredClone(f.record.release);
    if (change === "receipt") pinned.qualification.receiptSha256 = "f".repeat(64);
    if (change === "digest") pinned.sha256 = "f".repeat(64);
    if (change === "cp") f.deps.sameControlPlane.mockResolvedValue(false);
    f.deps.read.mockRejectedValue(new Error("expired-workflow-history"));
    await expect(verifyRuntimeQualification(config, f.manifest, f.record, f.deps, change === "missing" ? undefined : pinned)).rejects.toThrow();
  });
});
