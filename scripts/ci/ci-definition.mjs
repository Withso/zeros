#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// ci-definition — paths that require an owner to merge a CI-definition PR
// ──────────────────────────────────────────────────────────
//
// List both sides of moves with --no-renames. A failed diff must fail this
// command, never print an empty list that could permit an automatic merge.
// Usage: node scripts/ci/ci-definition.mjs --base <commit> [--head <commit>]
// Defaults: origin/main and HEAD. Stdout contains one sorted path per line.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { matchesGlob, parseNameStatus } from "./scope.mjs";

export const CI_DEFINITION_PATTERNS = Object.freeze([
  ".github/workflows/**",
  ".github/actions/**",
  ".github/actionlint.yaml",
  ".github/CODEOWNERS",
  "scripts/ci/**",
  "scripts/check-*",
  "scripts/run-explicit-vitest.mjs",
  "scripts/ui-smoke-composer.mjs",
  "scripts/ui-smoke/**",
  "scripts/release/**",
  "vitest.config.*",
  "eslint.config.*",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "apps/control-plane/package.json",
  "apps/control-plane/pnpm-lock.yaml",
  "apps/web/package.json",
  "apps/web/package-lock.json",
]);

export function isCiDefinitionPath(file) {
  return (
    typeof file === "string" &&
    CI_DEFINITION_PATTERNS.some((glob) => matchesGlob(file, glob))
  );
}

export function ciDefinitionPaths(changes) {
  return [
    ...new Set(
      changes.flatMap((change) =>
        [change.path, change.oldPath].filter(isCiDefinitionPath),
      ),
    ),
  ].sort();
}

function parseArgs(argv) {
  const args = { base: "origin/main", head: "HEAD" };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (
      !["--base", "--head"].includes(flag) ||
      !argv[index + 1] ||
      seen.has(flag)
    ) {
      throw new Error(
        "Usage: node scripts/ci/ci-definition.mjs --base <commit> [--head <commit>]",
      );
    }
    seen.add(flag);
    args[flag.slice(2)] = argv[index + 1];
  }
  return args;
}

export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const { base, head } = parseArgs(argv);
    const git = (args) =>
      execFileSync("git", args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const resolve = (ref) => {
      const sha = git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
        .toString("utf8")
        .trim();
      if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(sha))
        throw new Error("Invalid commit identity.");
      return sha;
    };
    const paths = ciDefinitionPaths(
      parseNameStatus(
        git([
          "diff",
          "--name-status",
          "--no-renames",
          "-z",
          `${resolve(base)}...${resolve(head)}`,
          "--",
        ]),
      ),
    );
    // Escape control characters so one unusual filename cannot forge list rows.
    if (paths.length)
      stdout.write(
        `${paths.map((file) => (/[\r\n\t]/.test(file) ? JSON.stringify(file) : file)).join("\n")}\n`,
      );
    return 0;
  } catch {
    stderr.write(
      "CI-definition diff failed; verify the base/head commits and fetch complete history before deciding whether an owner merge is required.\n",
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = runCli();
}
