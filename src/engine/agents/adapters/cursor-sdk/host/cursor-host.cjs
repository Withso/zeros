#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Zeros Cursor host — a tiny Node subprocess that owns @cursor/sdk
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// The Zeros engine runs under **bun** (dev: `bun src/cli.ts`; packaged: a
// bun-compiled standalone binary — see electron/sidecar.ts). @cursor/sdk loads
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
// The fix mirrors src/engine/pty/pty-host.cjs (which exists for the identical
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
// SQLite store for error recovery (CursorLocalStore). The host begins draining
// `run.stream()` eagerly the moment the run is created and forwards every item
// as a `run.msg` event, so no items are lost between `send` and the engine
// reading the stream.
//
// stdout is RESERVED for the protocol — this process must never console.log.
// Diagnostics go to stderr, which the engine forwards to its log.
// ──────────────────────────────────────────────────────────

"use strict";

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
// app that's the app.asar.unpacked copy (the SDK pulls a native sqlite3 binding
// that can't be dlopen'd from inside asar). When unset (engine run from source
// with no Electron host) fall back to ordinary module resolution, which walks
// up to the repo node_modules.
const sdkEntry = process.env.ZEROS_CURSOR_SDK_ENTRY;
let sdk;
try {
  // Two branches on purpose: the env-path branch lets the engine hand us an
  // absolute, asar-unpacked entry in a packaged app; the literal-specifier
  // branch is a STATIC `require("@cursor/sdk")` that (a) resolves via the normal
  // node_modules walk in source/dev mode and (b) can be statically bundled by
  // esbuild/tsup if a future build inlines the SDK into this host. Don't fold
  // them into one `require(<ternary>)` — that would defeat static bundling.
  sdk = sdkEntry && sdkEntry.length > 0 ? require(sdkEntry) : require("@cursor/sdk");
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
const SqliteLocalAgentStore = sdk && sdk.SqliteLocalAgentStore;

/** runId → { run, done } ; sdk agentId → SdkAgent ; storeId → store */
const runs = new Map();
const agents = new Map();
const stores = new Map();
let nextRunId = 1;
let nextStoreId = 1;

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
  send({ k: "res", id, ok: true, result: result === undefined ? null : result });
}
function fail(id, e) {
  send({ k: "res", id, ok: false, error: serializeErr(e) });
}

/** Eagerly drain a run's stream, forwarding every item, so nothing is lost
 *  between `agent.send` returning and the engine consuming the stream. */
function drainRun(runId, run) {
  (async () => {
    try {
      for await (const msg of run.stream()) {
        send({ k: "ev", ev: "run.msg", runId, msg });
      }
      send({ k: "ev", ev: "run.streamEnd", runId });
    } catch (err) {
      send({ k: "ev", ev: "run.streamError", runId, error: serializeErr(err) });
    }
  })();
}

async function handle(m) {
  const { id, op } = m;
  const args = m.args || {};
  switch (op) {
    case "agent.create": {
      const agent = await Agent.create(args || {});
      agents.set(agent.agentId, agent);
      ok(id, { agentId: agent.agentId });
      return;
    }
    case "agent.resume": {
      const agent = await Agent.resume(args.agentId, args.opts || {});
      agents.set(agent.agentId, agent);
      ok(id, { agentId: agent.agentId });
      return;
    }
    case "agent.list": {
      const res = await Agent.list(args.opts || {});
      // Normalize to a plain {items} shape the engine tolerates either way.
      const items = Array.isArray(res) ? res : res && res.items ? res.items : [];
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
      runs.set(runId, { run, done: false });
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
      if (!SqliteLocalAgentStore || !SqliteLocalAgentStore.open) {
        ok(id, { storeId: null });
        return;
      }
      const store = await SqliteLocalAgentStore.open({
        workspaceRef: args.workspaceRef,
        ...(args.stateRoot ? { stateRoot: args.stateRoot } : {}),
      });
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
      const store = stores.get(args.storeId);
      if (store) {
        stores.delete(args.storeId);
        try {
          await store.dispose();
        } catch {
          /* ignore */
        }
      }
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
  // grace (electron/sidecar.ts killCurrentChild) — lets the SDK actually fell the
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
      if (typeof agent.close === "function") pending.push(Promise.resolve(agent.close()));
    } catch {
      /* ignore */
    }
  }
  for (const store of stores.values()) {
    try {
      pending.push(Promise.resolve(store.dispose()));
    } catch {
      /* ignore */
    }
  }
  runs.clear();
  agents.clear();
  stores.clear();
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
