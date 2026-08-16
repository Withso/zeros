#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Zeros Cursor host — a tiny Node subprocess that owns @cursor/sdk
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// The Zeros engine runs under **bun** (dev: `bun apps/desktop/src/cli.ts`; packaged: a
// bun-compiled standalone binary — see apps/desktop/electron/sidecar.ts). @cursor/sdk loads
// fine under bun, BUT the agent run that streams a turn rides
// `@connectrpc/connect-node`, which connects to Cursor's backend
// (api2.cursor.sh) over **node:http2** — and bun's node:http2 + TLS compat
// layer is broken against that endpoint:
//
//   • it mis-parses the server certificate's SubjectAltNames, so the handshake
//     dies with `ERR_TLS_CERT_ALTNAME_INVALID: Hostname/IP does not match
//     certificate's altnames: Cert does not contain a DNS name` — even though
//     the cert is a perfectly valid Amazon-issued cert with `DNS:api2.cursor.sh`
//     (Node accepts it; bun does not), and
//   • even with the cert check bypassed, ALPN negotiation flaps between "h2" and
//     `ERR_HTTP2_ERROR: h2 is not supported` (reproduced on bun 1.3.13; works
//     100% under Node).
//
// The symptom users saw was the misleading "couldn't establish a secure (TLS)
// connection to Cursor … HTTPS-inspecting software" toast — but it was never a
// proxy/antivirus issue: it was the bun runtime. Model discovery still worked
// because `Cursor.models.list` rides plain `fetch` (fine under bun); only the
// agent run (http2) failed, which is why the failure was always "prompt failed".
//
// The fix mirrors apps/desktop/src/engine/pty/pty-host.cjs (which exists for the identical
// "bun breaks node-pty I/O" reason): keep the engine on bun (it needs
// bun:sqlite + the Claude Agent SDK) but run the actual @cursor/sdk calls in
// this Node subprocess, where http2 works. The engine drives it over stdio.
//
// PROTOCOL (newline-delimited JSON, one object per line)
//   engine → host (this process's stdin):
//     {"k":"req","id":1,"op":"agent.create","args":{...opts}}
//     {"k":"req","id":2,"op":"agent.resume","args":{"agentId":"…","opts":{…}}}
//     {"k":"req","id":3,"op":"agent.list","args":{"opts":{…}}}
//     {"k":"req","id":4,"op":"agent.send","args":{"agentId":"…","message":{…},"options":{…}}}
//     {"k":"req","id":5,"op":"agent.close","args":{"agentId":"…"}}
//     {"k":"req","id":6,"op":"run.wait","args":{"runId":"…"}}
//     {"k":"req","id":7,"op":"run.cancel","args":{"runId":"…"}}
//     {"k":"req","id":8,"op":"models.list","args":{"opts":{…}}}
//     {"k":"req","id":9,"op":"store.open","args":{"workspaceRef":"…","stateRoot":"…"}}
//     {"k":"req","id":10,"op":"store.runGet","args":{"storeId":"…","agentId":"…","runId":"…"}}
//     {"k":"req","id":11,"op":"store.dispose","args":{"storeId":"…"}}
//   host → engine (this process's stdout):
//     {"k":"ready"}                                          (once, on startup)
//     {"k":"fatal","message":"…"}                            (@cursor/sdk unloadable)
//     {"k":"res","id":N,"ok":true,"result":<any>}
//     {"k":"res","id":N,"ok":false,"error":{"message","name","status","code"}}
//     {"k":"ev","ev":"run.msg","runId":"…","msg":<any>}      (one per stream item)
//     {"k":"ev","ev":"run.streamEnd","runId":"…"}            (stream completed)
//     {"k":"ev","ev":"run.streamError","runId":"…","error":{…}}
//
// `agent.send` returns {runId, sdkRunId}: `runId` is OUR opaque handle for the
// run (used by run.wait/run.cancel + the stream events); `sdkRunId` is the
// SDK's own run id, forwarded so the engine can look the run up in the local
// agent store for error recovery (CursorLocalStore). The host begins draining
// `run.stream()` eagerly the moment the run is created and forwards every item
// as a `run.msg` event, so no items are lost between `send` and the engine
// reading the stream.
//
// stdout is RESERVED for the protocol — this process must never console.log.
// Diagnostics go to stderr, which the engine forwards to its log.
// ──────────────────────────────────────────────────────────

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// @cursor/sdk wires several AbortSignal listeners per run (its connect-node
// HTTP/2 client + tool/subagent plumbing) onto a single shared signal — ~11 on
// a turn that spawns subagents. Node's default cap is 10, so it prints a
// spurious `MaxListenersExceededWarning: 11 abort listeners added to
// [AbortSignal]`. It's not a leak (the listeners are torn down with the run),
// just over the default threshold. Raise the per-EventTarget default at startup
// (covers signals the SDK creates afterward) so the warning never fires.
try {
  const events = require("node:events");
  // setMaxListeners(n) with no targets sets the default for newly-created
  // EventTargets + EventEmitters (Node ≥ 19); also bump the EventEmitter
  // default for older runtimes. Both are best-effort.
  if (typeof events.setMaxListeners === "function") events.setMaxListeners(64);
  if (events.EventEmitter) events.EventEmitter.defaultMaxListeners = 64;
} catch {
  /* non-fatal — the warning is cosmetic */
}

// @cursor/sdk location: the engine passes an absolute path
// (ZEROS_CURSOR_SDK_ENTRY) resolved to the package's CJS entry — in a packaged
// app that's the app.asar.unpacked copy (its require closure reaches native
// bindings that can't be dlopen'd from inside asar — see electron-builder.yml's
// asarUnpack list, kept honest by `pnpm check:cursor-asar`). When unset (engine
// run from source with no Electron host) fall back to ordinary module
// resolution, which walks up to the repo node_modules.
const sdkEntry = process.env.ZEROS_CURSOR_SDK_ENTRY;
let sdk;
try {
  // Two branches on purpose: the env-path branch lets the engine hand us an
  // absolute, asar-unpacked entry in a packaged app; the literal-specifier
  // branch is a STATIC `require("@cursor/sdk")` that (a) resolves via the normal
  // node_modules walk in source/dev mode and (b) can be statically bundled by
  // esbuild/tsup if a future build inlines the SDK into this host. Don't fold
  // them into one `require(<ternary>)` — that would defeat static bundling.
  sdk =
    sdkEntry && sdkEntry.length > 0
      ? require(sdkEntry)
      : require("@cursor/sdk");
} catch (err) {
  try {
    process.stdout.write(
      JSON.stringify({
        k: "fatal",
        message: `@cursor/sdk load failed: ${
          err && err.message ? err.message : String(err)
        }`,
      }) + "\n",
    );
  } catch {
    /* parent stdout already gone */
  }
  process.exit(1);
}

const Agent = sdk && sdk.Agent;
const Cursor = sdk && sdk.Cursor;
const JsonlLocalAgentStore = sdk && sdk.JsonlLocalAgentStore;
const getDefaultSdkStateRoot = sdk && sdk.getDefaultSdkStateRoot;

/** A contained session gets a Zeros-owned, workspace/provider-scoped store.
 * Seed it once from Cursor's normal store so existing conversations resume;
 * all later writes stay on the explicit capability instead of the user's
 * broader HOME. This code runs inside ZSR, where the source is read-only and
 * the destination is the sole writable provider-state root. */
function initializeContainedStateRoot() {
  const target = process.env.ZEROS_CURSOR_STATE_ROOT;
  if (!target) return null;
  if (!path.isAbsolute(target)) {
    throw new Error("ZEROS_CURSOR_STATE_ROOT must be absolute");
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  if (
    fs.readdirSync(target).length === 0 &&
    typeof getDefaultSdkStateRoot === "function"
  ) {
    const source = getDefaultSdkStateRoot(process.cwd());
    if (
      path.isAbsolute(source) &&
      path.resolve(source) !== path.resolve(target) &&
      fs.existsSync(source)
    ) {
      try {
        fs.cpSync(source, target, {
          recursive: true,
          errorOnExist: false,
          force: false,
        });
      } catch (error) {
        // Migration failure must not make Cursor unusable: start with a clean
        // private store and surface a redacted diagnostic. Resume will use the
        // adapter's established fresh-session recovery path.
        process.stderr.write(
          `[cursor-host] existing state migration skipped: ${
            error && error.code ? String(error.code) : "copy failed"
          }\n`,
        );
      }
    }
  }
  return target;
}

let containedStateRoot = null;
try {
  containedStateRoot = initializeContainedStateRoot();
} catch (error) {
  try {
    process.stdout.write(
      JSON.stringify({
        k: "fatal",
        message: `contained Cursor state initialization failed: ${
          error && error.message ? error.message : String(error)
        }`,
      }) + "\n",
    );
  } catch {
    /* parent stdout already gone */
  }
  process.exit(1);
}

/** runId → { run, done } ; sdk agentId → SdkAgent ; storeId → store */
const runs = new Map();
const agents = new Map();
const stores = new Map();
let nextRunId = 1;
let nextStoreId = 1;

// ── The local agent store ─────────────────────────────────
//
// WHY WE HAND THE SDK A STORE INSTEAD OF LETTING IT PICK ONE
// @cursor/sdk's DEFAULT local store is backed by the **node:sqlite builtin**
// (1.0.26 dropped the native `sqlite3` dep that 1.0.18 carried). This host runs
// under the **Electron** binary — apps/desktop/electron/sidecar.ts points
// ZEROS_PTY_HOST_RUNTIME at process.execPath with ELECTRON_RUN_AS_NODE=1. The
// Electron runtime must not be assumed to expose the same built-ins as the
// development Node runtime; when node:sqlite was absent, Agent.create died with:
//
//   "Default local agent storage requires the built-in node:sqlite module
//    (Node >= 22.13, or another runtime that implements node:sqlite)."
//
// …and only the FIRST time. The SDK's failed async chunk load leaves a
// partially-initialized module behind, so every later call in the same host
// process reports a bare `Cannot access 'n' before initialization` TDZ error
// instead — classified UnknownAgentError, because the SDK's own node:sqlite
// detector keys on the message/code and a TDZ error matches neither. This host
// is long-lived and shared by every session, so that second, causeless message
// is the one users actually saw.
//
// LocalAgentOptions.store's own doc claims the SDK falls back to
// JsonlLocalAgentStore "when running without native SQLite" — it does not in
// 1.0.26; it throws. Passing a store explicitly is what the thrown error itself
// instructs, and it bypasses the default resolution entirely, so node:sqlite is
// never required.
//
// JSONL is used UNCONDITIONALLY, on every runtime. Choosing per-runtime
// ("sqlite where the builtin exists") would give dev (system Node ≥ 22) and the
// packaged app (Electron) two different on-disk formats — the exact
// dev/packaged divergence that let this bug reach users — and would silently
// orphan a workspace's history the day Electron is upgraded.
//
// The engine can also run @cursor/sdk IN-PROCESS (a non-bun engine, or
// ZEROS_CURSOR_IN_PROCESS=1), which never reaches this file. That path gets the
// same treatment from ../local-store.ts — same JSONL backend, same
// getDefaultSdkStateRoot(cwd) roots, so both runtimes read one on-disk format.
// It is a separate copy because this file ships STANDALONE (an electron-builder
// extraResource spawned by absolute path) and cannot require out of src/. Change
// one, change the other.

/** rootDir → JsonlLocalAgentStore. The SDK requires the SAME instance across
 *  create/resume/list for a given root, so these are memoized rather than
 *  rebuilt per call. Root is `getDefaultSdkStateRoot(cwd)` — the very directory
 *  the SDK would have put its own store in, so stores stay per-workspace (one
 *  workspace's agents never see another's) and land where the SDK expects. */
const localStores = new Map();

function jsonlStoreAt(root) {
  if (!JsonlLocalAgentStore) return null;
  if (typeof root !== "string" || root.length === 0) return null;
  let store = localStores.get(root);
  if (!store) {
    store = new JsonlLocalAgentStore(root);
    localStores.set(root, store);
  }
  return store;
}

/** The workspace ref a call's store should be rooted at.
 *
 *  `cwd` is legitimately ABSENT on `Agent.list({runtime: "local"})`:
 *  apps/desktop/src/engine/zeros-engine.ts passes undefined when a relay client's cwd falls outside
 *  the workspace allowlist, leaving the adapter to list the SDK's default
 *  location. `getDefaultSdkStateRoot(undefined)` throws, so bailing out there
 *  put `Agent.list` straight back on the node:sqlite default. If the host runtime
 *  lacks that builtin, `listSessions`' catch turns the failure into an empty chat
 *  list with no error shown.
 *
 *  process.cwd() is not a guess: it is the ref the SDK ITSELF falls back to (a
 *  store-less `Agent.list({runtime: "local"})` builds its default store at
 *  exactly `getDefaultSdkStateRoot(process.cwd())`, verified against 1.0.26), so
 *  the injected store lands in the SAME directory and only the backend changes.
 *  In this process that is `resolveHostCwd()` — host-client.ts spawns us with
 *  cwd set to it — so the fallback is stable across hosts rather than picking up
 *  whatever the engine happened to be launched from. */
function storeRefFor(cwd) {
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function localStoreFor(cwd) {
  if (containedStateRoot) return jsonlStoreAt(containedStateRoot);
  if (!getDefaultSdkStateRoot) return null;
  try {
    return jsonlStoreAt(getDefaultSdkStateRoot(storeRefFor(cwd)));
  } catch {
    return null;
  }
}

/** Copy `opts` with our store attached at `local.store` (Agent.create/resume).
 *  A store is a live SDK object, so it can only be built HERE, where the SDK
 *  lives — it cannot cross the JSON bridge from the engine, the same seam that
 *  forces callback-shaped options to be attached in `agent.send`. A store the
 *  caller supplied always wins; an SDK too old to export JsonlLocalAgentStore
 *  falls through to the SDK's own default. */
function withLocalStore(opts) {
  const out = { ...(opts || {}) };
  const local = { ...(out.local || {}) };
  if (local.store) return out;
  const cwd = typeof local.cwd === "string" && local.cwd ? local.cwd : out.cwd;
  const store = localStoreFor(cwd);
  if (!store) return out;
  local.store = store;
  out.local = local;
  return out;
}

/** Same, for Agent.list — whose ListAgentsOptions takes `store` at the TOP
 *  level (and only on the `runtime: "local"` arm), not under `local`. Unlike
 *  create/resume this routinely arrives with NO cwd; storeRefFor supplies the
 *  same fallback root the SDK would have used, so the listing path is never left
 *  on the default store either. */
function withListStore(opts) {
  const out = { ...(opts || {}) };
  if (out.runtime !== "local" || out.store) return out;
  const store = localStoreFor(out.cwd);
  if (store) out.store = store;
  return out;
}

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + "\n");
  } catch {
    /* stdout closed — the parent is gone; nothing we can do */
  }
}

/** Flatten an Error (incl. @cursor/sdk's typed errors) into a plain JSON object
 *  the engine can re-throw and classify. The SDK minifies its class names
 *  (constructor.name can be "a"), so we forward `.name` (the SDK sets it on the
 *  instance) AND the HTTP `.status` — the engine's classifier keys on status +
 *  message first, so auth/rate-limit detection survives the process boundary. */
function serializeErr(e) {
  if (!e || typeof e !== "object") {
    return { message: String(e), name: "Error" };
  }
  const out = { message: e.message ? String(e.message) : String(e) };
  if (typeof e.name === "string" && e.name) out.name = e.name;
  else if (e.constructor && e.constructor.name) out.name = e.constructor.name;
  if (typeof e.status === "number") out.status = e.status;
  if (e.code != null) out.code = String(e.code);
  return out;
}

function ok(id, result) {
  send({
    k: "res",
    id,
    ok: true,
    result: result === undefined ? null : result,
  });
}
function fail(id, e) {
  send({ k: "res", id, ok: false, error: serializeErr(e) });
}

/** Eagerly drain a run's stream, forwarding every item, so nothing is lost
 *  between `agent.send` returning and the engine consuming the stream.
 *
 *  Reaping: `runs` entries pin the SDK run (its HTTP/2 stream, abort
 *  listeners, buffered frames) inside this long-lived host, so every path out
 *  of a run must release its entry.
 *   - clean end   → the engine calls run.wait() right after streamEnd, which
 *                   deletes the entry; endedAt + the sweep below cover an
 *                   engine that never gets to wait() (adapter died mid-turn).
 *   - stream error → the engine never calls wait() after a streamError (the
 *                   throw skips it), so reap HERE — and cancel() so a local
 *                   run's detached cursor-agent subprocess is reaped too. */
function drainRun(runId, run) {
  (async () => {
    try {
      for await (const msg of run.stream()) {
        send({ k: "ev", ev: "run.msg", runId, msg });
      }
      const entry = runs.get(runId);
      if (entry && entry.run === run) entry.endedAt = Date.now();
      send({ k: "ev", ev: "run.streamEnd", runId });
    } catch (err) {
      const entry = runs.get(runId);
      if (entry && entry.run === run) {
        runs.delete(runId);
        try {
          const cancelled = run.cancel && run.cancel();
          if (cancelled && typeof cancelled.catch === "function") {
            cancelled.catch(() => {});
          }
        } catch {
          /* best effort */
        }
      }
      send({ k: "ev", ev: "run.streamError", runId, error: serializeErr(err) });
    }
  })();
}

// Belt-and-suspenders reaper for ended runs whose wait() never arrived (the
// engine crashed or dropped the turn between streamEnd and run.wait). Without
// it those entries — and the SDK runs they pin — live for the host's lifetime.
const ENDED_RUN_TTL_MS = 5 * 60_000;
const endedRunSweep = setInterval(() => {
  const now = Date.now();
  for (const [runId, entry] of runs) {
    if (entry.endedAt && now - entry.endedAt > ENDED_RUN_TTL_MS) {
      runs.delete(runId);
    }
  }
}, 60_000);
if (typeof endedRunSweep.unref === "function") endedRunSweep.unref();

async function handle(m) {
  const { id, op } = m;
  const args = m.args || {};
  switch (op) {
    case "agent.create": {
      const agent = await Agent.create(withLocalStore(args));
      agents.set(agent.agentId, agent);
      ok(id, { agentId: agent.agentId });
      return;
    }
    case "agent.resume": {
      const agent = await Agent.resume(args.agentId, withLocalStore(args.opts));
      agents.set(agent.agentId, agent);
      ok(id, { agentId: agent.agentId });
      return;
    }
    case "agent.list": {
      const res = await Agent.list(withListStore(args.opts));
      // Normalize to a plain {items} shape the engine tolerates either way.
      const items = Array.isArray(res)
        ? res
        : res && res.items
          ? res.items
          : [];
      ok(id, { items });
      return;
    }
    case "agent.send": {
      const agent = agents.get(args.agentId);
      if (!agent) throw new Error(`Agent ${args.agentId} not found`);
      // Copy the caller's options rather than passing the wire object through:
      // anything callback-shaped (e.g. `onDelta`) can only be attached HERE,
      // where the SDK lives, because a function cannot cross the JSON bridge
      // from the engine. The copy keeps that seam open without mutating the
      // decoded request.
      const sendOptions = { ...(args.options || {}) };
      const run = await agent.send(args.message, sendOptions);
      // The engine assigns the runId and registers its stream queue BEFORE
      // sending this request, so no run.msg event can race ahead of the
      // queue's existence. Fall back to a host-generated id if absent.
      const runId =
        typeof args.runId === "string" && args.runId
          ? args.runId
          : String(nextRunId++);
      runs.set(runId, { run, endedAt: null });
      // Respond FIRST (so the engine pairs sdkRunId with the run), THEN start
      // draining — NDJSON over one pipe preserves order.
      ok(id, { sdkRunId: run && run.id ? run.id : null });
      drainRun(runId, run);
      return;
    }
    case "agent.close": {
      const agent = agents.get(args.agentId);
      if (agent) {
        agents.delete(args.agentId);
        try {
          if (typeof agent.close === "function") agent.close();
        } catch {
          /* ignore */
        }
      }
      ok(id, null);
      return;
    }
    case "run.wait": {
      const entry = runs.get(args.runId);
      if (!entry) {
        // Unknown/already-reaped run — report a benign empty result rather than
        // throwing, so a late wait() after cancel doesn't surface as a failure.
        ok(id, null);
        return;
      }
      let res;
      try {
        res = await entry.run.wait();
      } finally {
        runs.delete(args.runId);
      }
      ok(id, res ? { status: res.status, result: res.result } : null);
      return;
    }
    case "run.cancel": {
      const entry = runs.get(args.runId);
      if (entry) {
        runs.delete(args.runId);
        try {
          await entry.run.cancel();
        } catch {
          /* best effort */
        }
      }
      ok(id, null);
      return;
    }
    case "models.list": {
      if (!Cursor || !Cursor.models || !Cursor.models.list) {
        ok(id, []);
        return;
      }
      const list = await Cursor.models.list(args.opts || {});
      ok(id, Array.isArray(list) ? list : []);
      return;
    }
    case "store.open": {
      // Hand back a handle to the SAME store the agents write through, so the
      // adapter's readRunError() reads the agent's own rows. Before 1.0.26 this
      // opened the SDK's `SqliteLocalAgentStore`; 1.0.26 stopped exporting that
      // symbol altogether, which silently turned every store.open into
      // {storeId: null} and left the adapter's terminal-error recovery dead.
      const store = containedStateRoot
        ? jsonlStoreAt(containedStateRoot)
        : args.stateRoot
          ? jsonlStoreAt(args.stateRoot)
          : localStoreFor(args.workspaceRef);
      if (!store) {
        ok(id, { storeId: null });
        return;
      }
      const storeId = String(nextStoreId++);
      stores.set(storeId, store);
      ok(id, { storeId });
      return;
    }
    case "store.runGet": {
      const store = stores.get(args.storeId);
      if (!store) {
        ok(id, null);
        return;
      }
      const doc = await store.runs.get({
        agentId: args.agentId,
        runId: args.runId,
      });
      ok(id, doc || null);
      return;
    }
    case "store.dispose": {
      // Release the HANDLE only. The store behind it is the memoized
      // per-workspace instance that live agents are still writing through, so
      // tearing it down here would pull it out from under running runs. (It is
      // file-backed and holds no connection to close — JsonlLocalAgentStore
      // exposes no dispose() at all — so dropping the handle IS the teardown.)
      stores.delete(args.storeId);
      ok(id, null);
      return;
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.length > 0) {
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = null;
      }
      if (msg && msg.k === "req" && typeof msg.op === "string") {
        // Each request is independent; a throw becomes an error response so one
        // bad op never wedges the host.
        Promise.resolve()
          .then(() => handle(msg))
          .catch((err) => fail(msg.id, err));
      }
    }
    nl = buf.indexOf("\n");
  }
});

// The parent (engine) closing our stdin — a clean shutdown OR a crash — means
// we must tear down every live run/agent/store and exit so we never linger as
// an orphan holding Cursor runs (and their network connections) open.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Cancel every live run + dispose agents/stores, then AWAIT the settle with a
  // hard cap. `run.cancel()` is what fires @cursor/sdk's AbortSignal, which is
  // the ONLY thing that kills the actual `cursor-agent` runtime — the SDK spawns
  // it DETACHED (its own process group) and reaps it via SIGTERM → (1s) → SIGKILL
  // off that abort. The old code fired `void entry.run.cancel()` and then called
  // `process.exit(0)` on the SAME synchronous tick, so we exited long before the
  // SDK's kill chain (esp. its 1s-delayed SIGKILL) could run — stranding every
  // in-flight cursor-agent as a ppid=1 orphan (exactly the 18 leaked processes
  // observed). Awaiting the cancels — bounded well under the sidecar's 5s SIGTERM
  // grace (apps/desktop/electron/sidecar.ts killCurrentChild) — lets the SDK actually fell the
  // detached child before this host exits.
  const pending = [];
  for (const entry of runs.values()) {
    try {
      pending.push(Promise.resolve(entry.run.cancel()));
    } catch {
      /* best effort */
    }
  }
  for (const agent of agents.values()) {
    try {
      if (typeof agent.close === "function")
        pending.push(Promise.resolve(agent.close()));
    } catch {
      /* ignore */
    }
  }
  // Stores need no teardown: they are file-backed JSONL, hold no connection or
  // handle, and every write is already awaited by the call that made it.
  runs.clear();
  agents.clear();
  stores.clear();
  localStores.clear();
  try {
    // Cap at 2.5s: comfortably past the SDK's 1s SIGTERM→SIGKILL timer, and well
    // under the 5s grace the parent gives before it SIGKILLs this host's group.
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  } catch {
    /* we exit regardless */
  }
  process.exit(0);
}
// The parent (engine) dying — clean OR crash/SIGKILL — closes our stdin, which
// fires 'end'/'close' and drives shutdown(); direct signals cover the rest.
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGHUP", () => void shutdown());

send({ k: "ready" });
