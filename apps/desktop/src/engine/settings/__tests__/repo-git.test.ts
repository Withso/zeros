// Isolate the user settings directory so these defaults do not depend on the host configuration.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRepoGit } from "../repo-git";
import { DEFAULT_BRANCH_PREFIX_TYPE } from "../schema";

let repoRoot: string;
let userDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), "zeros-repogit-"));
  userDir = mkdtempSync(path.join(tmpdir(), "zeros-repogit-user-"));
  process.env.ZEROS_USER_SETTINGS_DIR = userDir;
});
afterEach(() => {
  delete process.env.ZEROS_USER_SETTINGS_DIR;
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

function writeRepo(body: string) {
  mkdirSync(path.join(repoRoot, ".zeros"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, ".zeros", "settings.local.toml"),
    body,
    "utf8",
  );
}

describe("branch prefix type resolution", () => {
  it("defaults to github when nothing is configured", () => {
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("github");
    // Pin the literal default and its parity with the settings pane.
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe(
      DEFAULT_BRANCH_PREFIX_TYPE,
    );
  });

  it("defaults to github for a repo with a git table but no prefix key", () => {
    writeRepo('[git]\nbase_branch = "trunk"\n');
    const config = resolveRepoGit(repoRoot);
    expect(config.baseBranch).toBe("trunk");
    expect(config.branchPrefixType).toBe("github");
  });

  it("defaults to github rather than trusting an unknown value", () => {
    writeRepo('[git]\nbranch_prefix_type = "wat"\n');
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("github");
  });

  it("still honours an explicit zeros", () => {
    // The UI omits this legacy option; existing settings can still select it.
    writeRepo('[git]\nbranch_prefix_type = "zeros"\n');
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("zeros");
  });

  it("passes the other explicit choices through", () => {
    writeRepo('[git]\nbranch_prefix_type = "none"\n');
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("none");
    writeRepo(
      '[git]\nbranch_prefix_type = "custom"\nbranch_prefix = "acme/"\n',
    );
    const config = resolveRepoGit(repoRoot);
    expect(config.branchPrefixType).toBe("custom");
    expect(config.branchPrefix).toBe("acme");
  });

  it("keeps the default for a repoRoot it cannot resolve", () => {
    expect(resolveRepoGit("").branchPrefixType).toBe(
      DEFAULT_BRANCH_PREFIX_TYPE,
    );
  });
});
