import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetch } from "../fetch";

const fixture = vi.hoisted(() => ({ workspace: { path: "", repoRoot: "", placement: "cloud", baseBranch: "main", organizationId: null as string | null }, git: vi.fn() }));
vi.mock("../worktree", () => ({ getWorkspace: () => fixture.workspace }));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: "origin" }) }));
vi.mock("../git-exec", async original => ({ ...await original<typeof import("../git-exec")>(), runGit: fixture.git }));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-v2-test-fetch-"));
  await mkdir(path.join(root, ".git/objects"), { recursive: true });
  fixture.workspace = { path: root, repoRoot: root, placement: "cloud", baseBranch: "main", organizationId: "organization" };
  fixture.git.mockReset().mockImplementation(async (_cwd: string, args: string[]) => ({
    stdout: args.includes("--is-shallow-repository") ? "true\n" : args.includes("--git-path") ? ".git/objects\n" :
      args.includes("zeros.cloud-source") ? JSON.stringify({ kind: "default", revision: "a".repeat(40), headBranch: "main", targetBranch: "main", pullRequest: null }) : "", stderr: "" }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each([null, "organization"])("explicitly unshallows cloud while ordinary Local fetch stays unchanged (owner=%s)", async organizationId => {
  await fetch({ workspaceId: "cloud", unshallow: true });
  expect(fixture.git).toHaveBeenCalledWith(root, expect.arrayContaining(["fetch", "--unshallow", "origin", "a".repeat(40), "+refs/heads/main:refs/remotes/origin/main"]),
    expect.objectContaining({ signal: expect.any(AbortSignal), processGroup: true }));
  fixture.git.mockClear(); fixture.workspace.placement = "local";
  fixture.workspace.organizationId = organizationId;
  expect(await fetch({ workspaceId: "local", prune: true })).toEqual({ summary: "" });
  expect(fixture.git).toHaveBeenCalledExactlyOnceWith(root, ["fetch", "--prune", "origin"], { timeoutMs: 60000 });
});
it.each([null, "organization"])("refuses cloud-only unshallow on Local before any Git operation (owner=%s)", async organizationId => {
  fixture.workspace.placement = "local";
  fixture.workspace.organizationId = organizationId;
  await expect(fetch({ workspaceId: "local", unshallow: true })).rejects.toThrow(/cloud/i);
  expect(fixture.git).not.toHaveBeenCalled();
});
