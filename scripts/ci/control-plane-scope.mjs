#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// control-plane-scope — decide whether the control-plane database suites run
// ──────────────────────────────────────────────────────────
//
// The database suites need four Postgres jobs and most of a Preflight run's
// minutes. Their outcome can only change when one of their inputs changes, so
// the `control plane` gate skips them when a change touches none. The
// typecheck and dependency audit still run on every change.
//
// The inputs are more than apps/control-plane/: the admission contracts import
// the real desktop engine clients and protocol schemas through the root package
// graph, and migrate.test.ts reads two operator documents.
// scripts/__tests__/control-plane-scope.test.ts derives the actual import
// closure of every control-plane source and test file and fails if a file it
// reaches is missing below, so the list cannot silently fall behind.
//
// Anything uncertain runs the suites: an event without a comparable base, a
// base that is not in the checkout, or a diff that fails. Renames are split
// into a deletion and an addition, so moving a file into or out of an input
// path counts on both sides.
//
// Usage (preflight.yml): node scripts/ci/control-plane-scope.mjs >> "$GITHUB_OUTPUT"
// Prints `database=true|false`; the reason goes to stderr and the step summary.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Repository paths a database suite reads. A trailing `/` covers a subtree. */
export const CONTROL_PLANE_DATABASE_INPUTS = Object.freeze([
  // The service: source, tests, migrations, lockfile and Vitest config.
  "apps/control-plane/",
  // Desktop clients and protocol schemas the admission contracts import.
  "apps/desktop/electron/cloud-workspace-access-client.ts",
  "apps/desktop/electron/tsconfig.json",
  "apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs",
  "apps/desktop/src/engine/cloud-agent-execution-client.ts",
  "apps/desktop/src/engine/cloud-command-client.ts",
  "apps/desktop/src/engine/cloud-event-client.ts",
  "apps/desktop/src/engine/cloud-github-write-client.ts",
  "apps/desktop/src/engine/cloud-runtime-registration.ts",
  "apps/desktop/src/engine/git/github-native-client.ts",
  "apps/desktop/src/engine/git/github-native-desktop.ts",
  "packages/protocol/package.json",
  "packages/protocol/tsconfig.json",
  "packages/protocol/src/cloud-actors.ts",
  "packages/protocol/src/cloud-agent-execution.ts",
  "packages/protocol/src/cloud-commands.ts",
  "packages/protocol/src/cloud-computer-tools.ts",
  "packages/protocol/src/cloud-computer-v2.ts",
  "packages/protocol/src/cloud-customization.ts",
  "packages/protocol/src/cloud-runtime-bundle.ts",
  "packages/protocol/src/containment.ts",
  "packages/protocol/src/github-auth.ts",
  "packages/protocol/src/messages.ts",
  // Dev provisioning/qualification modules the Dev integration suites import.
  "scripts/dev-environment/",
  // The root package graph those imports resolve and transform through.
  "package.json",
  "patches/",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  // Operator documents migrate.test.ts checks for complete approval commands.
  "docs/cloud-workspace/infrastructure-and-operations.md",
  "docs/deployment-environments.md",
  // Loaded at run time by the live setup qualification.
  "scripts/cloud-workspace-validation/",
  // This gate itself.
  ".github/workflows/preflight.yml",
  "scripts/ci/control-plane-results.mjs",
  "scripts/ci/control-plane-scope.mjs",
]);

export function isControlPlaneDatabaseInput(file) {
  return CONTROL_PLANE_DATABASE_INPUTS.some((input) =>
    input.endsWith("/") ? file.startsWith(input) : file === input,
  );
}

const NULL_SHA = /^0{40}$/;

/** The commit an event's changes are measured from, or null when unknown. */
export function comparisonBase(env) {
  const base = {
    pull_request: env.PULL_REQUEST_BASE_SHA,
    merge_group: env.MERGE_GROUP_BASE_SHA,
    push: env.PUSH_BEFORE_SHA,
  }[env.EVENT_NAME];
  return base && !NULL_SHA.test(base) ? base : null;
}

/** Paths changed since `base`, or null when the checkout cannot answer. */
export function changedFilesSince(base, { cwd } = {}) {
  try {
    // Three dots compare from the merge base, so commits that landed on the
    // base branch after this change forked are not attributed to it.
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`, "--"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return output.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

export function decideControlPlaneScope({ base, changedFiles }) {
  if (!base) {
    return {
      database: true,
      reason: "No comparable base commit, so every database suite runs.",
    };
  }
  if (changedFiles === null) {
    return {
      database: true,
      reason: `Could not diff against ${base}, so every database suite runs.`,
    };
  }
  const inputs = changedFiles.filter(isControlPlaneDatabaseInput);
  if (inputs.length === 0) {
    return {
      database: false,
      reason: `No control-plane database input changed since ${base.slice(0, 12)}.`,
    };
  }
  const listed = inputs.slice(0, 10).join(", ");
  const more = inputs.length > 10 ? ` and ${inputs.length - 10} more` : "";
  return {
    database: true,
    reason: `Control-plane database inputs changed: ${listed}${more}.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = comparisonBase(process.env);
  const decision = decideControlPlaneScope({
    base,
    changedFiles: base ? changedFilesSince(base) : null,
  });
  process.stdout.write(`database=${decision.database}\n`);
  console.error(decision.reason);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Control-plane database suites\n\n${decision.database ? "Run" : "Skipped"}. ${decision.reason}\n`,
    );
  }
}
