#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-preload-allowlist — keep electron/preload.ts ALLOWED_COMMANDS in sync
// with the main-process commands the renderer actually invokes.
// ──────────────────────────────────────────────────────────
//
// H1 narrowed the preload bridge so a renderer XSS can only reach an allowlist
// of commands. That list is hand-maintained, so it drifts two ways:
//   • MISSING  — the renderer calls a command that's NOT allowlisted. The call
//     is rejected at preload ("command not permitted") and the feature silently
//     breaks. This is the gap that shipped four broken browser/design-mode
//     commands. Treated as a HARD ERROR (exit 1).
//   • STALE    — a command is allowlisted but never invoked. It widens the
//     XSS-reachable surface H1 set out to shrink, so it is a HARD ERROR too.
//
// The preload gate is reachable ONLY via window.__ZEROS_NATIVE__.invoke, which
// the renderer always calls through the `nativeInvoke(...)` wrapper — so the
// set of command string-literals passed to nativeInvoke() IS the ground truth.
//
// Run: `node scripts/check-preload-allowlist.mjs` (or `pnpm check:preload`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = path.join(ROOT, "electron/preload.ts");
const SRC_DIR = path.join(ROOT, "src");

// Commands intentionally allowlisted ahead of their renderer call sites. Add a
// command here (with a comment) to silence the STALE warning on purpose; leave
// empty otherwise so the warning stays meaningful.
const ALLOW_UNINVOKED = new Set([]);

/** Pull the string literals out of `ALLOWED_COMMANDS = new Set<string>([ … ])`. */
function readAllowlist() {
  const src = fs.readFileSync(PRELOAD, "utf8");
  const anchor = src.indexOf("ALLOWED_COMMANDS");
  if (anchor === -1)
    throw new Error("ALLOWED_COMMANDS not found in electron/preload.ts");
  const open = src.indexOf("[", anchor);
  const close = src.indexOf("])", open);
  if (open === -1 || close === -1)
    throw new Error("could not bound the ALLOWED_COMMANDS array");
  const block = src
    .slice(open + 1, close)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "")) // strip line comments (they're quote-free, but be safe)
    .join("\n");
  const set = new Set();
  for (const m of block.matchAll(/["']([^"']+)["']/g)) set.add(m[1]);
  return set;
}

/** Recursively collect renderer source files (skip tests + type decls). */
function collectSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...collectSourceFiles(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|d)\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Map of command → list of `relpath:line` where nativeInvoke(command) appears.
 *  The `\s*` after `(` spans newlines, so multi-line calls (command literal on
 *  its own line) are matched too. */
function collectInvoked(files) {
  const sites = new Map();
  const re = /nativeInvoke\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g;
  // Real command names are static identifiers (e.g. "iframe:clear-cache"); this
  // rejects template artifacts like the wrapper's own `nativeInvoke("${cmd}")`
  // error string, whose `${cmd}` would otherwise look like an invoked command.
  const isCommandLiteral = (s) => /^[a-z][\w:-]*$/.test(s);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      const cmd = m[1];
      if (!isCommandLiteral(cmd)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const rel = path.relative(ROOT, file);
      if (!sites.has(cmd)) sites.set(cmd, []);
      sites.get(cmd).push(`${rel}:${line}`);
    }
  }
  return sites;
}

const allowed = readAllowlist();
const invokedSites = collectInvoked(collectSourceFiles(SRC_DIR));
const invoked = new Set(invokedSites.keys());

const missing = [...invoked].filter((c) => !allowed.has(c)).sort();
const stale = [...allowed]
  .filter((c) => !invoked.has(c) && !ALLOW_UNINVOKED.has(c))
  .sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(
    `✓ preload allowlist in sync — ${allowed.size} commands, all invoked from src/.`,
  );
  process.exit(0);
}

if (stale.length > 0) {
  console.error(
    `\n✗ ${stale.length} allowlisted command(s) never invoked from src/ (stale — widen XSS surface):`,
  );
  for (const c of stale) console.error(`     "${c}"`);
  console.error(
    `   Remove them from ALLOWED_COMMANDS, or add to ALLOW_UNINVOKED with a reason.`,
  );
}

if (missing.length > 0) {
  console.error(
    `\n✗ ${missing.length} command(s) invoked from src/ but MISSING from ALLOWED_COMMANDS`,
  );
  console.error(
    `  (these are rejected at the preload bridge — the feature silently breaks):`,
  );
  for (const c of missing) {
    console.error(`     "${c}"  ← ${invokedSites.get(c).join(", ")}`);
  }
  console.error(`\n  Add them to ALLOWED_COMMANDS in electron/preload.ts.`);
  process.exit(1);
}

// Stale-only is still a security failure.
process.exit(stale.length > 0 ? 1 : 0);
