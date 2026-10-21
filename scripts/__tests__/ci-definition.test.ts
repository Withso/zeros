import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isCiDefinitionPath } from "../ci/ci-definition.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SCRIPT = path.join(ROOT, "scripts/ci/ci-definition.mjs");

describe("CI-definition paths", () => {
  it.each([
    ".github/workflows/preflight.yml",
    ".github/actions/install/action.yml",
    ".github/actionlint.yaml",
    ".github/CODEOWNERS",
    "scripts/ci/scope-rules.json",
    "scripts/check-ui-consistency.mjs",
    "scripts/run-explicit-vitest.mjs",
    "scripts/ui-smoke-composer.mjs",
    "scripts/ui-smoke/new-scenario.mjs",
    "scripts/release/ci.ts",
    "vitest.config.ts",
    "vitest.config.mjs",
    "eslint.config.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/control-plane/package.json",
    "apps/control-plane/pnpm-lock.yaml",
    "apps/web/package.json",
    "apps/web/package-lock.json",
  ])("requires an owner merge for %s", (file) => {
    expect(isCiDefinitionPath(file)).toBe(true);
  });

  it.each([
    "docs/ci.md",
    "apps/desktop/src/renderer/app-shell.tsx",
    "scripts/__tests__/ci-scope.test.ts",
    "scripts/ui-smoke-design-git-menu.mjs",
    ".github/workflows-old/example.yml",
    "other/scripts/check-ui.mjs",
    "scripts/check-tools/helper.mjs",
    "apps/web/package.json.backup",
    "packages/protocol/package.json",
    "apps/control-plane-notes/package.json",
    "apps/control-plane/src/vitest.config.ts",
    "apps/web/eslint.config.mjs",
  ])("does not broaden the explicit definition to %s", (file) => {
    expect(isCiDefinitionPath(file)).toBe(false);
  });
});

describe("CI-definition diff CLI", () => {
  const repositories: string[] = [];
  afterEach(() => {
    for (const cwd of repositories.splice(0))
      rmSync(cwd, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  it("lists both rename sides, additions and deletions deterministically", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "ci-definition-"));
    repositories.push(cwd);
    git(cwd, "init", "--quiet");
    git(cwd, "config", "user.name", "CI Definition Test");
    git(cwd, "config", "user.email", "ci-definition@invalid.example");
    mkdirSync(path.join(cwd, "scripts/ci"), { recursive: true });
    writeFileSync(path.join(cwd, "scripts/ci/old.mjs"), "export {};\n");
    writeFileSync(path.join(cwd, "package.json"), "{}\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "base");
    const base = git(cwd, "rev-parse", "HEAD");
    renameSync(
      path.join(cwd, "scripts/ci/old.mjs"),
      path.join(cwd, "scripts/ci/new.mjs"),
    );
    rmSync(path.join(cwd, "package.json"));
    writeFileSync(path.join(cwd, "readme.md"), "documentation\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", "move definition");
    const result = spawnSync(process.execPath, [SCRIPT, "--base", base], {
      cwd,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "package.json",
      "scripts/ci/new.mjs",
      "scripts/ci/old.mjs",
    ]);
    const failed = spawnSync(process.execPath, [SCRIPT, "--base", "missing"], {
      cwd,
      encoding: "utf8",
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toMatch(/CI-definition diff failed/);
  });
});
