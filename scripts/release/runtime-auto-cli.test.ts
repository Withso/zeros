import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeReleaseIdentity } from "../../apps/control-plane/src/cloud/runtime-release";
import { runtimeBuildDrainVersion } from "../../apps/control-plane/src/cloud/runtime-build-drain";
import { runtimeAutoMain } from "./runtime-auto-cli";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(change: "lockfile" | "delete" | "cp" | "desktop") {
  const root = await mkdtemp(join(tmpdir(), "zeros-runtime-auto-")); directories.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  await mkdir(join(root, "apps/cloud-worker/src"), { recursive: true });
  await mkdir(join(root, "apps/control-plane/src"), { recursive: true });
  await writeFile(join(root, "pnpm-lock.yaml"), "original\n");
  await writeFile(join(root, "apps/cloud-worker/src/worker.ts"), "export {};\n");
  const commit = () => { git("add", "."); git("-c", "user.name=Runtime Test", "-c", "user.email=runtime@example.test", "commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  const previous = commit();
  if (change === "lockfile") await writeFile(join(root, "pnpm-lock.yaml"), "changed\n");
  if (change === "delete") await rm(join(root, "apps/cloud-worker/src/worker.ts"));
  if (change === "cp") await writeFile(join(root, "apps/control-plane/src/index.ts"), "export {};\n");
  if (change === "desktop") await writeFile(join(root, "readme.md"), "documentation\n");
  const source = commit(), sha256 = "a".repeat(64);
  const release = { version: 1 as const, sha256, sourceSha: previous, sourceSha256: "b".repeat(64), qualification: {
    channel: "alpha" as const, runId: "123", runAttempt: 1, completedAt: new Date().toISOString(), receiptSha256: "c".repeat(64), deleted: true as const,
  } };
  const identity = { version: 1, channel: "alpha", ready: true, maintenance: false, sourceSha: source,
    migrations: { state: "current", head: "migration", expectedHead: "migration", manifestSha256: "d".repeat(64) },
    cloud: { enabled: true, ready: true, state: "healthy" }, runtimeBuildDrainVersion, ...runtimeReleaseIdentity({ sha256, release }) };
  const env = { GITHUB_REPOSITORY: "example/project", GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source,
    GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main", GITHUB_WORKFLOW_REF: "example/project/.github/workflows/release-alpha.yml@refs/heads/main",
    GITHUB_EVENT_NAME: "push", GH_TOKEN: "synthetic-github", RELEASE_CHANNEL: "alpha", RELEASE_SHA: source, RELEASE_BRANCH: "main",
    ZEROS_RUNTIME_RELEASE: "enabled", ZEROS_HOSTED_PROMOTION: "enabled", ZEROS_CLOUD_WORKSPACES_ENABLED: "true",
    GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary") };
  const options = { command: vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe("git"); return execFileSync(file, args, { cwd: root, encoding: "utf8" });
  }), fetch: vi.fn(async (input: string | URL | Request) => {
    const url = String(input), workflowSha = "f".repeat(40);
    if (url.includes("/jobs?")) return Response.json({ total_count: 2, jobs: [
      { name: "Runtime archive build", steps: ["Build exact runtime", "Save runtime archive"] },
      { name: "Runtime release transaction", steps: ["Qualify and pin runtime", "Save runtime receipt"] },
    ].map(job => ({ ...job, run_id: 123, run_attempt: 1, head_sha: workflowSha, status: "completed", conclusion: "success",
      steps: job.steps.map(name => ({ name, conclusion: "success" })) })) });
    if (url.includes("/actions/runs/")) return Response.json({ id: 123, run_attempt: 1, head_sha: workflowSha, head_branch: "main",
      path: ".github/workflows/runtime-release.yml", event: "workflow_dispatch", status: "completed", conclusion: "success",
      repository: { full_name: "example/project" }, head_repository: { full_name: "example/project" } });
    return Response.json(identity);
  }) };
  return { root, source, env, options, identity };
}

describe("runtime resolver workflow entry", () => {
  it("executes the advertised CLI against real Git changes with the canonical ESM packager", async () => {
    const f = await fixture("lockfile");
    await writeFile(join(f.root, "identity.json"), JSON.stringify(f.identity));
    await writeFile(join(f.root, "fetch.mjs"), 'import { readFileSync } from "node:fs"; globalThis.fetch = async () => new Response(readFileSync(new URL("./identity.json", import.meta.url)));\n');
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/release/runtime-auto-cli.ts", "--resolve"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...f.env, GIT_DIR: join(f.root, ".git"), GIT_WORK_TREE: f.root,
        NODE_OPTIONS: `--import=${join(f.root, "fetch.mjs")}` },
    });
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    expect(await readFile(f.env.GITHUB_OUTPUT, "utf8")).toContain("action=publish\n");
  });
  it.each(["lockfile", "delete", "cp", "desktop"] as const)("resolves real committed %s changes and writes only bounded workflow outputs", async change => {
    const f = await fixture(change), plan = await runtimeAutoMain(["--resolve"], f.env, f.options);
    expect(plan?.action).toBe(change === "desktop" ? "skip" : "publish");
    const output = await readFile(f.env.GITHUB_OUTPUT, "utf8"), summary = await readFile(f.env.GITHUB_STEP_SUMMARY, "utf8");
    expect(output).toContain(`action=${plan?.action}\n`);
    if (change !== "desktop") expect(output).toContain(`expected_cp_sha=${f.source}\n`);
    expect(summary).toBe(`Cloud runtime: ${plan?.action} (${plan?.reason}).\n`);
    expect(f.options.fetch).toHaveBeenCalledTimes(change === "desktop" ? 3 : 1);
    expect(f.options.command.mock.calls.every(([, args]) => ["rev-parse", "merge-base", "diff"].includes(args[0]))).toBe(true);
    expect(output).not.toContain(f.root);
  });
  it("refuses a changed live destination without writing an action or summary", async () => {
    const f = await fixture("lockfile"); f.identity.sourceSha = "f".repeat(40);
    await expect(runtimeAutoMain(["--resolve"], f.env, f.options)).rejects.toThrow(/destination/);
    await expect(readFile(f.env.GITHUB_OUTPUT)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(f.env.GITHUB_STEP_SUMMARY)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses missing rollout permission on a cloud-enabled release before any API read", async () => {
    const f = await fixture("lockfile");
    await expect(runtimeAutoMain(["--resolve"], { ...f.env, ZEROS_RUNTIME_RELEASE: "disabled" }, f.options)).rejects.toThrow(/enabled/);
    expect(f.options.fetch).not.toHaveBeenCalled();
  });
  it("cannot be invoked by a direct call to the reusable workflow", async () => {
    const f = await fixture("lockfile");
    await expect(runtimeAutoMain(["--resolve"], { ...f.env, GITHUB_EVENT_NAME: "workflow_call" }, f.options)).rejects.toThrow(/parent/);
    expect(f.options.fetch).not.toHaveBeenCalled();
  });
});
