import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { opSettingsRead, opSettingsResolve, opSettingsWrite } from "../ops";
import { resolveRepoGit } from "../repo-git";

describe("git.fetch_submodules setting", () => {
  let root: string;
  let repo: string;
  let workspace: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-fetch-submodules-"));
    repo = path.join(root, "repo");
    workspace = path.join(root, "workspace");
    mkdirSync(repo);
    process.env.ZEROS_USER_SETTINGS_DIR = path.join(root, "user");
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-qm", "init");
    git(repo, "worktree", "add", "-qb", "ws", workspace);
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("is off by default", () => {
    expect(resolveRepoGit(repo).fetchSubmodules).toBe(false);
    expect(opSettingsResolve(repo).effective.git).not.toHaveProperty("fetch_submodules");
  });

  it("is stored in the repository's personal Local settings through the settings write op", () => {
    const written = opSettingsWrite("repo-local", { git: { fetch_submodules: true } }, repo);
    expect(written.warnings).toEqual([]);
    expect(written.path).toBe(path.join(repo, ".zeros", "settings.local.toml"));
    const read = opSettingsRead("repo-local", repo);
    expect((read.doc.git as Record<string, unknown>).fetch_submodules).toBe(true);
    const resolved = opSettingsResolve(repo);
    expect(resolved.sources["git.fetch_submodules"]).toBe("repo-local");
    expect(resolveRepoGit(repo).fetchSubmodules).toBe(true);
    // A workspace of the repository resolves the main checkout's personal settings.
    expect(resolveRepoGit(repo, { path: workspace, repoRoot: repo } as never).fetchSubmodules).toBe(true);
    // The personal file is never offered for commit.
    expect(git(repo, "status", "--porcelain")).toBe("");

    opSettingsWrite("repo-local", { git: { fetch_submodules: false } }, repo);
    expect(resolveRepoGit(repo).fetchSubmodules).toBe(false);
  });

  it("ignores a non-boolean value", () => {
    const written = opSettingsWrite("repo-local", { git: { fetch_submodules: "yes" } }, repo);
    expect(written.warnings.join("\n")).toMatch(/fetch_submodules/);
    expect(resolveRepoGit(repo).fetchSubmodules).toBe(false);
  });
});
