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

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const installed = require("@openai/codex/package.json").version;
const pinned = JSON.parse(readFileSync("package.json", "utf8")).codexProtocolVersion;
const generated = readFileSync(
  "src/engine/agents/adapters/codex/generated/.version",
  "utf8",
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
