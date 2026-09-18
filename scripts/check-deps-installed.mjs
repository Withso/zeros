#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-deps-installed — fail the dev loop on a STALE node_modules
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS: nothing in the repo noticed when node_modules drifted behind
// pnpm-lock.yaml, so a checkout that pulled a commit adding a dependency booted
// a dev server that looked completely healthy and then threw, on first paint:
//
//   [plugin:vite:import-analysis] Failed to resolve import "@radix-ui/react-menu"
//   from "…/shared/ui/primitives/context-menu.tsx". Does the file exist?
//
// That message sends you hunting through the FILE — which is fine, and has been
// fine for months — when the actual answer is "you never ran pnpm install".
// It cost half an hour of a real session (react-menu landed in #172,
// playwright-core on a feature branch; both were simply absent on disk).
//
// The failure mode is structural for anyone whose checkout is refreshed by
// something other than their own `git pull` — cloud/worktree sync copies the
// tracked tree, but node_modules is gitignored and stays whatever it was. So
// the lockfile moves and the install does not, every single time a dep is added.
//
// TWO TIERS, deliberately:
//   • MISSING direct dep → exit 1. This is the Vite-breaking case above: the
//     import cannot resolve, so the app is already broken. Failing here costs
//     nothing you weren't about to lose anyway, and names the real cause.
//   • Lock stamp differs, nothing missing → warn, exit 0. Versions moved (a
//     bump, a transitive change) but every import still resolves. Worth saying
//     out loud — it desyncs check:runtime-pins and friends — but NOT worth
//     blocking a dev server over, and blocking would fire on every half-landed
//     rebase.
//
// Existence is checked with statSync, not existsSync: a DANGLING symlink (very
// easy to produce in pnpm's linked layout by deleting a store entry) satisfies
// existsSync and still fails every resolver. statSync follows the link.
//
// Escape hatch: ZEROS_SKIP_DEP_CHECK=1 for the rare deliberate partial install.
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = path.join(ROOT, "node_modules");

if (process.env.ZEROS_SKIP_DEP_CHECK === "1") process.exit(0);

/** Resolvable on disk? Follows symlinks so a dangling pnpm link counts as missing. */
function installed(name) {
  try {
    fs.statSync(path.join(NODE_MODULES, name));
    return true;
  } catch {
    return false;
  }
}

/** Byte-compare pnpm-lock.yaml with the copy pnpm stamps into node_modules at
 *  install time. Identical => the tree on disk was built from this lockfile.
 *  A MISSING stamp is not evidence of staleness on its own (older pnpm, a
 *  different package manager, a pruned install), so it only downgrades us to
 *  the per-dependency check below. */
function lockStampMatches() {
  try {
    const declared = fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"));
    const installedLock = fs.readFileSync(
      path.join(NODE_MODULES, ".pnpm", "lock.yaml"),
    );
    return declared.equals(installedLock);
  } catch {
    return null; // unknown — fall back to the existence sweep alone
  }
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
const declared = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
];

if (!fs.existsSync(NODE_MODULES)) {
  console.error(
    "\n[deps] node_modules is missing entirely.\n" +
      "[deps] Run: pnpm install\n",
  );
  process.exit(1);
}

const missing = declared.filter((name) => !installed(name));

if (missing.length > 0) {
  const shown = missing.slice(0, 12);
  console.error(
    `\n[deps] ${missing.length} declared dependenc${missing.length === 1 ? "y is" : "ies are"} NOT installed:\n` +
      shown.map((name) => `         • ${name}`).join("\n") +
      (missing.length > shown.length
        ? `\n         … and ${missing.length - shown.length} more`
        : "") +
      "\n\n[deps] Importing any of these fails at resolve time — Vite reports it as\n" +
      "[deps] 'Failed to resolve import \"…\". Does the file exist?', which points at\n" +
      "[deps] the importing file rather than at the real cause (this install).\n\n" +
      "[deps] Run: pnpm install\n" +
      "[deps] (ZEROS_SKIP_DEP_CHECK=1 bypasses this check.)\n",
  );
  process.exit(1);
}

if (lockStampMatches() === false) {
  console.warn(
    "\n[deps] node_modules was installed from a DIFFERENT pnpm-lock.yaml than the\n" +
      "[deps] one checked out. Every import still resolves, so this is a warning,\n" +
      "[deps] not an error — but installed versions may not match the lockfile.\n" +
      "[deps] Run `pnpm install` to sync.\n",
  );
}
