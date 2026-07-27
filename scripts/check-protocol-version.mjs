#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-protocol-version — remind to bump PROTOCOL_VERSION when the wire changes
// ──────────────────────────────────────────────────────────
//
// The engine serves desktop and optional cloud clients over @zeros/core's wire
// contract. Version skew can happen between separately-built clients, and the
// handshake only protects you if PROTOCOL_VERSION actually changed when a
// message shape did. This ADVISORY guard flags the case where a wire message
// file changed vs origin/main but packages/core/src/version.ts PROTOCOL_VERSION
// did NOT — a prompt to think, not a precise gate (the file-touch heuristic is
// coarse on purpose). Wired continue-on-error. Needs origin/main fetched; if
// absent, it no-ops.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCHEMA_FILES = [
  "packages/core/src/messages.ts",
  "packages/core/src/agent-events.ts",
  "packages/core/src/agent-messages.ts",
  "packages/core/src/schemas.ts",
];
const VERSION_FILE = "packages/core/src/version.ts";

function mainAvailable() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function changedVsMain(file) {
  try {
    execFileSync("git", ["diff", "--quiet", "origin/main", "--", file], {
      stdio: "ignore",
    });
    return false; // exit 0 = no diff
  } catch (e) {
    return e.status === 1; // exit 1 = diff; other codes → treat as unchanged
  }
}

function protocolVersion(ref) {
  const src = ref
    ? execFileSync("git", ["show", `${ref}:${VERSION_FILE}`], {
        encoding: "utf8",
      })
    : readFileSync(VERSION_FILE, "utf8");
  return (src.match(/PROTOCOL_VERSION\s*=\s*(\d+)/) || [])[1] ?? null;
}

if (!mainAvailable()) {
  console.log(
    "ℹ check:protocol — origin/main unavailable; skipped (advisory).",
  );
  process.exit(0);
}

const touched = SCHEMA_FILES.filter(changedVsMain);
const bumped = protocolVersion("origin/main") !== protocolVersion(null);

if (touched.length > 0 && !bumped) {
  console.error(
    "⚠ check:protocol — wire message file(s) changed but PROTOCOL_VERSION was not bumped:",
  );
  for (const f of touched) console.error(`  • ${f}`);
  console.error(
    `\nIf you changed the WIRE SHAPE (added/removed/renamed/required-narrowed a field), bump PROTOCOL_VERSION in ${VERSION_FILE} so a version-skewed client rejects cleanly instead of mis-parsing. (Advisory — ignore if the change was wire-compatible.)`,
  );
  process.exit(1);
}
console.log(
  `✓ check:protocol — ${touched.length} wire file(s) changed vs origin/main${touched.length ? " (PROTOCOL_VERSION bumped)" : ""}; OK`,
);
