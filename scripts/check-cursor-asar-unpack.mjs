#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-cursor-asar-unpack — keep electron-builder.yml's asarUnpack list in
// sync with @cursor/sdk's ACTUAL require() closure.
// ──────────────────────────────────────────────────────────
//
// The Cursor SDK host (cursor-host.cjs) runs under ELECTRON_RUN_AS_NODE, which
// DISABLES Electron's asar support — so @cursor/sdk and every package it
// require()s at runtime must live OUTSIDE asar (plain Node can't read modules
// from inside the archive). electron-builder.yml carries that allowlist as a
// hand-maintained set of `**/node_modules/<pkg>/**/*` globs, which drifts:
//   • MISSING — @cursor/sdk pulls a package that NO glob covers. In a packaged
//     build plain Node throws MODULE_NOT_FOUND and Cursor is dead in the shipped
//     DMG with no dev-time signal (the unit tests mock the transport). HARD
//     ERROR (exit 1).
//   • STALE   — a package is allowlisted but not in the closure. Harmless (a few
//     extra unpacked files), and some are kept on purpose for deps require()d
//     only on code paths this loader doesn't hit (auth/run). WARNING (exit 0).
//
// Source of truth: the live require.cache after `require("@cursor/sdk")`. The
// SDK loads sqlite3 (+ its bindings/file-uri-to-path native chain) and undici at
// module top-level, so a plain load already surfaces the native-adjacent deps
// that matter most. This mirrors how the packaged host loads the SDK.
//
// This does NOT replace a packaged-build smoke (a lazy require() during an
// authenticated agent run could still surface a new package) — see
// scripts/cursor-host-smoke.mjs. It closes the common, silent drift cheaply.
//
// Run: `node scripts/check-cursor-asar-unpack.mjs` (or `pnpm check:cursor-asar`).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YML = path.join(ROOT, "electron-builder.yml");

// Allowlisted-but-unused on purpose: deps @cursor/sdk only require()s lazily on
// paths a bare load doesn't hit (schema validation, telemetry, the agent run),
// plus node-pty which is unpacked for the SEPARATE PTY host. Keeps the STALE
// warning meaningful instead of noisy. Add with a reason; don't blanket-ignore.
const ALLOW_UNUSED = new Set([
  "node-pty", // PTY host (apps/desktop/src/engine/pty/pty-host.cjs), not Cursor
  "@statsig", // SDK telemetry — flushed lazily on a real run
  "ajv", // response-schema validation — lazy
  "ajv-formats",
  "json-schema-traverse",
  "fast-deep-equal",
  "fast-uri",
  "uri-js",
  "require-from-string",
  // ── added at @cursor/sdk 1.0.26 ──
  // 1.0.26 stopped loading these at module top-level, so a bare require() of the
  // SDK no longer puts them in require.cache and they read as STALE here. They are
  // still production dependencies, so keeping their globs is correct and dropping
  // them would be MODULE_NOT_FOUND on a lazy require() in the packaged app:
  "undici", // @cursor/sdk → @connectrpc/connect-node 1.7.0 → undici 5.29.0
  "@fastify", // …→ undici 5.29.0 → @fastify/busboy 2.1.1 (multipart bodies)
  // Native-addon .node resolution. These were listed for `sqlite3`, which 1.0.26
  // dropped, but both are production deps of better-sqlite3 — the engine's own
  // store — so they outlive it. Verify with `pnpm why bindings`.
  "bindings",
  "file-uri-to-path",
]);

/** Top-level package key for a node_modules path segment: `@scope` for scoped
 *  packages (the glob unpacks the whole scope), else the package name. */
function keyOf(name) {
  return name.startsWith("@") ? name.split("/")[0] : name;
}

/** The set of `<pkg>` keys the asarUnpack globs cover. Bounded to the
 *  asarUnpack: block so unrelated `node_modules/...` mentions don't leak in. */
function readUnpackKeys() {
  const lines = fs.readFileSync(YML, "utf8").split("\n");
  const start = lines.findIndex((l) => /^asarUnpack:\s*$/.test(l));
  if (start === -1) throw new Error("asarUnpack: block not found in electron-builder.yml");
  const keys = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // next top-level key → end of block
    const m = /node_modules\/(@[^/]+|[^/]+)\//.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/** @cursor/sdk's runtime require() closure, as top-level package keys. Resolved
 *  from the repo root so it's the SHIPPED copy, not a globally-installed one. */
function readSdkClosure() {
  const require = createRequire(path.join(ROOT, "package.json"));
  try {
    require("@cursor/sdk");
  } catch (err) {
    console.error(`✗ could not load @cursor/sdk to compute its closure: ${err.message}`);
    console.error("  (is it installed? run pnpm install)");
    process.exit(2);
  }
  const keys = new Set();
  for (const p of Object.keys(require.cache)) {
    const segs = p.split("/node_modules/");
    if (segs.length < 2) continue;
    const parts = segs[segs.length - 1].split("/");
    const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    keys.add(keyOf(name));
  }
  return keys;
}

const unpack = readUnpackKeys();
const closure = readSdkClosure();

const missing = [...closure].filter((k) => !unpack.has(k)).sort();
const stale = [...unpack].filter((k) => !closure.has(k) && !ALLOW_UNUSED.has(k)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(
    `✓ asarUnpack in sync — @cursor/sdk's ${closure.size}-package load closure is fully covered.`,
  );
  process.exit(0);
}

if (stale.length > 0) {
  console.warn(`\n⚠  ${stale.length} asarUnpack glob(s) not in @cursor/sdk's load closure (stale):`);
  for (const k of stale) console.warn(`     "**/node_modules/${k}/**/*"`);
  console.warn(`   Drop them from electron-builder.yml, or add to ALLOW_UNUSED with a reason.`);
}

if (missing.length > 0) {
  console.error(`\n✗ ${missing.length} package(s) in @cursor/sdk's require() closure but NOT asar-unpacked`);
  console.error(`  (these MODULE_NOT_FOUND in a packaged build — Cursor dies in the shipped app):`);
  for (const k of missing) console.error(`     "**/node_modules/${k}/**/*"`);
  console.error(`\n  Add the glob(s) to asarUnpack in electron-builder.yml.`);
  process.exit(1);
}

process.exit(0);
