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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opSettingsRead, opSettingsWrite, opSettingsWriteRaw } from "../ops";

const malformed = 'settings_version = 2\n[git\nremote = "origin"\n';
const replacement =
  'settings_version = 2\n# repaired\n[git]\nremote = "upstream"\n';
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe("repairing personal settings through the raw editor", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "zeros-settings-repair-"));
    repo = path.join(dir, "repo");
    mkdirSync(repo);
    vi.stubEnv("ZEROS_USER_SETTINGS_DIR", path.join(dir, "user"));
    git(repo, "init", "-q");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  const worktree = () => {
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
    const checkout = path.join(dir, "checkout");
    git(repo, "worktree", "add", "-qb", "workspace", checkout);
    return checkout;
  };

  it.each(["repo", "repo-local", "workspace-local"] as const)(
    "allows a valid %s replacement while structured patches still refuse malformed input",
    (layer) => {
      const file = path.join(repo, ".zeros/settings.local.toml");
      write(file, malformed);
      expect(() =>
        opSettingsWrite(layer, { git: { remote: "upstream" } }, repo),
      ).toThrow(/malformed/);
      expect(readFileSync(file, "utf8")).toBe(malformed);

      expect(opSettingsWriteRaw(layer, replacement, repo).path).toBe(file);
      expect(readFileSync(file, "utf8")).toBe(replacement);
      expect(opSettingsRead(layer, repo).error).toBeUndefined();
      expect(() =>
        git(repo, "check-ignore", "--quiet", "--", file),
      ).not.toThrow();
    },
  );

  it.each(["settings.toml", "settings.local.toml"])(
    "repairs a linked workspace's %s without changing repository defaults",
    (filename) => {
      const checkout = worktree();
      const repoFile = path.join(repo, ".zeros/settings.local.toml");
      const defaults = 'settings_version = 2\n[git]\nremote = "origin"\n';
      write(repoFile, defaults);
      const oldFile = path.join(checkout, ".zeros", filename);
      write(oldFile, malformed);
      const file = path.join(checkout, ".zeros/settings.toml");

      expect(
        opSettingsWriteRaw("workspace-local", replacement, checkout).path,
      ).toBe(file);
      expect(readFileSync(file, "utf8")).toBe(replacement);
      expect(readFileSync(repoFile, "utf8")).toBe(defaults);
      expect(
        existsSync(path.join(checkout, ".zeros/settings.local.toml")),
      ).toBe(false);
      expect(() =>
        git(checkout, "check-ignore", "--quiet", "--", file),
      ).not.toThrow();
    },
  );

  it("keeps legacy recovery bytes and prevents a later migration from replacing the raw document", () => {
    const legacy = path.join(repo, ".zeros/settings.toml");
    write(legacy, malformed);
    const text = '# my settings\n[git]\nremote = "upstream"\n';

    opSettingsWriteRaw("repo-local", text, repo);

    expect(readFileSync(legacy, "utf8")).toBe(malformed);
    expect(
      readFileSync(path.join(repo, ".zeros/settings.local.toml"), "utf8"),
    ).toBe(`settings_version = 2\n${text}`);
    const read = opSettingsRead("repo-local", repo);
    expect(read.error).toBeUndefined();
    expect(read.doc).toEqual({
      settings_version: 2,
      git: { remote: "upstream" },
    });
  });

  it.each([
    [malformed, /invalid TOML/],
    ["settings_version = 999\n", /Unsupported settings_version/],
  ] as const)(
    "rejects an invalid replacement without changing existing bytes (%s)",
    (text, error) => {
      const file = path.join(repo, ".zeros/settings.local.toml");
      write(file, malformed);
      expect(() => opSettingsWriteRaw("repo-local", text, repo)).toThrow(error);
      expect(readFileSync(file, "utf8")).toBe(malformed);
    },
  );

  it("still refuses to overwrite tracked personal settings", () => {
    const file = path.join(repo, ".zeros/settings.local.toml");
    write(file, malformed);
    git(repo, "add", "--", file);
    expect(() => opSettingsWriteRaw("repo-local", replacement, repo)).toThrow(
      /tracked by Git/,
    );
    expect(readFileSync(file, "utf8")).toBe(malformed);
  });

  it.each(["directory", "file"])(
    "still refuses a symbolic link at the settings %s",
    (kind) => {
      const outside = path.join(dir, "outside");
      const outsideFile = path.join(outside, "settings.local.toml");
      write(outsideFile, malformed);
      const settingsDir = path.join(repo, ".zeros");
      if (kind === "directory") symlinkSync(outside, settingsDir, "dir");
      else {
        mkdirSync(settingsDir);
        symlinkSync(outsideFile, path.join(settingsDir, "settings.local.toml"));
      }
      expect(() => opSettingsWriteRaw("repo-local", replacement, repo)).toThrow(
        /symbolic link/,
      );
      expect(readFileSync(outsideFile, "utf8")).toBe(malformed);
    },
  );

  it("still refuses conflicting workspace filenames without replacing either", () => {
    const checkout = worktree();
    const current = path.join(checkout, ".zeros/settings.toml");
    const legacy = path.join(checkout, ".zeros/settings.local.toml");
    write(current, malformed);
    write(legacy, replacement);
    expect(() =>
      opSettingsWriteRaw("workspace-local", replacement, checkout),
    ).toThrow(/Both workspace settings/);
    expect(readFileSync(current, "utf8")).toBe(malformed);
    expect(readFileSync(legacy, "utf8")).toBe(replacement);
  });
});
