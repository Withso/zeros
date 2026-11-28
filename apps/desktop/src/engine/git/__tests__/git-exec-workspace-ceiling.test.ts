import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFile, runGit, runGitProbeSync } from "../git-exec";
import { setStateRootForTesting, worktreesRoot } from "../state";

// Fixture Git must never follow an inherited repository selection (for example
// when the suite runs inside a Git hook) into an unrelated repository.
const fixtureEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"]) delete env[key];
  return env;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: fixtureEnv() }).trim();

// A Zeros workspace folder sits inside the managed workspaces root. When its
// `.git` link is lost, Git must not walk up and adopt whatever repository
// encloses that root (for example a home-directory dotfiles repository).
describe("runGit inside the managed workspaces root", () => {
  let enclosing: string;
  let repo: string;

  beforeEach(() => {
    enclosing = realpathSync(mkdtempSync(path.join(tmpdir(), "zeros-ceiling-")));
    git(enclosing, "init", "-q", "-b", "main");
    git(enclosing, "config", "user.email", "test@example.com");
    git(enclosing, "config", "user.name", "Test");
    writeFileSync(path.join(enclosing, "enclosing-only.txt"), "enclosing\n");
    git(enclosing, "add", ".");
    git(enclosing, "commit", "-qm", "enclosing");
    // The state root (and so the workspaces root) lives inside that repository.
    mkdirSync(path.join(enclosing, "state"));
    setStateRootForTesting(path.join(enclosing, "state"));

    repo = path.join(enclosing, "source-repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(path.join(repo, "app.txt"), "app\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "app");
  });

  afterEach(() => {
    setStateRootForTesting(null);
    rmSync(enclosing, { recursive: true, force: true });
  });

  it("refuses a workspace folder whose .git link is gone instead of using the enclosing repository", async () => {
    const broken = path.join(worktreesRoot(), "source-repo", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, "work.txt"), "work\n");

    await expect(runGit(broken, ["rev-parse", "--show-toplevel"])).rejects.toThrow();
    await expect(runGit(broken, ["status", "--porcelain"])).rejects.toThrow();
    await expect(runGit(broken, ["add", "--", "work.txt"])).rejects.toThrow();
    expect(() => runGitProbeSync(broken, "rev_parse", ["rev-parse", "--show-toplevel"])).toThrow();
    // Callers such as isRepo pass the folder through -C with no cwd.
    await expect(runFile("git", ["-C", broken, "rev-parse", "--show-toplevel"])).rejects.toThrow();
    // The enclosing repository was never touched.
    expect(git(enclosing, "diff", "--cached", "--name-only")).toBe("");
  });

  it("still resolves a healthy linked worktree from its root and from a subdirectory", async () => {
    const workspace = path.join(worktreesRoot(), "source-repo", "healthy");
    mkdirSync(path.dirname(workspace), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "healthy", workspace);
    mkdirSync(path.join(workspace, "nested"));

    const fromRoot = await runGit(workspace, ["rev-parse", "--show-toplevel"]);
    const fromNested = await runGit(path.join(workspace, "nested"), ["rev-parse", "--show-toplevel"]);
    expect(realpathSync(fromRoot.stdout.trim())).toBe(realpathSync(workspace));
    expect(realpathSync(fromNested.stdout.trim())).toBe(realpathSync(workspace));
  });

  it("leaves repositories outside the workspaces root unaffected", async () => {
    const top = await runGit(repo, ["rev-parse", "--show-toplevel"]);
    expect(realpathSync(top.stdout.trim())).toBe(repo);
    const enclosingTop = await runGit(path.join(enclosing, "state"), ["rev-parse", "--show-toplevel"]);
    expect(realpathSync(enclosingTop.stdout.trim())).toBe(enclosing);
  });

  it("protects a workspaces root whose path contains the list delimiter through its nearest listable ancestor", async () => {
    const odd = path.join(enclosing, "zeros:local");
    mkdirSync(odd);
    setStateRootForTesting(odd);
    const broken = path.join(worktreesRoot(), "source-repo", "broken");
    mkdirSync(broken, { recursive: true });
    await expect(runGit(broken, ["rev-parse", "--show-toplevel"])).rejects.toThrow();
  });
});
