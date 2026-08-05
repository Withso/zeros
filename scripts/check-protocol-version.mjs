#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-protocol-version — remind to bump PROTOCOL_VERSION when the wire changes
// ──────────────────────────────────────────────────────────
//
// The engine serves desktop and optional cloud clients over @zeros/protocol's wire
// contract. Version skew can happen between separately-built clients, and the
// handshake only protects you if PROTOCOL_VERSION actually changed when a
// message shape did. This ADVISORY guard flags the case where a wire message
// file changed vs origin/main but packages/protocol/src/version.ts PROTOCOL_VERSION
// did NOT — a prompt to think, not a precise gate (the file-touch heuristic is
// coarse on purpose). Wired continue-on-error. Needs origin/main fetched; if
// absent, it no-ops.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { protocolSourceSignature } from "./protocol-source-signature.mjs";

const SCHEMA_FILES = [
  "packages/protocol/src/messages.ts",
  "packages/protocol/src/agent-events.ts",
  "packages/protocol/src/agent-messages.ts",
  "packages/protocol/src/schemas.ts",
];
const VERSION_FILE = "packages/protocol/src/version.ts";
const LEGACY_PACKAGE_DIR = "packages/core/";
const PACKAGE_DIR = "packages/protocol/";

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

function pathAtRef(ref, file) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${file}`], {
      stdio: "ignore",
    });
    return file;
  } catch {
    // Keep the guard useful across the one-time core → protocol package rename.
    // Once origin/main contains the new path, this fallback becomes dormant.
    return file.startsWith(PACKAGE_DIR)
      ? file.replace(PACKAGE_DIR, LEGACY_PACKAGE_DIR)
      : file;
  }
}

function changedVsMain(file) {
  try {
    const base = execFileSync(
      "git",
      ["show", `origin/main:${pathAtRef("origin/main", file)}`],
      { encoding: "utf8" },
    );
    return (
      protocolSourceSignature(base) !==
      protocolSourceSignature(readFileSync(file, "utf8"))
    );
  } catch {
    return false;
  }
}

function protocolVersion(ref) {
  const src = ref
    ? execFileSync("git", ["show", `${ref}:${pathAtRef(ref, VERSION_FILE)}`], {
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
