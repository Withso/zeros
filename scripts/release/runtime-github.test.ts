import { writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runtimeGithub } from "./runtime-github";
import type { RuntimeReleaseConfig } from "./runtime-contracts";

function fixture(channel: "alpha" | "beta" | "production" = "alpha") {
  const config: RuntimeReleaseConfig = { channel, action: channel === "alpha" ? "publish" : "promote", repository: "example/project", workflowSha: "1".repeat(40),
    branch: channel === "alpha" ? "main" : "release/1.2.3", runId: "123", runAttempt: 2, sourceSha: "2".repeat(40),
    expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const run = { id: 123, run_attempt: 2, head_sha: config.workflowSha, head_branch: config.branch, path: ".github/workflows/runtime-release.yml", event: "workflow_dispatch",
    repository: { full_name: config.repository }, head_repository: { full_name: config.repository }, status: "in_progress" };
  const artifact = { name: "runtime-release-123-2", expired: false, workflow_run: { head_sha: config.workflowSha } };
  const state = { head: config.workflowSha, dirty: false, moved: false, ancestor: true, ci: "success", changedTree: false, symlink: false, oversize: false, approval: true, approvalAttempt: 2, approvalName: "Approve runtime promotion" };
  const seen: string[] = [];
  const command = vi.fn(async (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (file === "git") {
      if (args[0] === "status") return state.dirty ? " M tracked.ts\n" : "";
      if (args[1] === "HEAD") return state.head;
      return state.changedTree && args[1].startsWith("4") ? "b".repeat(40) : "a".repeat(40);
    }
    expect(file).toBe("gh"); expect(args).not.toContain("synthetic-token"); expect(options?.env?.GH_TOKEN).toBe("synthetic-token");
    expect(options?.env).not.toHaveProperty("RAILWAY_DEPLOY_TOKEN");
    const directory = args[args.indexOf("--dir") + 1];
    const filename = args[args.indexOf("--name") + 1].startsWith("runtime-archive-") ? "runtime-build.json" : "runtime-qualification.json";
    if (state.symlink) { await writeFile(join(directory, "other.json"), "{}"); await symlink("other.json", join(directory, filename)); }
    else await writeFile(join(directory, filename), state.oversize ? " ".repeat(33 * 1024) : '{"bounded":true}');
    return "";
  });
  const client = runtimeGithub(config, { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: "synthetic-token", RAILWAY_DEPLOY_TOKEN: "synthetic-other-secret" }, { command,
    fetch: async input => {
      const url = String(input); seen.push(url);
      if (url.includes("/compare/")) {
        const source = url.match(/compare\/([a-f0-9]{40})/i)![1];
        return Response.json({ status: state.ancestor ? "ahead" : "diverged", merge_base_commit: { sha: source } });
      }
      if (url.includes("/actions/workflows/")) {
        const file = url.includes("preflight") ? "preflight.yml" : "codeql.yml";
        return Response.json({ total_count: 1, workflow_runs: [{ id: 122, run_attempt: 1, name: file === "preflight.yml" ? "Preflight" : "CodeQL",
          path: `.github/workflows/${file}`, head_sha: new URL(url).searchParams.get("head_sha"), status: "completed", conclusion: state.ci, event: "push",
          repository: { full_name: config.repository }, head_repository: { full_name: config.repository } }] });
      }
      if (url.includes("/artifacts?")) return Response.json({ total_count: 1, artifacts: [artifact] });
      if (url.includes("/jobs?")) return Response.json({ total_count: 1, jobs: [{ run_id: 123, run_attempt: state.approvalAttempt, head_sha: config.workflowSha,
        name: state.approvalName, status: "completed", conclusion: state.approval ? "success" : "failure",
        steps: [{ name: "Record runtime approval", status: "completed", conclusion: "success" }] }] });
      if (url.includes("/commits/")) return Response.json({ sha: state.moved ? "9".repeat(40) : config.workflowSha });
      return Response.json(run);
    } });
  return { config, run, artifact, state, seen, command, client };
}

describe("runtime release source and workflow provenance", () => {
  it.each([
    ["alpha", "release-alpha.yml", "push"], ["beta", "release-beta.yml", "push"], ["production", "release.yml", "workflow_dispatch"],
  ] as const)("authenticates the %s automatic caller and its nested approval", async (channel, file, event) => {
    const f = fixture(channel); Object.assign(f.config, { workflowFile: file });
    f.run.path = `.github/workflows/${file}`; f.run.event = event; f.state.approvalName = "Cloud runtime / Approve runtime promotion";
    await expect(f.client.source()).resolves.toBeUndefined();
    f.run.path = ".github/workflows/runtime-release.yml";
    await expect(f.client.source()).rejects.toThrow();
  });
  it.each(["Approve Production release", "Other / Approve runtime promotion", "Approve runtime promotion"])("refuses a different nested approval: %s", async name => {
    const f = fixture("production"); Object.assign(f.config, { workflowFile: "release.yml" });
    f.run.path = ".github/workflows/release.yml"; f.state.approvalName = name;
    await expect(f.client.source()).rejects.toThrow();
  });
  it("checks the clean controller, exact dispatched attempt, and both exact main-source CI histories", async () => {
    const f = fixture(); await f.client.source();
    expect(f.seen.filter(u => u.includes("/compare/"))).toHaveLength(2);
    expect(f.seen.filter(u => u.includes("/actions/workflows/"))).toHaveLength(4);
  });
  it.each(["head", "dirty", "ancestor", "ci"] as const)("refuses invalid %s before release authority", async field => {
    const f = fixture();
    if (field === "head") f.state.head = "9".repeat(40);
    if (field === "dirty") f.state.dirty = true;
    if (field === "ancestor") f.state.ancestor = false;
    if (field === "ci") f.state.ci = "failure";
    await expect(f.client.source()).rejects.toThrow();
  });
  it.each([{ run_attempt: 1 }, { head_sha: "9".repeat(40) }, { event: "pull_request" }, { path: ".github/workflows/other.yml" },
    { head_repository: { full_name: "foreign/repo" } }])("refuses another workflow authority (%j)", async patch => {
    const f = fixture(); Object.assign(f.run, patch); await expect(f.client.source()).rejects.toThrow();
  });
  it("requires a protected release branch to remain at the dispatched source", async () => {
    const f = fixture("beta"); await f.client.source(); f.state.moved = true; await expect(f.client.source()).rejects.toThrow(/moved/);
  });
  it("keeps Beta's branch and CI fences without requiring a human approval job", async () => {
    const f = fixture("beta"); f.state.approval = false;
    await expect(f.client.source()).resolves.toBeUndefined();
    expect(f.seen.some(path => path.includes("/jobs?"))).toBe(false);
    f.state.ci = "failure"; await expect(f.client.source()).rejects.toThrow();
  });
  it.each(["failure", "old-attempt"])("refuses %s approval evidence for promotion", async change => {
    const f = fixture("production");
    if (change === "failure") f.state.approval = false;
    else f.state.approvalAttempt = 1;
    await expect(f.client.source()).rejects.toThrow(/approval job/);
  });
  it("compares both the complete control-plane and protocol trees", async () => {
    const f = fixture(); expect(await f.client.sameControlPlane("3".repeat(40), "4".repeat(40))).toBe(true);
    expect(f.command.mock.calls.map(c => c[1][1]).slice(-4)).toEqual([`${"3".repeat(40)}:apps/control-plane`, `${"4".repeat(40)}:apps/control-plane`, `${"3".repeat(40)}:packages/protocol`, `${"4".repeat(40)}:packages/protocol`]);
    f.state.changedTree = true; expect(await f.client.sameControlPlane("3".repeat(40), "4".repeat(40))).toBe(false);
  });
  it("downloads only the exact attempt's bounded regular qualification file", async () => {
    const f = fixture(); expect(await f.client.artifact("123", 2)).toEqual({ bounded: true });
    const call = f.command.mock.calls.find(c => c[0] === "gh")!; expect(call[1]).toContain("runtime-release-123-2");
  });
  it("downloads the publication attempt's separate bounded build metadata", async () => {
    const f = fixture(); f.artifact.name = "runtime-archive-123-2";
    expect(await f.client.buildArtifact("123", 2)).toEqual({ bounded: true });
    const call = f.command.mock.calls.find(c => c[0] === "gh")!; expect(call[1]).toContain("runtime-archive-123-2");
  });
  it.each(["expired", "other-name", "symlink", "oversize"])("refuses %s artifact evidence", async mode => {
    const f = fixture();
    if (mode === "expired") f.artifact.expired = true;
    if (mode === "other-name") f.artifact.name = "runtime-release-123-1";
    if (mode === "symlink") f.state.symlink = true;
    if (mode === "oversize") f.state.oversize = true;
    await expect(f.client.artifact("123", 2)).rejects.toThrow();
  });
  it.each(["expired", "other-name", "symlink", "oversize"])("refuses %s build-artifact evidence", async mode => {
    const f = fixture(); f.artifact.name = mode === "other-name" ? "runtime-archive-123-1" : "runtime-archive-123-2";
    if (mode === "expired") f.artifact.expired = true;
    if (mode === "symlink") f.state.symlink = true;
    if (mode === "oversize") f.state.oversize = true;
    await expect(f.client.buildArtifact("123", 2)).rejects.toThrow();
  });
});
