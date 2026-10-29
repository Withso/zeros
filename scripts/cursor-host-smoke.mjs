#!/usr/bin/env node
// Exercise the real Cursor host under --electron to qualify the runtime the
// app ships: development Node can support capabilities Electron lacks.
// A ready handshake alone is insufficient; store.open must yield a store, and
// agent.create must reach authentication rather than fail on runtime capabilities.
// Without a key, a loopback backend rejects probe keys without remote retries.
// Live model discovery requires CURSOR_API_KEY; --require-models makes its absence
// fail. Required IDs must resolve; liveRequired compatibility rows can be absent,
// and level-free bases may resolve through a suffixed live variant.
// Environment keys are the only source: the app's safeStorage blobs need Electron.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { qualifiesAgainst } from "./cursor-curated-ids.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 30000;
const MODULE_ERR_RX =
  /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i;
// After its first store failure, the SDK can report only a TDZ error;
// include that symptom when diagnosing this long-lived host.
const RUNTIME_ERR_RX =
  /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE|NoSqliteDriverError|Cannot access '.+?' before initialization/i;

const useElectron = process.argv.includes("--electron");
const requireModels = process.argv.includes("--require-models");

/** The app's secret-store values are safeStorage ciphertext, not API keys;
 * only Electron with its OS keychain can decrypt them. */
function resolveCursorKey() {
  const fromEnv = process.env.CURSOR_API_KEY?.trim();
  return fromEnv ? { key: fromEnv, from: "CURSOR_API_KEY" } : null;
}

/** Initialize before curatedCursorModels can report a failure. */
const problems = [];

/** Keep unreadable (null) distinct from confirmed empty ([]); both leave
 * model coverage unproved and must be reported. */
function curatedCursorModels() {
  try {
    const cat = JSON.parse(
      readFileSync(path.join(ROOT, "catalogs", "models-v1.json"), "utf-8"),
    );
    return Array.isArray(cat.families?.cursor) ? cat.families.cursor : [];
  } catch (err) {
    problems.push(
      `could not read catalogs/models-v1.json: ${err?.message ?? err}`,
    );
    return null;
  }
}

const cursorKey = resolveCursorKey();

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
  path.join(
    ROOT,
    "apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
  );
if (!existsSync(script)) {
  console.error(`✗ cursor-host script not found: ${script}`);
  console.error(
    "  Set ZEROS_CURSOR_HOST_SCRIPT (packaged app) or run from the repo.",
  );
  process.exit(2);
}

let cmd = process.env.ZEROS_PTY_HOST_RUNTIME || "node";
let asNode = process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1";
if (useElectron && !process.env.ZEROS_PTY_HOST_RUNTIME) {
  const bin = resolveElectronBinary();
  if (!bin) {
    // An explicitly requested shipping runtime cannot fall back to a development-only proof.
    console.error(
      "✗ --electron: could not resolve the Electron binary from node_modules.",
    );
    console.error(
      "  Run `pnpm install` (electron's postinstall stages the binary), or set",
    );
    console.error("  ZEROS_PTY_HOST_RUNTIME to an Electron binary explicitly.");
    process.exit(2);
  }
  cmd = bin;
  asNode = true;
}

if (requireModels && !cursorKey) {
  console.error("✗ --require-models: CURSOR_API_KEY is not set.");
  console.error(
    "  Cursor's catalog is server-side, so there is no offline way to check",
  );
  console.error(
    "  curated ids. In CI, map a repo secret onto the step's env; locally,",
  );
  console.error(
    "  export it in your shell. The app's secrets.json will NOT work — its",
  );
  console.error(
    "  values are safeStorage-encrypted and only Electron can read them.",
  );
  process.exit(2);
}

const env = { ...process.env };
if (asNode) env.ELECTRON_RUN_AS_NODE = "1";

let smokeBackend = null;
if (!cursorKey) {
  smokeBackend = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        code: "unauthenticated",
        error: "invalid smoke key",
        message: "invalid smoke key",
      }),
    );
  });
  await new Promise((resolve, reject) => {
    smokeBackend.once("error", reject);
    smokeBackend.listen(0, "127.0.0.1", resolve);
  });
  env.CURSOR_BACKEND_URL = `http://127.0.0.1:${smokeBackend.address().port}`;
  env.NO_PROXY = [env.NO_PROXY || env.no_proxy, "127.0.0.1", "localhost"]
    .filter(Boolean)
    .join(",");
  env.no_proxy = env.NO_PROXY;
}

console.log(`▸ host:    ${script}`);
console.log(`▸ runtime: ${cmd}${asNode ? " (ELECTRON_RUN_AS_NODE)" : ""}`);
console.log(
  `▸ sdk:     ${process.env.ZEROS_CURSOR_SDK_ENTRY || "@cursor/sdk (default resolution)"}\n`,
);

// A stable dir, not a pid-suffixed one: the state root the host derives from
// this cwd is reused across runs instead of littering a fresh tree each time.
const tmp = path.join(os.tmpdir(), "zeros-cursor-host-smoke");

const child = spawn(cmd, [script], { stdio: ["pipe", "pipe", "pipe"], env });

let stderr = "";
let outBuf = "";
let ready = false;
let fatal = null;
const got = new Map();
let modelNote = null;

function send(obj) {
  if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n");
}

function errText(m) {
  return (m && m.error && (m.error.message || m.error.name)) || "";
}

function finish(passed, reason) {
  clearTimeout(timer);
  smokeBackend?.closeAllConnections();
  smokeBackend?.close();
  try {
    child.kill("SIGTERM");
  } catch { /* The host may already have exited. */ }
  const moduleErr = MODULE_ERR_RX.test(stderr);
  const runtimeErr = RUNTIME_ERR_RX.test(stderr);
  const ok =
    passed && !moduleErr && !runtimeErr && !fatal && problems.length === 0;
  console.log("");
  if (ok) {
    console.log(
      "✓ PASS — host loaded and served: store.open returned a live store,",
    );
    console.log(
      "  agent.create reached auth (not a runtime failure), models.list resolved.",
    );
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
      console.error(
        `  A module failed to resolve — a transitive @cursor/sdk dep is missing from`,
      );
      console.error(
        `  electron-builder.yml asarUnpack. Offending stderr line(s):`,
      );
      for (const l of stderr.split("\n").filter((l) => MODULE_ERR_RX.test(l))) {
        console.error(`    ${l.trim()}`);
      }
    }
    if (runtimeErr) {
      console.error(
        `  The runtime lacks a capability @cursor/sdk needs. Offending stderr line(s):`,
      );
      for (const l of stderr
        .split("\n")
        .filter((l) => RUNTIME_ERR_RX.test(l))) {
        console.error(`    ${l.trim()}`);
      }
    }
    if (stderr.trim() && !moduleErr && !runtimeErr) {
      console.error(
        `  stderr:\n${stderr
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")}`,
      );
    }
  }
  process.exit(ok ? 0 : 1);
}

const timer = setTimeout(
  () =>
    finish(
      false,
      `timed out after ${TIMEOUT_MS}ms (ready=${ready}, responses=${[...got.keys()].join(",") || "none"})`,
    ),
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
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.k === "ready") {
      ready = true;
      send({
        k: "req",
        id: 1,
        op: "store.open",
        args: { workspaceRef: tmp, stateRoot: tmp },
      });
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
        // A null store is unavailable, not a successful store.open.
        if (!m.ok) {
          problems.push(`store.open failed: ${errText(m) || "(no message)"}`);
        } else if (!m.result || m.result.storeId == null) {
          problems.push(
            "store.open returned no store (storeId: null) — the host could not build a local agent store.",
          );
        }
      }
      if (m.id === 2 && cursorKey) {
        // Only meaningful with a real key — a bogus one returns nothing, which
        // must not read as "every curated model was retired".
        if (!m.ok) {
          problems.push(
            `models.list failed with the ${cursorKey.from} key: ${errText(m) || "(no message)"}`,
          );
        } else {
          const live = new Set(
            (Array.isArray(m.result) ? m.result : [])
              .map((x) => x?.id)
              .filter(Boolean),
          );
          if (live.size === 0) {
            problems.push(
              `models.list returned an empty catalog for the ${cursorKey.from} key — ` +
                "inconclusive, so the curated-id check could not run.",
            );
          } else {
            const curated = curatedCursorModels();
            // Empty curated input must not turn the verification loop into a passing no-op.
            if (curated?.length === 0) {
              problems.push(
                "catalogs/models-v1.json lists no cursor models — the curated-id check " +
                  "ran against nothing, so a green run here would prove nothing.",
              );
            }
            let completed = 0;
            let optionalUnavailable = 0;
            for (const model of curated ?? []) {
              const id = model?.value;
              const usable = qualifiesAgainst(model, live);
              if (usable === "suffixed") completed++;
              if (usable === "optional-unavailable") {
                optionalUnavailable++;
                continue;
              }
              if (!usable) {
                problems.push(
                  `required curated cursor model "${String(id)}" is NOT offered by this account, and no ` +
                    `suffixed variant of it is either (live: ${[...live].join(", ")}). ` +
                    "Cursor validates model picks, so the pick resolves to nothing this " +
                    "account can run. Either it was retired (drop it from " +
                    "catalogs/models-v1.json, with its aliases and defaultFavorites) or " +
                    "renamed (update the id).",
                );
              }
            }
            // Report coverage counts and variant resolution so a passing claim is auditable.
            const required =
              curated?.filter((model) => model?.liveRequired !== true).length ??
              0;
            const optional = (curated?.length ?? 0) - required;
            modelNote =
              `all ${required} required curated id(s) resolvable, of ${live.size} ` +
              `offered by the account (${cursorKey.from})` +
              (optional
                ? `; ${optionalUnavailable}/${optional} account-qualified optional unavailable`
                : "") +
              (completed ? `; ${completed} via a suffixed variant` : "");
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
child.stderr.on("data", (c) => {
  stderr += c;
});
child.on("error", (err) =>
  finish(false, `could not spawn runtime "${cmd}": ${err.message}`),
);
child.on("exit", (code) => {
  if (!ready)
    finish(false, `host exited (code ${code}) before signalling ready`);
});
