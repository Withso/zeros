#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// cursor-host-smoke — end-to-end "does the Cursor SDK host actually work?" check
// ──────────────────────────────────────────────────────────
//
// Spawns the real cursor-host.cjs subprocess exactly as the engine does, then
// drives a minimal protocol round-trip and asserts the host came up and served
// requests WITHOUT a module-resolution failure or a runtime-capability failure.
//
// RUN IT UNDER THE RUNTIME THAT SHIPS (`--electron`).
// This gate existed before and was green while Cursor was completely dead in
// the shipped app, because it only ever ran under plain `node`:
//
//   • The engine spawns this host under the ELECTRON binary
//     (electron/sidecar.ts sets ZEROS_PTY_HOST_RUNTIME=process.execPath +
//     ELECTRON_RUN_AS_NODE=1). Electron 33 bundles Node 20.18.
//   • @cursor/sdk 1.0.26's default local store needs the `node:sqlite` builtin,
//     which landed in Node 22.5 — so it exists on every CI runner's Node and on
//     NO Electron 33. `pnpm cursor:smoke` passed; the DMG threw on every
//     Agent.create.
//
// A runtime the app never uses cannot prove the app works. `--electron` runs
// the host under the repo's own Electron binary, which is the runtime the
// packaged app ships.
//
// What it proves:
//   • `ready` (not `fatal`) ⇒ require(@cursor/sdk) succeeded, which pulls the
//     native binding chain + undici — the packages most likely to be missing
//     from electron-builder.yml's asarUnpack list.
//   • store.open must return a NON-NULL storeId. It previously accepted
//     ok:false ("no backing store is fine"), which made the assertion vacuous
//     the day @cursor/sdk stopped exporting SqliteLocalAgentStore.
//   • agent.create exercises the local-store construction path — the one that
//     broke. Its response is EXPECTED to be ok:false (the key is bogus), but
//     the error must be an auth/network error, not a runtime-capability error:
//     a missing node:sqlite surfaces here, and so does the misleading
//     `Cannot access 'n' before initialization` TDZ that the SDK reports on
//     every attempt after the first.
//   • models.list exercises the undici fetch path.
//   • stderr is scanned for module + runtime errors too.
//
// CURATED MODEL IDS (opt-in — needs a key)
// Cursor resolves its catalog SERVER-SIDE: neither `composer-2.5` nor
// `grok-4.5` appears anywhere in @cursor/sdk, so unlike Claude (binary string
// table) and Codex (`model/list` over the app-server), there is no offline
// source of truth to check curated ids against. `Cursor.models.list` is the
// only authority and it needs a real API key.
//
// So: when CURSOR_API_KEY is set, this also asserts every curated cursor id in
// catalogs/models-v1.json is one the account actually offers. Without it the
// check SKIPS — loudly, never silently — and `--require-models` turns that skip
// into a failure so a scheduled job holding the secret cannot quietly degrade
// into testing nothing. Same trap agent-smoke.mjs's `--require` exists for.
//
// The env var is the ONLY source. The app's own store (`<userData>/secrets.json`,
// which agent-smoke.mjs reaches via ZEROS_SECRETS_FILE) holds safeStorage-
// ENCRYPTED values that only Electron can decrypt — see resolveCursorKey().
//
// A network failure yields a NetworkError, which is NOT a runtime error, so an
// offline runner degrades to a pass rather than a false red — deliberately, so
// this gate never becomes the one someone wraps in continue-on-error.
//
// Dev:      `node scripts/cursor-host-smoke.mjs`            (source/dev runtime)
// Shipped:  `node scripts/cursor-host-smoke.mjs --electron` (packaged runtime)
// Packaged app — point it at the shipped resources (the strongest check):
//   ZEROS_CURSOR_HOST_SCRIPT=/Applications/Zeros.app/Contents/Resources/cursor-host.cjs \
//   ZEROS_PTY_HOST_RUNTIME=/Applications/Zeros.app/Contents/MacOS/Zeros \
//   ZEROS_PTY_HOST_RUNTIME_ELECTRON=1 \
//   ZEROS_CURSOR_SDK_ENTRY=/Applications/Zeros.app/Contents/Resources/app.asar.unpacked/.../@cursor/sdk/dist/cjs/index.js \
//   node scripts/cursor-host-smoke.mjs

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 30000;
const MODULE_ERR_RX = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i;
// The runtime-capability failures this gate exists to catch. The TDZ pattern is
// here because it is what the SDK actually reports once its first store load
// has failed — the real cause appears only on the very first attempt in a host
// process, and this host is long-lived and shared by every session.
const RUNTIME_ERR_RX =
  /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|NoSqliteDriverError|Cannot access '.+?' before initialization/i;

const useElectron = process.argv.includes("--electron");
const requireModels = process.argv.includes("--require-models");

/** A real Cursor key, if this environment has one — from the environment ONLY.
 *
 *  Deliberately NOT read from the app's secret store: `<userData>/secrets.json`
 *  is JSON, but every value in it is a `safeStorage.encryptString(...)` base64
 *  blob (electron/secret-store.ts), decryptable only inside Electron with the
 *  OS keychain. The engine itself never decrypts it — `secret-account` probes
 *  check key PRESENCE and nothing else, on purpose. A script that JSON.parsed
 *  that file would hand an encrypted blob to models.list and report a bogus
 *  auth failure, so the store is not a key source here at all. */
function resolveCursorKey() {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  return fromEnv ? { key: fromEnv, from: "CURSOR_API_KEY" } : null;
}

/** Assertion failures collected from responses, reported together by finish().
 *  Declared up here rather than with the other per-run state because
 *  curatedCursorIds() below pushes to it — a `const` read from a function must
 *  not sit in its own TDZ if that function is ever called earlier than today. */
const problems = [];

/** Curated cursor ids the account must still offer, or `null` when the catalog
 *  could not be read at all.
 *
 *  Never a silent `[]`: an unreadable catalog and an empty one both make the
 *  comparison below vacuous, and a gate that compares nothing has to say so
 *  rather than printing "verified". `null` keeps "we could not look" reportable
 *  as its own cause instead of masquerading as "nothing to check". */
function curatedCursorIds() {
  try {
    const cat = JSON.parse(
      readFileSync(path.join(ROOT, "catalogs", "models-v1.json"), "utf-8"),
    );
    return (cat.families?.cursor ?? []).map((m) => m.value).filter(Boolean);
  } catch (err) {
    problems.push(`could not read catalogs/models-v1.json: ${err?.message ?? err}`);
    return null;
  }
}

const cursorKey = resolveCursorKey();

/** The repo's own Electron binary — `require("electron")` resolves to the
 *  absolute path of the platform binary the packaged app ships. */
function resolveElectronBinary() {
  try {
    const p = createRequire(import.meta.url)("electron");
    if (typeof p === "string" && p.length > 0 && existsSync(p)) return p;
  } catch {
    /* not installed / no binary staged */
  }
  return null;
}

const script =
  process.env.ZEROS_CURSOR_HOST_SCRIPT ||
  path.join(ROOT, "src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs");
if (!existsSync(script)) {
  console.error(`✗ cursor-host script not found: ${script}`);
  console.error("  Set ZEROS_CURSOR_HOST_SCRIPT (packaged app) or run from the repo.");
  process.exit(2);
}

let cmd = process.env.ZEROS_PTY_HOST_RUNTIME || "node";
let asNode = process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1";
if (useElectron && !process.env.ZEROS_PTY_HOST_RUNTIME) {
  const bin = resolveElectronBinary();
  if (!bin) {
    // A hard failure, never a skip: --electron was asked for precisely because
    // the other runtime cannot prove anything about the shipped app.
    console.error("✗ --electron: could not resolve the Electron binary from node_modules.");
    console.error("  Run `pnpm install` (electron's postinstall stages the binary), or set");
    console.error("  ZEROS_PTY_HOST_RUNTIME to an Electron binary explicitly.");
    process.exit(2);
  }
  cmd = bin;
  asNode = true;
}

if (requireModels && !cursorKey) {
  // Explicitly demanded, and impossible — fail NOW rather than after a green
  // run that verified no model ids at all.
  console.error("✗ --require-models: CURSOR_API_KEY is not set.");
  console.error("  Cursor's catalog is server-side, so there is no offline way to check");
  console.error("  curated ids. In CI, map a repo secret onto the step's env; locally,");
  console.error("  export it in your shell. The app's secrets.json will NOT work — its");
  console.error("  values are safeStorage-encrypted and only Electron can read them.");
  process.exit(2);
}

const env = { ...process.env };
if (asNode) env.ELECTRON_RUN_AS_NODE = "1";

console.log(`▸ host:    ${script}`);
console.log(`▸ runtime: ${cmd}${asNode ? " (ELECTRON_RUN_AS_NODE)" : ""}`);
console.log(`▸ sdk:     ${process.env.ZEROS_CURSOR_SDK_ENTRY || "@cursor/sdk (default resolution)"}\n`);

// A stable dir, not a pid-suffixed one: the state root the host derives from
// this cwd is reused across runs instead of littering a fresh tree each time.
const tmp = path.join(os.tmpdir(), "zeros-cursor-host-smoke");

const child = spawn(cmd, [script], { stdio: ["pipe", "pipe", "pipe"], env });

let stderr = "";
let outBuf = "";
let ready = false;
let fatal = null;
const got = new Map();
/** What the curated-model check managed to do, echoed on success. */
let modelNote = null;

function send(obj) {
  if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n");
}

function errText(m) {
  return (m && m.error && (m.error.message || m.error.name)) || "";
}

function finish(passed, reason) {
  clearTimeout(timer);
  try { child.kill("SIGTERM"); } catch {}
  const moduleErr = MODULE_ERR_RX.test(stderr);
  const runtimeErr = RUNTIME_ERR_RX.test(stderr);
  const ok = passed && !moduleErr && !runtimeErr && !fatal && problems.length === 0;
  console.log("");
  if (ok) {
    console.log("✓ PASS — host loaded and served: store.open returned a live store,");
    console.log("  agent.create reached auth (not a runtime failure), models.list resolved.");
    console.log(
      cursorKey
        ? `  Curated cursor model ids verified — ${modelNote}.`
        : "  Curated cursor model ids NOT verified: CURSOR_API_KEY is unset\n" +
          "  (pass --require-models to make that a failure instead of a skip).",
    );
  } else {
    console.error(`✗ FAIL — ${reason || "host did not come up cleanly"}.`);
    if (fatal) console.error(`  fatal: ${fatal}`);
    for (const p of problems) console.error(`  ${p}`);
    if (moduleErr) {
      console.error(`  A module failed to resolve — a transitive @cursor/sdk dep is missing from`);
      console.error(`  electron-builder.yml asarUnpack. Offending stderr line(s):`);
      for (const l of stderr.split("\n").filter((l) => MODULE_ERR_RX.test(l))) {
        console.error(`    ${l.trim()}`);
      }
    }
    if (runtimeErr) {
      console.error(`  The runtime lacks a capability @cursor/sdk needs. Offending stderr line(s):`);
      for (const l of stderr.split("\n").filter((l) => RUNTIME_ERR_RX.test(l))) {
        console.error(`    ${l.trim()}`);
      }
    }
    if (stderr.trim() && !moduleErr && !runtimeErr) {
      console.error(`  stderr:\n${stderr.split("\n").map((l) => "    " + l).join("\n")}`);
    }
  }
  process.exit(ok ? 0 : 1);
}

const timer = setTimeout(
  () => finish(false, `timed out after ${TIMEOUT_MS}ms (ready=${ready}, responses=${[...got.keys()].join(",") || "none"})`),
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
      // With a real key this doubles as the curated-id gate; without one it is
      // still the undici/fetch module-resolution probe it always was.
      send({
        k: "req",
        id: 2,
        op: "models.list",
        args: { opts: { apiKey: cursorKey?.key ?? "sk-smoke-invalid" } },
      });
      send({
        k: "req",
        id: 3,
        op: "agent.create",
        args: {
          apiKey: "key_smokesmokesmokesmokesmokesmoke",
          model: { id: "composer-1" },
          cwd: tmp,
          local: { cwd: tmp },
        },
      });
    } else if (m.k === "fatal") {
      fatal = m.message || "(no message)";
      finish(false, "host emitted fatal at load");
    } else if (m.k === "res") {
      got.set(m.id, m);
      if (m.id === 1) {
        // Must actually yield a store. `{storeId: null}` is the host's "no
        // store available" answer — it is what silently broke the adapter's
        // terminal-error recovery, so it fails here rather than passing.
        if (!m.ok) {
          problems.push(`store.open failed: ${errText(m) || "(no message)"}`);
        } else if (!m.result || m.result.storeId == null) {
          problems.push("store.open returned no store (storeId: null) — the host could not build a local agent store.");
        }
      }
      if (m.id === 2 && cursorKey) {
        // Only meaningful with a real key — a bogus one returns nothing, which
        // must not read as "every curated model was retired".
        if (!m.ok) {
          problems.push(`models.list failed with the ${cursorKey.from} key: ${errText(m) || "(no message)"}`);
        } else {
          const live = new Set(
            (Array.isArray(m.result) ? m.result : []).map((x) => x?.id).filter(Boolean),
          );
          if (live.size === 0) {
            problems.push(
              `models.list returned an empty catalog for the ${cursorKey.from} key — ` +
                "inconclusive, so the curated-id check could not run.",
            );
          } else {
            const curated = curatedCursorIds();
            // An empty curated list is a FAILURE, not a quiet no-op: the loop
            // below would compare nothing while finish() still printed
            // "Curated cursor model ids verified". Catches the family being
            // emptied AND its `value` key being renamed out from under the
            // mapping above — neither of which bumps any version number.
            if (curated?.length === 0) {
              problems.push(
                "catalogs/models-v1.json lists no cursor models — the curated-id check " +
                  "ran against nothing, so a green run here would prove nothing.",
              );
            }
            for (const id of curated ?? []) {
              if (!live.has(id)) {
                problems.push(
                  `curated cursor model "${id}" is NOT offered by this account ` +
                    `(live: ${[...live].join(", ")}). Cursor validates model picks, so ` +
                    `Agent.create will throw "Cannot use this model: ${id}" for every user. ` +
                    "Either it was retired (drop it from catalogs/models-v1.json, with its " +
                    "aliases and defaultFavorites) or renamed (update the id).",
                );
              }
            }
            // Report the COUNT, so the PASS line's "verified" is falsifiable at
            // a glance instead of an assertion the reader has to take on trust.
            modelNote =
              `all ${curated?.length ?? 0} curated id(s) present, of ${live.size} ` +
              `offered by the account (${cursorKey.from})`;
          }
        }
      }
      if (m.id === 3) {
        // Expected to fail on the bogus key. What must NOT happen is failing
        // for a runtime-capability reason before it ever reaches auth.
        const msg = errText(m);
        if (!m.ok && RUNTIME_ERR_RX.test(msg)) {
          problems.push(`agent.create hit a runtime failure, not auth: ${msg}`);
        }
      }
      if (got.has(1) && got.has(2) && got.has(3)) finish(true);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => { stderr += c; });
child.on("error", (err) => finish(false, `could not spawn runtime "${cmd}": ${err.message}`));
child.on("exit", (code) => {
  if (!ready) finish(false, `host exited (code ${code}) before signalling ready`);
});
