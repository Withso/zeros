import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { qualifiedRuntime, runtimeJsonSha256, verifyRuntimeQualification } from "./runtime-proof";

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
  const cleanup = { deleted: true as const, workspaceId }, record = qualifiedRuntime(config, manifest, canary, receipt, cleanup);
  const run = { id: 123, run_attempt: 2, head_sha: config.workflowSha, head_branch: "main", path: ".github/workflows/runtime-release.yml",
    event: "workflow_dispatch", status: "completed", conclusion: "success", repository: { full_name: config.repository }, head_repository: { full_name: config.repository } };
  const jobs = { total_count: 2, jobs: [{ run_id: 123, run_attempt: 2, head_sha: config.workflowSha, name: "Runtime release transaction", status: "completed", conclusion: "success",
    steps: [{ name: "Qualify and pin runtime", conclusion: "success" }, { name: "Save runtime receipt", conclusion: "success" }] },
  { run_id: 123, run_attempt: 2, head_sha: config.workflowSha, name: "Runtime archive build", status: "completed", conclusion: "success",
    steps: [{ name: "Build exact runtime", conclusion: "success" }, { name: "Save runtime archive", conclusion: "success" }] }] };
  const build = { version: 1 as const, repository: config.repository, workflowSha: config.workflowSha, runId: "123", runAttempt: 2, manifest: structuredClone(manifest) };
  const deps = { read: vi.fn(async path => path.includes("/jobs?") ? jobs : run), artifact: vi.fn(async () => record),
    buildArtifact: vi.fn(async () => build), mainSource: vi.fn(async (_sha: string) => {}), sameControlPlane: vi.fn(async () => true) };
  return { config, manifest, canary, receipt, cleanup, record, run, jobs, build, deps };
}

describe("immutable runtime qualification provenance", () => {
  it("binds exact receipt bytes and retrieves the recorded workflow attempt's own artifact", async () => {
    const f = fixture(); expect(f.record.release.qualification.receiptSha256).toBe(runtimeJsonSha256(f.receipt));
    expect(await verifyRuntimeQualification(f.config, f.manifest, f.record, f.deps)).toEqual(f.record);
    expect(f.deps.read.mock.calls.map(([p]) => p)).toEqual(["/actions/runs/123/attempts/2", "/actions/runs/123/attempts/2/jobs?per_page=100"]);
    expect(f.deps.artifact).toHaveBeenCalledExactlyOnceWith("123", 2);
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
    await expect(verifyRuntimeQualification(f.config, f.manifest, f.record, f.deps)).rejects.toThrow(); expect(f.deps.artifact).not.toHaveBeenCalled();
  });
  it("refuses an absent producing step, substituted artifact or incompatible control plane", async () => {
    const f = fixture(); f.jobs.jobs[0].steps.pop(); await expect(verifyRuntimeQualification(f.config, f.manifest, f.record, f.deps)).rejects.toThrow();
    const a = fixture(); a.deps.artifact.mockResolvedValue({ ...a.record, workflowSha: "9".repeat(40) });
    await expect(verifyRuntimeQualification(a.config, a.manifest, a.record, a.deps)).rejects.toThrow();
    const c = fixture(); c.deps.sameControlPlane.mockResolvedValue(false); await expect(verifyRuntimeQualification(c.config, c.manifest, c.record, c.deps)).rejects.toThrow();
  });
  it.each(["rollback", "failed-build", "missing-build-step", "other-attempt", "other-digest", "other-source", "other-source-hash", "untrusted-main"])(
    "refuses promotion with %s publication provenance", async change => {
      const f = fixture(), promotion = { ...f.config, channel: "production" as const, action: "promote" as const, branch: "release/1.2.3" };
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
    expect(await verifyRuntimeQualification(config, f.manifest, f.record, f.deps, f.record.release)).toEqual(f.record);
    expect(f.deps.read).not.toHaveBeenCalled(); expect(f.deps.artifact).not.toHaveBeenCalled();
    expect(f.deps.sameControlPlane).toHaveBeenCalledExactlyOnceWith(f.receipt.cpSourceSha, config.expectedCpSha);
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
