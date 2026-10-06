import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { fetch } from "../fetch";

const fixture = vi.hoisted(() => ({ workspace: { path: "", repoRoot: "", placement: "cloud", baseBranch: "main" } }));
vi.mock("../worktree", () => ({ getWorkspace: () => fixture.workspace }));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: "origin" }) }));

it("unshallows accepted source and target ancestry without changing unpublished work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-v2-test-history-real-"));
  const source = path.join(root, "source"), checkout = path.join(root, "checkout");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
    { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git(root, "init", "--initial-branch=main", source);
    await writeFile(path.join(source, "file"), "base"); git(source, "add", "."); git(source, "commit", "-m", "base");
    const base = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "-b", "feature");
    await writeFile(path.join(source, "file"), "feature"); git(source, "commit", "-am", "feature");
    const revision = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "main");
    await writeFile(path.join(source, "target"), "target"); git(source, "add", "."); git(source, "commit", "-m", "target");
    git(root, "clone", "--depth=1", "--branch=feature", pathToFileURL(source).href, checkout);
    git(checkout, "config", "zeros.cloud-source", JSON.stringify({ kind: "branch", revision, headBranch: "feature", targetBranch: "main", pullRequest: null }));
    await writeFile(path.join(checkout, "unpublished"), "agent commit"); git(checkout, "add", "."); git(checkout, "commit", "-m", "unpublished");
    const head = git(checkout, "rev-parse", "HEAD");
    fixture.workspace = { path: checkout, repoRoot: checkout, placement: "cloud", baseBranch: "main" };
    expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect((await fetch({ workspaceId: "cloud", unshallow: true })).historyLimited).toBeUndefined();
    expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(head);
    expect(git(checkout, "merge-base", "HEAD", "origin/main")).toBe(base);
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(await fetch({ workspaceId: "cloud", unshallow: true })).toEqual({ summary: "" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
