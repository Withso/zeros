#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-codex-pin — keep the Codex app-server protocol triple in lockstep
// ──────────────────────────────────────────────────────────
//
// Three values must agree or the app talks a stale protocol to a newer Codex
// binary (a wire mismatch no typecheck/test catches — the committed bindings are
// internally self-consistent):
//   a. the INSTALLED @openai/codex version
//   b. package.json#codexProtocolVersion (the pin)
//   c. src/engine/agents/adapters/codex/generated/.version (the committed bindings)
//
// The failure mode: Renovate bumps @openai/codex without re-running
// `pnpm codegen:codex`; codegen early-exits because .version still matches the
// (unchanged) pin, so the bindings stay old. `models:verify` gates the Claude SDK
// version; there is no equivalent for the Codex triple — this is it. Pure offline
// compare. Run: `pnpm check:codex-pin`. Exit 0 = in lockstep, 1 = drift.
// ──────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";

/** Read a required file, or die naming the file AND the fix.
 *
 *  Every path this gate reads can legitimately be ABSENT, and a bare
 *  readFileSync turns each into an ENOENT stack trace whose top frame is
 *  `node:fs` — a CI failure that names the wrong cause, which is the exact
 *  anti-pattern the exports-map note below is about. The generated/ directory in
 *  particular goes missing for a mundane reason: codegen-codex.mjs WIPES it
 *  before regenerating, so any failure mid-run (no cargo, no OpenSSL headers, a
 *  network drop during the sparse clone) leaves the tree in precisely this state.
 *  Restore with `git checkout -- src/engine/agents/adapters/codex/generated/`. */
function readOrDie(path, whatItIs, fix) {
  if (!existsSync(path)) {
    console.error(`✖ check:codex-pin — ${whatItIs} is missing:\n  ${path}\n\nFix: ${fix}`);
    process.exit(1);
  }
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    console.error(
      `✖ check:codex-pin — ${whatItIs} could not be read:\n  ${path}\n  ${e.message}\n\nFix: ${fix}`,
    );
    process.exit(1);
  }
}

// Read the installed manifest BY PATH, not via `require("@openai/codex/package.json")`.
// That form works today only because @openai/codex happens to ship no `exports`
// map — the moment it gains one (as @anthropic-ai/claude-agent-sdk and
// @cursor/sdk already have), Node throws ERR_PACKAGE_PATH_NOT_EXPORTED and this
// gate dies with an unhandled exception instead of reporting drift. A version
// check that crashes on the vendor change it exists to catch is worse than no
// check: the CI failure names the wrong cause.
const installed = JSON.parse(
  readOrDie(
    "node_modules/@openai/codex/package.json",
    "the installed @openai/codex manifest",
    "run `pnpm install` (it is a production dependency).",
  ),
).version;
const pinned = JSON.parse(
  readOrDie("package.json", "the repo manifest", "run this from the repo root."),
).codexProtocolVersion;
const generated = readOrDie(
  "src/engine/agents/adapters/codex/generated/.version",
  "the generated-bindings version stamp",
  "run `pnpm codegen:codex` (needs a Rust toolchain), or restore the committed " +
    "bindings with `git checkout -- src/engine/agents/adapters/codex/generated/` " +
    "if a codegen run failed partway and left the directory wiped.",
)
  .split("\n")
  .map((l) => l.trim())
  .find((l) => l && !l.startsWith("//") && !l.startsWith("#"));

if (installed === pinned && pinned === generated) {
  console.log(`✓ check:codex-pin — installed = pin = bindings = ${installed}`);
  process.exit(0);
}

console.error("✖ check:codex-pin — the Codex protocol triple is out of sync:");
console.error(`  • installed @openai/codex     : ${installed}`);
console.error(`  • package.json codexProtocol  : ${pinned}`);
console.error(`  • generated/.version          : ${generated}`);
console.error(
  "\nFix: run `pnpm codegen:codex` to regenerate the bindings against the installed Codex, then commit src/engine/agents/adapters/codex/generated/ + the updated pin.",
);
process.exit(1);
