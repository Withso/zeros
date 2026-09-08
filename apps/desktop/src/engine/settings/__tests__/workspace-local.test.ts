import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  opSettingsRead,
  opSettingsResolve,
  opSettingsWrite,
  opSettingsWriteRaw,
} from "../ops";
import { startSettingsWatcher } from "../watch";

describe("personal workspace overrides", () => {
  let root: string, repo: string, first: string, second: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  const file = (cwd: string) =>
    path.join(
      cwd,
      cwd === repo ? ".zeros/settings.local.toml" : ".zeros/settings.toml",
    );
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "zeros-workspace-settings-"));
    repo = path.join(root, "repo");
    first = path.join(root, "first");
    second = path.join(root, "second");
    mkdirSync(repo);
    process.env.ZEROS_USER_SETTINGS_DIR = path.join(root, "user");
    git(repo, "init", "-q");
    git(
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    );
    git(repo, "worktree", "add", "-qb", "first", first);
    git(repo, "worktree", "add", "-qb", "second", second);
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("renames existing private workspace overrides without changing their bytes", () => {
    const legacy = path.join(first, ".zeros/settings.local.toml");
    mkdirSync(path.dirname(legacy), { recursive: true });
    const contents =
      '# personal workspace override\n[prompts]\ngeneral="Only first"\n';
    writeFileSync(legacy, contents);
    expect(opSettingsRead("workspace-local", first).path).toBe(file(first));
    expect(readFileSync(file(first), "utf8")).toBe(contents);
    expect(() => readFileSync(legacy)).toThrow();
    expect(git(first, "status", "--porcelain")).toBe("");
  });

  it("uses the local filename when a branch still tracks legacy shared settings.toml", () => {
    mkdirSync(path.dirname(file(first)), { recursive: true });
    writeFileSync(
      file(first),
      '[prompts]\ngeneral="Old shared branch value"\n',
    );
    git(first, "add", ".zeros/settings.toml");
    git(
      first,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "legacy settings",
    );
    const result = opSettingsWrite(
      "workspace-local",
      { prompts: { general: "Private override" } },
      first,
    );
    expect(result.path).toBe(path.join(first, ".zeros/settings.local.toml"));
    expect(opSettingsResolve(first).effective.prompts).toMatchObject({
      general: "Private override",
    });
    expect(readFileSync(file(first), "utf8")).toContain(
      "Old shared branch value",
    );
    expect(git(first, "status", "--porcelain")).toBe("");
  });

  it("does not overwrite either private file if both workspace filenames exist", () => {
    mkdirSync(path.dirname(file(first)), { recursive: true });
    const legacy = path.join(first, ".zeros/settings.local.toml");
    writeFileSync(legacy, "# older overrides\n");
    writeFileSync(file(first), "# newer overrides\n");
    expect(opSettingsRead("workspace-local", first).error).toMatch(/both/i);
    expect(readFileSync(legacy, "utf8")).toBe("# older overrides\n");
    expect(readFileSync(file(first), "utf8")).toBe("# newer overrides\n");
  });

  it("keeps writes in their workspace and inherits future changes to repo defaults", () => {
    opSettingsWrite("user", { prompts: { general: "User instructions" } });
    opSettingsWrite(
      "repo-local",
      { git: { remote: "origin" }, scripts: { setup: "install" } },
      repo,
    );
    const before = readFileSync(file(repo), "utf8");
    const saved = opSettingsWrite(
      "workspace-local",
      { git: { remote: "upstream" } },
      first,
    );
    expect(saved.path).toBe(file(first));
    expect(readFileSync(file(repo), "utf8")).toBe(before);
    expect(opSettingsResolve(first).effective).toMatchObject({
      git: { remote: "upstream" },
      scripts: { setup: "install" },
      prompts: { general: "User instructions" },
    });
    expect(opSettingsResolve(first).sources["git.remote"]).toBe(
      "workspace-local",
    );
    expect(opSettingsResolve(second).effective.git).toMatchObject({
      remote: "origin",
    });
    opSettingsWrite("repo-local", { scripts: { setup: "new-install" } }, repo);
    expect(opSettingsResolve(first).effective.scripts).toMatchObject({
      setup: "new-install",
    });
    expect(git(first, "status", "--porcelain")).toBe("");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("leaves preexisting worktree values in place during repository migration", () => {
    mkdirSync(path.dirname(file(first)), { recursive: true });
    writeFileSync(
      file(first),
      '# workspace only\n[prompts]\ngeneral="Only first"\n',
    );
    opSettingsWrite("repo-local", { git: { remote: "origin" } }, repo);
    expect(opSettingsResolve(repo).effective.prompts).toBeUndefined();
    expect(opSettingsResolve(second).effective.prompts).toBeUndefined();
    expect(opSettingsResolve(first).effective.prompts).toMatchObject({
      general: "Only first",
    });
    expect(readFileSync(file(first), "utf8")).toContain("# workspace only");
  });

  it("resolves hand edits from a workspace subdirectory and raw writes retain that owner", () => {
    opSettingsWrite("repo-local", { git: { remote: "origin" } }, repo);
    mkdirSync(path.join(first, "src"));
    opSettingsWriteRaw(
      "workspace-local",
      '[git]\nremote="fork"\n',
      path.join(first, "src"),
    );
    expect(opSettingsRead("workspace-local", first).path).toBe(file(first));
    expect(opSettingsRead("repo-local", first).path).toBe(file(repo));
    expect(
      opSettingsResolve(path.join(first, "src")).effective.git,
    ).toMatchObject({ remote: "fork" });
    expect(opSettingsResolve(repo).effective.git).toMatchObject({
      remote: "origin",
    });
  });

  it("checks the workspace's own Git index and ignore rules before writing", () => {
    opSettingsWrite("repo-local", { git: { remote: "origin" } }, repo);
    writeFileSync(path.join(first, ".gitignore"), "!.zeros/settings.toml\n");
    expect(() =>
      opSettingsWrite("workspace-local", { git: { remote: "fork" } }, first),
    ).toThrow(/exclu|ignor/i);
    expect(opSettingsResolve(repo).effective.git).toMatchObject({
      remote: "origin",
    });
  });

  it("watches exact workspace files and prunes removed workspace owners", async () => {
    opSettingsWrite("repo-local", { git: { remote: "origin" } }, repo);
    mkdirSync(path.dirname(file(first)), { recursive: true });
    writeFileSync(file(first), "# initial\n");
    let roots = [repo, first];
    const changed: string[] = [];
    const watcher = startSettingsWatcher(
      () => roots,
      (paths) => changed.push(...paths),
      { pollIntervalMs: 10 },
    );
    try {
      writeFileSync(file(first), '[prompts]\ngeneral="First"\n');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(changed).toEqual([file(first)]);
      roots = [repo];
      await new Promise((resolve) => setTimeout(resolve, 40));
      writeFileSync(file(first), '[prompts]\ngeneral="Removed"\n');
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(changed).toEqual([file(first)]);
    } finally {
      watcher.stop();
    }
  });
});
