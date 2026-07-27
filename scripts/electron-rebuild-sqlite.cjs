#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Make the better-sqlite3 native binding match Electron's ABI — reliably.
// ──────────────────────────────────────────────────────────
//
// WHY this script exists (and why plain `electron-rebuild --only better-sqlite3`
// is NOT enough):
//
//   • The Electron MAIN process opens the workspace DB in-process via
//     better-sqlite3 (electron/ipc/commands/git.ts → src/engine/git/state.ts
//     → src/engine/db/sqlite.ts). So the binding MUST be compiled for
//     Electron's ABI (NODE_MODULE_VERSION 130 on Electron 33), NOT the host
//     Node's (127 on Node 22). If it isn't, the FIRST DB open throws
//     "NODE_MODULE_VERSION 127 … requires 130", which the user sees as
//     "Couldn't create workspace".
//
//   • Every `pnpm install` / `pnpm rebuild` runs under Node and drops a
//     Node-ABI binary via better-sqlite3's `prebuild-install` — and crucially
//     does NOT regenerate `build/config.gypi`, so config.gypi keeps claiming
//     `runtime: electron` even though the actual .node is now a Node build.
//     (Verified: config.gypi is a LYING signal; never trust it.)
//
//   • Plain `electron-rebuild --only better-sqlite3` then NO-OPS — its build
//     cache decides the module is "already built" and skips the compile — or,
//     with --force but without --build-from-source, pulls the wrong-runtime
//     prebuild again. Either way the stale Node-ABI binary survives and the
//     app stays broken even though the command prints "✔ Rebuild Complete".
//
// Therefore:
//   • The ONLY trustworthy "is it already correct?" check is to actually load
//     the binding under Electron (ELECTRON_RUN_AS_NODE) and see if it imports.
//   • The ONLY reliable rebuild is `--force --build-from-source`, which forces
//     a node-gyp compile against Electron's headers and never swaps in a
//     prebuilt binary.
//
// Fast path: if the binding already loads under Electron we skip the (~5–8s)
// compile, so steady-state `pnpm electron:dev` restarts stay quick. The slow
// path only runs after an install/rebuild has clobbered the ABI.

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const electronBin = path.join(root, "node_modules", ".bin", "electron");
const rebuildBin = path.join(root, "node_modules", ".bin", "electron-rebuild");

/** True iff better-sqlite3's native binding loads cleanly under Electron's ABI.
 *  This is the definitive check — it dlopens the real .node the app will load.
 *  A throw here (ABI mismatch, missing binary, anything) means we must rebuild.
 *
 *  NOTE: it CONSTRUCTS a Database, not just `require()`s the module.
 *  better-sqlite3 loads its native addon LAZILY on the first `new Database()`
 *  (lib/database.js), so a bare `require('better-sqlite3')` never touches the
 *  binding and would "succeed" even on a wrong-ABI build — masking the very
 *  failure we're guarding against (the app dies at `new BetterSqlite3(file)`
 *  in src/engine/db/sqlite.ts, i.e. construction). An in-memory DB forces the
 *  dlopen without creating any file. */
function loadsUnderElectron() {
  try {
    execFileSync(
      electronBin,
      ["-e", "new (require('better-sqlite3'))(':memory:').close()"],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    return true;
  } catch {
    return false;
  }
}

if (loadsUnderElectron()) {
  console.log(
    "[electron:rebuild] better-sqlite3 already matches Electron's ABI — skipping rebuild.",
  );
  process.exit(0);
}

console.log(
  "[electron:rebuild] better-sqlite3 ABI mismatch — rebuilding from source for Electron…",
);
// --force: ignore the (untrustworthy) build cache.
// --build-from-source: never accept a prebuilt binary; compile against
//                       Electron's headers so the ABI is guaranteed correct.
// No --version: electron-rebuild auto-detects the installed Electron, so this
//               stays correct across Electron bumps.
execFileSync(
  rebuildBin,
  ["--force", "--build-from-source", "--only", "better-sqlite3"],
  { cwd: root, stdio: "inherit" },
);
console.log("[electron:rebuild] better-sqlite3 rebuilt for Electron.");
