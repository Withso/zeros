// What an UNSET `git.branch_prefix_type` means.
//
// This is the whole substance of the 2026-08-03 change: the default moved from
// the fixed `zeros` namespace to the connected GitHub login, so that Settings →
// Git has a selected row on a fresh install instead of three empty radios
// standing for a fourth, unlisted option. The pane can only be honest about
// that if the ENGINE agrees, which is what this file pins — the pane's own
// side is git-defaults.test.ts.
//
// The user layer is redirected to a temp dir: the default is a property of an
// EMPTY settings tree, and without this the assertion would quietly depend on
// whatever ~/.zeros/settings.toml the machine running the suite happens to have.

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
  writeFileSync(path.join(repoRoot, ".zeros", "settings.toml"), body, "utf8");
}

describe("branch prefix type resolution", () => {
  it("defaults to github when nothing is configured", () => {
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("github");
    // Stated twice on purpose: the literal is what the user sees, the constant
    // is what the settings pane mirrors. They must not drift apart.
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe(
      DEFAULT_BRANCH_PREFIX_TYPE,
    );
  });

  it("defaults to github for a repo with a git table but no prefix key", () => {
    // The common real shape — a repo that configures its base branch and
    // nothing else. `git` exists, `branch_prefix_type` doesn't.
    writeRepo('[git]\nbase_branch = "trunk"\n');
    const config = resolveRepoGit(repoRoot);
    expect(config.baseBranch).toBe("trunk");
    expect(config.branchPrefixType).toBe("github");
  });

  it("defaults to github rather than trusting an unknown value", () => {
    // sanitizeLayer should drop an off-enum value before it gets here; if one
    // ever survives, the answer is the default, not the string.
    writeRepo('[git]\nbranch_prefix_type = "wat"\n');
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("github");
  });

  it("still honours an explicit zeros", () => {
    // Dropped from the settings pane's rows, NOT from the schema: a
    // hand-written settings.toml or a team layer may pin it, and those branches
    // must keep landing under `zeros/`.
    writeRepo('[git]\nbranch_prefix_type = "zeros"\n');
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("zeros");
  });

  it("passes the other explicit choices through", () => {
    writeRepo('[git]\nbranch_prefix_type = "none"\n');
    expect(resolveRepoGit(repoRoot).branchPrefixType).toBe("none");
    writeRepo('[git]\nbranch_prefix_type = "custom"\nbranch_prefix = "acme/"\n');
    const config = resolveRepoGit(repoRoot);
    expect(config.branchPrefixType).toBe("custom");
    // Normalized on the way out, so the caller never joins a second slash.
    expect(config.branchPrefix).toBe("acme");
  });

  it("keeps the default for a repoRoot it cannot resolve", () => {
    // A settings problem must never block workspace creation — it degrades to
    // the same answer an empty tree gives.
    expect(resolveRepoGit("").branchPrefixType).toBe(DEFAULT_BRANCH_PREFIX_TYPE);
  });
});
