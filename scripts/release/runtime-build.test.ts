import { describe, expect, it, vi } from "vitest";
import { buildRuntime, verifyRuntimeBuild } from "./runtime-build";
import { runtimeBuildConfig, runtimeReleaseConfig } from "./runtime-contracts";

function fixture() {
  const env = { RUNTIME_RELEASE_CHANNEL: "alpha", RUNTIME_RELEASE_ACTION: "publish", RUNTIME_RELEASE_SOURCE_SHA: "2".repeat(40),
    RUNTIME_RELEASE_EXPECTED_CP_SHA: "3".repeat(40), RUNTIME_RELEASE_EXPECTED_SHA256: "a".repeat(64),
    GITHUB_REPOSITORY: "example/project", GITHUB_SHA: "1".repeat(40), GITHUB_WORKFLOW_SHA: "1".repeat(40), GITHUB_REF_NAME: "main", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "example/project/.github/workflows/runtime-release.yml@refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: "synthetic-github", RAILWAY_DEPLOY_TOKEN: "synthetic-railway", CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY: "synthetic-signing" };
  const config = runtimeBuildConfig(env), source = vi.fn(async () => {}), state = { dirty: false };
  const command = vi.fn(async (_file: string, args: string[]) => args[0] === "status" ? state.dirty ? " M file.ts\n" : "" : config.sourceSha!);
  const identity = vi.fn(async () => ({ commit: config.sourceSha!, sourceSha256: "c".repeat(64), dirty: false }));
  const build = vi.fn(async (input: any) => {
    expect(input.docker).toBe(true); expect(input.env).toEqual({ PATH: env.PATH, HOME: env.HOME, TMPDIR: undefined });
    expect(Object.values(input.env)).not.toContain(env.GH_TOKEN); expect(Object.values(input.env)).not.toContain(env.RAILWAY_DEPLOY_TOKEN);
    await input.execute("docker", ["run", "fixture"], { timeout: 1000 });
  });
  const inspect = vi.fn(async () => ({ sha256: "b".repeat(64), commit: config.sourceSha!, sourceSha256: "c".repeat(64), bytes: 123 }));
  const jobs = { total_count: 1, jobs: [{ run_id: 123, run_attempt: 1, head_sha: config.workflowSha, name: "Runtime archive build",
    status: "completed", conclusion: "success", steps: [{ name: "Build exact runtime", conclusion: "success" }, { name: "Save runtime archive", conclusion: "success" }] }] };
  const execute = () => buildRuntime(config, env, { candidate: "/synthetic/candidate", archive: "/synthetic/archive.tar.gz" }, { source, command, identity, build: build as never, inspect: inspect as never });
  return { env, config, state, source, command, identity, build, inspect, jobs, execute };
}

describe("runtime build and exact producer handoff", () => {
  it("builds without channel credentials and rechecks the source on both sides", async () => {
    const f = fixture(), metadata = await f.execute();
    expect(metadata).toMatchObject({ runId: f.config.runId, runAttempt: 1, workflowSha: f.config.workflowSha,
      manifest: { sourceSha: f.config.sourceSha, sha256: "b".repeat(64), sourceSha256: "c".repeat(64) } });
    expect(f.source).toHaveBeenCalledTimes(2); expect(f.identity).toHaveBeenCalledTimes(2);
    expect(f.command.mock.calls.filter(([file]) => file === "docker")).toHaveLength(1);
  });
  it("keeps unprivileged build validation separate from the execution switches", () => {
    const f = fixture(); expect(() => runtimeBuildConfig(f.env)).not.toThrow();
    expect(() => runtimeReleaseConfig(f.env)).toThrow(/disabled/);
    expect(() => runtimeBuildConfig({ ...f.env, GITHUB_EVENT_NAME: "pull_request" })).toThrow();
  });
  it("refuses a dirty candidate before building", async () => {
    const f = fixture(); f.state.dirty = true; await expect(f.execute()).rejects.toThrow(/dirty/); expect(f.build).not.toHaveBeenCalled();
  });
  it("refuses source or archive drift after a build", async () => {
    const f = fixture(); f.identity.mockResolvedValueOnce({ commit: f.config.sourceSha!, sourceSha256: "c".repeat(64), dirty: false })
      .mockResolvedValueOnce({ commit: f.config.sourceSha!, sourceSha256: "d".repeat(64), dirty: false });
    await expect(f.execute()).rejects.toThrow(/changed/);
    const g = fixture(); g.inspect.mockResolvedValue({ sha256: "b".repeat(64), commit: "9".repeat(40), sourceSha256: "c".repeat(64), bytes: 123 });
    await expect(g.execute()).rejects.toThrow(/archive/);
  });
  it("accepts only the successful exact-attempt producer", async () => {
    const f = fixture(), metadata = await f.execute(), read = vi.fn(async () => f.jobs);
    expect(await verifyRuntimeBuild(f.config, metadata, read)).toEqual(metadata);
    expect(read).toHaveBeenCalledWith("/actions/runs/123/attempts/1/jobs?per_page=100");
  });
  it.each(["attempt", "source", "job", "step", "partial"])("refuses %s producer substitution", async change => {
    const f = fixture(), metadata = await f.execute();
    if (change === "attempt") metadata.runAttempt = 2;
    if (change === "source") metadata.manifest.sourceSha = "9".repeat(40);
    if (change === "job") f.jobs.jobs[0].head_sha = "9".repeat(40);
    if (change === "step") f.jobs.jobs[0].steps[1].conclusion = "failure";
    if (change === "partial") f.jobs.total_count = 2;
    await expect(verifyRuntimeBuild(f.config, metadata, async () => f.jobs)).rejects.toThrow();
  });
});
