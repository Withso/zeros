import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { opSettingsRead, opSettingsResolve, opSettingsWrite } from "../ops";
import { resolveSettings } from "../resolve";

describe("personal repository settings", () => {
  let root: string;
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const local = () => path.join(repo, ".zeros/settings.local.toml");
  const legacy = () => path.join(repo, ".zeros/settings.toml");

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-personal-settings-"));
    repo = path.join(root, "repo");
    mkdirSync(path.join(repo, ".zeros"), { recursive: true });
    process.env.ZEROS_USER_SETTINGS_DIR = path.join(root, "user");
    git("init", "-q");
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("migrates shared settings once, preserving local overrides and later deletions", () => {
    writeFileSync(
      legacy(),
      '[scripts]\nsetup = "install"\narchive = "clean"\n[git]\nremote = "upstream"\n',
    );
    writeFileSync(
      local(),
      '# personal comment\n[scripts]\nsetup = "local-install"\n',
    );
    const result = opSettingsResolve(repo);
    expect(result.effective.scripts).toMatchObject({
      setup: "local-install",
      archive: "clean",
    });
    expect(result.sources["scripts.archive"]).toBe("repo-local");
    expect(readFileSync(local(), "utf8")).toContain("# personal comment");
    expect(git("check-ignore", ".zeros/settings.local.toml").trim()).toBe(
      ".zeros/settings.local.toml",
    );
    expect(existsSync(path.join(repo, ".gitignore"))).toBe(false);
    writeFileSync(
      legacy(),
      '[scripts]\narchive = "changed-on-another-branch"\n',
    );
    opSettingsWrite("repo-local", { scripts: { archive: null } }, repo);
    expect(
      (opSettingsResolve(repo).effective.scripts as Record<string, unknown>)
        .archive,
    ).toBeUndefined();
  });

  it("routes legacy repo writes to the local file without creating a shared file", () => {
    const result = opSettingsWrite(
      "repo",
      { scripts: { setup: "install" } },
      repo,
    );
    expect(result.path).toBe(local());
    expect(existsSync(legacy())).toBe(false);
    expect(opSettingsRead("repo-local", repo).doc.scripts).toEqual({
      setup: "install",
    });
    expect(git("status", "--porcelain")).toBe("");
  });

  it("uses the same settings owner when a repository is opened through a symbolic alias", () => {
    const alias = path.join(root, "alias");
    symlinkSync(repo, alias, "dir");
    opSettingsWrite("repo-local", { git: { remote: "upstream" } }, alias);
    expect(opSettingsRead("repo-local", alias).path).toBe(
      opSettingsRead("repo-local", repo).path,
    );
  });

  it("inherits repository defaults with a separate workspace override file", () => {
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    );
    const worktree = path.join(root, "worktree");
    git("worktree", "add", "-qb", "test-worktree", worktree);
    opSettingsWrite("repo-local", { scripts: { setup: "from-main" } }, repo);
    expect(opSettingsRead("repo-local", worktree).path).toBe(local());
    opSettingsWrite(
      "workspace-local",
      { git: { remote: "personal" } },
      worktree,
    );
    expect(
      (
        opSettingsResolve(worktree, repo).effective.git as Record<
          string,
          unknown
        >
      ).remote,
    ).toBe("personal");
    expect(existsSync(path.join(worktree, ".zeros/settings.toml"))).toBe(true);
  });

  it("refuses tracked personal files instead of treating a filename as proof of privacy", () => {
    writeFileSync(local(), '[scripts]\nsetup = "tracked-command"\n');
    git("add", ".zeros/settings.local.toml");
    expect(() =>
      opSettingsWrite("repo-local", { git: { remote: "x" } }, repo),
    ).toThrow(/tracked/i);
    const result = opSettingsResolve(repo);
    expect(
      (result.effective.scripts as Record<string, unknown>).setup,
    ).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(/tracked/i);
    expect(readFileSync(local(), "utf8")).toContain("tracked-command");
  });

  it("fails before saving when repository rules defeat the local exclusion", () => {
    writeFileSync(
      path.join(repo, ".gitignore"),
      "!.zeros/settings.local.toml\n",
    );
    expect(() =>
      opSettingsWrite("repo-local", { scripts: { setup: "install" } }, repo),
    ).toThrow(/ignor|exclu/i);
    expect(existsSync(local())).toBe(false);
  });

  it("refuses a symbolic Git exclusion file without changing its target", () => {
    const outside = path.join(root, "outside-exclude");
    writeFileSync(outside, "# Preserve this file\n");
    const exclude = path.join(repo, ".git/info/exclude");
    rmSync(exclude);
    symlinkSync(outside, exclude);

    expect(() =>
      opSettingsWrite("repo-local", { scripts: { setup: "install" } }, repo),
    ).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("# Preserve this file\n");
    expect(existsSync(local())).toBe(false);
  });

  it("keeps personal settings excluded after the user's external ignore list changes", () => {
    const externalIgnore = path.join(root, "global-ignore");
    writeFileSync(externalIgnore, ".zeros/settings.local.toml\n");
    git("config", "core.excludesFile", externalIgnore);
    opSettingsWrite("repo-local", { git: { remote: "personal" } }, repo);
    writeFileSync(externalIgnore, "");
    expect(git("check-ignore", ".zeros/settings.local.toml").trim()).toBe(
      ".zeros/settings.local.toml",
    );
    expect(git("status", "--porcelain")).toBe("");
  });

  it("does not overwrite malformed migration inputs and retries after repair", () => {
    writeFileSync(legacy(), "[scripts\n");
    expect(opSettingsResolve(repo).warnings.join(" ")).toMatch(/malformed/i);
    expect(existsSync(local())).toBe(false);
    writeFileSync(legacy(), '[scripts]\nsetup = "repaired"\n');
    expect(
      (opSettingsResolve(repo).effective.scripts as Record<string, unknown>)
        .setup,
    ).toBe("repaired");
  });

  it("ignores the shared repo input while honoring personal workspace overrides", () => {
    const result = resolveSettings({
      user: { git: { remote: "user" } },
      repo: { git: { remote: "shared" } },
      repoLocal: { scripts: { setup: "local" } },
      workspaceLocal: { git: { remote: "worktree" } },
    });
    expect((result.effective.git as Record<string, unknown>).remote).toBe(
      "worktree",
    );
    expect((result.effective.scripts as Record<string, unknown>).setup).toBe(
      "local",
    );
  });

  it("never migrates the user settings file as a legacy repository file", () => {
    process.env.ZEROS_USER_SETTINGS_DIR = path.join(repo, ".zeros");
    writeFileSync(legacy(), '[scripts]\nsetup = "user-default"\n');
    const result = opSettingsResolve(repo);
    expect(result.sources["scripts.setup"]).toBe("user");
    expect(existsSync(local())).toBe(false);
  });

  it("keeps old worktree preferences outside repository defaults", () => {
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    );
    const worktree = path.join(root, "old-worktree");
    git("worktree", "add", "-qb", "old", worktree);
    mkdirSync(path.join(worktree, ".zeros"));
    writeFileSync(
      path.join(worktree, ".zeros/settings.local.toml"),
      'file_include_globs=[".env"]\n[git]\nremote="upstream"\n[prompts]\ngeneral="Keep tests focused"\n[mcp]\nservers=[{name="dormant",transport="stdio",command="old-unsupported-command"}]\n',
    );
    writeFileSync(local(), '[git]\nremote="origin"\n');
    const result = opSettingsResolve(repo);
    expect(result.effective.prompts).toBeUndefined();
    expect(opSettingsResolve(worktree).effective.prompts).toMatchObject({
      general: "Keep tests focused",
    });
    expect(result.effective.git).toMatchObject({ remote: "origin" });
    expect(result.effective.mcp).toBeUndefined();
    expect(result.effective.file_include_globs).toBeUndefined();
    expect(result.warnings.some((note) => note.includes("worktree"))).toBe(
      false,
    );
    opSettingsWrite("repo-local", { prompts: { general: null } }, repo);
    expect(opSettingsResolve(repo).effective.prompts).toBeUndefined();
  });
});
