#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// cursor-host-smoke — end-to-end "does the Cursor SDK host actually load?" check
// ──────────────────────────────────────────────────────────
//
// Spawns the real cursor-host.cjs subprocess exactly as the engine does, then
// drives a minimal protocol round-trip and asserts the host came up and served
// requests WITHOUT a module-resolution failure. This is the guard the PR review
// asked for: the host runs under ELECTRON_RUN_AS_NODE (asar disabled), so a
// transitive dep missing from electron-builder.yml's asarUnpack list becomes a
// runtime MODULE_NOT_FOUND that unit tests (which mock the transport) can't see.
//
// What it proves:
//   • `ready` (not `fatal`) ⇒ require(@cursor/sdk) succeeded, which eagerly
//     pulls the SDK and its runtime dependencies without a module error.
//   • store.open exercises the JsonlLocalAgentStore path used by the app (the
//     SDK's node:sqlite default requires Node >=22.13, while Electron 33 runs
//     Node 20); models.list exercises the undici fetch path.
//     Their responses needn't
//     SUCCEED (a bad/empty key is fine) — only resolve their modules.
//   • stderr is scanned for "Cannot find module" / MODULE_NOT_FOUND.
//
// Dev:   `node scripts/cursor-host-smoke.mjs`  (or `pnpm cursor:smoke`)
// Packaged app — point it at the shipped resources (the real verification):
//   ZEROS_CURSOR_HOST_SCRIPT=/Applications/Zeros.app/Contents/Resources/cursor-host.cjs \
//   ZEROS_PTY_HOST_RUNTIME=/Applications/Zeros.app/Contents/MacOS/Zeros \
//   ZEROS_PTY_HOST_RUNTIME_ELECTRON=1 \
//   ZEROS_CURSOR_SDK_ENTRY=/Applications/Zeros.app/Contents/Resources/app.asar.unpacked/.../@cursor/sdk/dist/cjs/index.js \
//   node scripts/cursor-host-smoke.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20000;
const MODULE_ERR_RX = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i;

const script =
  process.env.ZEROS_CURSOR_HOST_SCRIPT ||
  path.join(ROOT, "src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs");
if (!existsSync(script)) {
  console.error(`✗ cursor-host script not found: ${script}`);
  console.error("  Set ZEROS_CURSOR_HOST_SCRIPT (packaged app) or run from the repo.");
  process.exit(2);
}
const cmd = process.env.ZEROS_PTY_HOST_RUNTIME || "node";
const env = { ...process.env };
if (process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1") env.ELECTRON_RUN_AS_NODE = "1";

console.log(`▸ host:    ${script}`);
console.log(`▸ runtime: ${cmd}${env.ELECTRON_RUN_AS_NODE ? " (ELECTRON_RUN_AS_NODE)" : ""}`);
console.log(`▸ sdk:     ${process.env.ZEROS_CURSOR_SDK_ENTRY || "@cursor/sdk (default resolution)"}\n`);

const child = spawn(cmd, [script], { stdio: ["pipe", "pipe", "pipe"], env });

let stderr = "";
let outBuf = "";
let ready = false;
let fatal = null;
const got = new Set();
const tmp = path.join(os.tmpdir(), `cursor-host-smoke-${process.pid}`);

function send(obj) {
  if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n");
}

function finish(passed, reason) {
  clearTimeout(timer);
  try { child.kill("SIGTERM"); } catch {}
  const moduleErr = MODULE_ERR_RX.test(stderr);
  const ok = passed && !moduleErr && !fatal;
  console.log("");
  if (ok) {
    console.log(`✓ PASS — host loaded and served (ready, JSONL store.open + models.list resolved, no module errors).`);
  } else {
    console.error(`✗ FAIL — ${reason || "host did not come up cleanly"}.`);
    if (fatal) console.error(`  fatal: ${fatal}`);
    if (moduleErr) {
      console.error(`  A module failed to resolve — a transitive @cursor/sdk dep is missing from`);
      console.error(`  electron-builder.yml asarUnpack. Offending stderr line(s):`);
      for (const l of stderr.split("\n").filter((l) => MODULE_ERR_RX.test(l))) {
        console.error(`    ${l.trim()}`);
      }
    }
    if (stderr.trim() && !moduleErr) console.error(`  stderr:\n${stderr.split("\n").map((l) => "    " + l).join("\n")}`);
  }
  process.exit(ok ? 0 : 1);
}

const timer = setTimeout(
  () => finish(false, `timed out after ${TIMEOUT_MS}ms (ready=${ready}, responses=${[...got].join(",") || "none"})`),
  TIMEOUT_MS,
);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  outBuf += chunk;
  let nl = outBuf.indexOf("\n");
  while (nl !== -1) {
    const line = outBuf.slice(0, nl);
    outBuf = outBuf.slice(nl + 1);
    nl = outBuf.indexOf("\n");
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.k === "ready") {
      ready = true;
      send({ k: "req", id: 1, op: "store.open", args: { workspaceRef: tmp, stateRoot: tmp } });
      send({ k: "req", id: 2, op: "models.list", args: { opts: { apiKey: "sk-smoke-invalid" } } });
    } else if (m.k === "fatal") {
      fatal = m.message || "(no message)";
      finish(false, "host emitted fatal at load");
    } else if (m.k === "res") {
      got.add(m.id);
      // Responses may be ok:false (invalid key / no backing store) — that's fine;
      // it still proves the module resolved and the op dispatched.
      if (got.has(1) && got.has(2)) finish(true);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => { stderr += c; });
child.on("error", (err) => finish(false, `could not spawn runtime "${cmd}": ${err.message}`));
child.on("exit", (code) => {
  if (!ready) finish(false, `host exited (code ${code}) before signalling ready`);
});
