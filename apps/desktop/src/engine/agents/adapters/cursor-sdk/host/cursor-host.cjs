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

/** Process start, so every later measurement can be stated relative to boot. */
const hostStartedAt = Date.now();

const cursorTransportDebug =
  process.env.ZEROS_CURSOR_TRANSPORT_DEBUG === "1";
function debugCursorTransport(message) {
  if (!cursorTransportDebug) return;
  try {
    process.stderr.write(`[cursor-transport] ${message}\n`);
  } catch {
    /* diagnostics must never change transport behavior */
  }
}

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

/**
 * Node's built-in environment-proxy support covers fetch/http/https, but not
 * node:http2. Cursor uses both: API-key exchange/model discovery ride fetch,
 * while the local agent protocol rides @connectrpc/connect-node → http2.
 * ZSR host parity does not install a proxy. This shim matters only when the
 * deployment itself sets NODE_USE_ENV_PROXY and HTTP(S)_PROXY; without it the
 * two Cursor transports would disagree about that ordinary host configuration.
 *
 * Install this before requiring @cursor/sdk, while its bundled connect-node
 * modules still resolve `require("node:http2").connect`. The HTTP/2 connector
 * establishes an authenticated CONNECT tunnel, then returns a real TLSSocket
 * whose `secureConnect` event cannot fire until the tunnel is ready. Provider
 * credentials stay in Cursor's normal request path and are never handled here.
 */
function installEnvironmentProxyTransports() {
  if (process.env.NODE_USE_ENV_PROXY !== "1") return;
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) return;

  const http = require("node:http");
  const http2 = require("node:http2");
  const net = require("node:net");
  const tls = require("node:tls");
  const { Duplex, PassThrough } = require("node:stream");

  let proxyUrl;
  try {
    proxyUrl = new URL(proxy);
  } catch {
    return;
  }
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") return;

  const normalizedHostname = (hostname) =>
    hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
  const shouldBypassProxy = (hostname, port) => {
    const targetHost = normalizedHostname(hostname);
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
    for (const rawEntry of noProxy.split(",")) {
      let entry = rawEntry.trim().toLowerCase();
      if (!entry) continue;
      if (entry === "*") return true;
      let entryPort;
      if (entry.startsWith("[")) {
        const bracket = entry.indexOf("]");
        if (bracket !== -1 && entry[bracket + 1] === ":") {
          entryPort = entry.slice(bracket + 2);
          entry = entry.slice(0, bracket + 1);
        }
      } else {
        const colon = entry.lastIndexOf(":");
        if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
          entryPort = entry.slice(colon + 1);
          entry = entry.slice(0, colon);
        }
      }
      if (entryPort && Number(entryPort) !== port) continue;
      const wildcard = entry.startsWith("*.") || entry.startsWith(".");
      const entryHost = normalizedHostname(entry.replace(/^\*\./, "."));
      if (
        targetHost === entryHost.replace(/^\./, "") ||
        (wildcard && targetHost.endsWith(entryHost))
      ) {
        return true;
      }
    }
    return false;
  };

  // A generic JS Duplex makes http2 emit `connect` as soon as it attaches,
  // before an asynchronous HTTPS Agent has completed CONNECT + TLS. Cursor then
  // opens AgentService/Run and cancels it before TLS is ready. Instead, start a
  // real client TLSSocket over a buffered duplex immediately. It retains
  // `secureConnecting=true` (which http2 understands) while the separate proxy
  // socket performs CONNECT; only then are the buffered ClientHello bytes
  // released into the tunnel.
  const connectHttp2ThroughProxy = (target, socketOptions) => {
    const hostname = normalizedHostname(target.hostname);
    const port = target.port ? Number(target.port) : 443;
    const authority = `${net.isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;
    // Phase timing for the one hop Zeros owns end to end. A contained session
    // pays ~2.6s to open a connection that costs ~0.55s from the same machine
    // unproxied, and the provider opens several of them SERIALLY before a turn
    // can start — which is most of a cold turn's latency. "A connection is
    // slow" is not actionable; each of these phases points somewhere different:
    //   dial    — reaching the sandbox's proxy listener (local; a slow dial
    //             means the bridge in front of it, not the network)
    //   connect — CONNECT sent → 200 received: the proxy's own upstream dial,
    //             DNS and policy check
    //   tls     — 200 → secureConnect: the TLS handshake, which for a
    //             credential-substituted authority is terminated by the proxy
    //             and so should be LOCAL and fast
    const phaseStartedAt = Date.now();
    let dialedAt = null;
    let tunnelledAt = null;
    const reportTunnelPhases = (outcome) => {
      const total = Date.now() - phaseStartedAt;
      if (total < SLOW_OP_MS && !cursorTransportDebug) return;
      const dial = dialedAt === null ? null : dialedAt - phaseStartedAt;
      const connect =
        dialedAt === null || tunnelledAt === null ? null : tunnelledAt - dialedAt;
      const tls = tunnelledAt === null ? null : Date.now() - tunnelledAt;
      const ms = (value) => (value === null ? "n/a" : `${value}ms`);
      process.stderr.write(
        `[cursor-host] proxy tunnel ${authority} ${outcome} in ${total}ms ` +
          `(dial=${ms(dial)} connect=${ms(connect)} tls=${ms(tls)})\n`,
      );
    };
    const outbound = new PassThrough();
    const inbound = new PassThrough();
    const bridge = Duplex.from({ writable: outbound, readable: inbound });
    let proxySocket;
    let secureSocket;
    let closed = false;

    outbound.on("error", () => {});
    inbound.on("error", () => {});
    const fail = (error) => {
      if (closed) return;
      closed = true;
      debugCursorTransport(
        `${authority} bridge failed (${error?.code || error?.message || "unknown"})`,
      );
      reportTunnelPhases(`failed (${error?.code || error?.message || "unknown"})`);
      outbound.destroy(error);
      inbound.destroy(error);
      bridge.destroy(error);
      proxySocket?.destroy();
      secureSocket?.destroy(error);
    };
    bridge.once("close", () => {
      closed = true;
      debugCursorTransport(`${authority} bridge closed`);
      proxySocket?.destroy();
    });
    bridge.on("error", () => {});

    try {
      secureSocket = tls.connect({
        ...(socketOptions || {}),
        socket: bridge,
        host: hostname,
        hostname,
        port,
        ALPNProtocols: ["h2"],
        ...(net.isIP(hostname) ? {} : { servername: hostname }),
      });
      secureSocket.once("secureConnect", () => {
        debugCursorTransport(
          `${authority} proxy TLS ready (alpn=${String(
            secureSocket.alpnProtocol || "none",
          )}, authorized=${String(secureSocket.authorized)})`,
        );
        reportTunnelPhases("ready");
      });
      secureSocket.on("error", (error) =>
        debugCursorTransport(
          `${authority} TLS error (${error?.code || error?.message || "unknown"})`,
        ),
      );

      const proxyHost = normalizedHostname(proxyUrl.hostname);
      const proxyPort = proxyUrl.port
        ? Number(proxyUrl.port)
        : proxyUrl.protocol === "https:"
          ? 443
          : 80;
      const onProxyConnected = () => {
        dialedAt = Date.now();
        debugCursorTransport(`${authority} proxy TCP connected`);
        let authorization = "";
        if (proxyUrl.username || proxyUrl.password) {
          const username = decodeURIComponent(proxyUrl.username);
          const password = decodeURIComponent(proxyUrl.password);
          authorization = `Proxy-Authorization: Basic ${Buffer.from(
            `${username}:${password}`,
          ).toString("base64")}\r\n`;
        }
        proxySocket.write(
          `CONNECT ${authority} HTTP/1.1\r\n` +
            `Host: ${authority}\r\n` +
            authorization +
            "Proxy-Connection: Keep-Alive\r\n\r\n",
        );
      };
      proxySocket =
        proxyUrl.protocol === "https:"
          ? tls.connect(
              {
                host: proxyHost,
                port: proxyPort,
                ...(net.isIP(proxyHost) ? {} : { servername: proxyHost }),
              },
              onProxyConnected,
            )
          : net.connect(
              { host: proxyHost, port: proxyPort },
              onProxyConnected,
            );
      proxySocket.on("error", fail);
      const timeout = Number(socketOptions?.timeout) || 30_000;
      proxySocket.setTimeout(timeout, () => {
        const error = new Error(
          `proxy CONNECT to ${authority} timed out after ${timeout}ms`,
        );
        error.code = "ERR_PROXY_TUNNEL";
        fail(error);
      });

      let response = Buffer.alloc(0);
      const onProxyData = (chunk) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > 64 * 1024) {
          const error = new Error("proxy CONNECT response headers are too large");
          error.code = "ERR_PROXY_TUNNEL";
          fail(error);
          return;
        }
        const marker = response.indexOf("\r\n\r\n");
        if (marker === -1) return;
        const statusLine = response
          .subarray(0, response.indexOf("\r\n"))
          .toString("latin1");
        const status = Number(statusLine.split(" ")[1]);
        if (status !== 200) {
          const error = new Error(
            `proxy CONNECT to ${authority} failed with status ${Number.isFinite(status) ? status : "unknown"}`,
          );
          error.code = "ERR_PROXY_TUNNEL";
          fail(error);
          return;
        }
        tunnelledAt = Date.now();
        proxySocket.setTimeout(0);
        proxySocket.removeListener("data", onProxyData);
        const head = response.subarray(marker + 4);
        response = Buffer.alloc(0);
        if (head.length > 0) inbound.write(head);
        proxySocket.pipe(inbound);
        outbound.pipe(proxySocket);
      };
      proxySocket.on("data", onProxyData);
      proxySocket.once("close", () =>
        debugCursorTransport(`${authority} proxy TCP closed`),
      );
    } catch (error) {
      fail(error);
    }
    return secureSocket;
  };

  // Electron 43 / Node 24 exposes this API. Calling it explicitly makes the
  // startup contract observable and also configures global fetch's dispatcher.
  if (typeof http.setGlobalProxyFromEnv === "function") {
    http.setGlobalProxyFromEnv();
  }

  const directConnect = http2.connect;
  http2.connect = function proxiedHttp2Connect(authority, options, listener) {
    let connectOptions = options;
    let connectListener = listener;
    if (typeof connectOptions === "function") {
      connectListener = connectOptions;
      connectOptions = undefined;
    }
    const target = authority instanceof URL ? authority : new URL(authority);
    // Cursor's backend is HTTPS. Preserve explicit/custom transports and
    // plaintext HTTP/2 exactly; the kernel boundary remains the final fence.
    if (
      target.protocol !== "https:" ||
      (connectOptions && typeof connectOptions.createConnection === "function")
    ) {
      return directConnect.call(
        this,
        authority,
        connectOptions,
        connectListener,
      );
    }
    const targetPort = target.port ? Number(target.port) : 443;
    if (shouldBypassProxy(target.hostname, targetPort)) {
      return directConnect.call(
        this,
        authority,
        connectOptions,
        connectListener,
      );
    }

    const proxiedOptions = {
      ...(connectOptions || {}),
      createConnection: (_target, socketOptions) =>
        connectHttp2ThroughProxy(target, socketOptions),
    };
    const session = directConnect.call(
      this,
      authority,
      proxiedOptions,
      connectListener,
    );
    if (cursorTransportDebug) {
      let requestSequence = 0;
      const directRequest = session.request;
      session.request = function debuggedHttp2Request(headers, options) {
        const requestId = ++requestSequence;
        const method = String(headers?.[":method"] || "unknown");
        const requestPath = String(headers?.[":path"] || "")
          .split("?", 1)[0]
          .slice(0, 160);
        debugCursorTransport(
          `${target.host} http2 request ${requestId} ${method} ${requestPath}`,
        );
        const stream = directRequest.call(this, headers, options);
        stream.once("response", (responseHeaders) =>
          debugCursorTransport(
            `${target.host} http2 response ${requestId} (${String(
              responseHeaders?.[":status"] || "unknown",
            )})`,
          ),
        );
        stream.once("aborted", () =>
          debugCursorTransport(
            `${target.host} http2 request ${requestId} aborted`,
          ),
        );
        stream.once("error", (error) =>
          debugCursorTransport(
            `${target.host} http2 request ${requestId} error (${error?.code || error?.message || "unknown"})`,
          ),
        );
        stream.once("close", () =>
          debugCursorTransport(
            `${target.host} http2 request ${requestId} closed (rst=${String(
              stream.rstCode,
            )})`,
          ),
        );
        return stream;
      };
      session.once("connect", () =>
        debugCursorTransport(`${target.host} http2 session connected`),
      );
      session.once("remoteSettings", () =>
        debugCursorTransport(`${target.host} http2 remote settings received`),
      );
      session.on("goaway", (code) =>
        debugCursorTransport(`${target.host} http2 GOAWAY (${String(code)})`),
      );
      session.on("error", (error) =>
        debugCursorTransport(
          `${target.host} http2 error (${error?.code || error?.message || "unknown"})`,
        ),
      );
      session.once("close", () =>
        debugCursorTransport(`${target.host} http2 session closed`),
      );
    }
    return session;
  };
}

/**
 * Cursor's ripwalk already excludes descendants of `.git`, which covers the
 * contents of an ordinary Git directory. It does not cover the `.git` entry itself. That
 * distinction matters for linked worktrees (where `.git` is a file) and under
 * ZSR (where the canonical entry is kernel-denied): ripgrep reports EPERM and
 * the SDK's ignore-map initialization aborts before it can scan normal files.
 *
 * Intercept only the exact, absolute ripgrep executable selected by Cursor and
 * only in a contained per-session host. The two negative globs are inserted
 * before ripgrep's `--` search-path separator, preserving every SDK argument,
 * VCS-ignore behavior, and user-visible workspace file. Git commands continue
 * through the separate shadow-Git capability; this never weakens that fence.
 */
function installContainedRipgrepBoundary() {
  const ripgrepPath = process.env.CURSOR_RIPGREP_PATH;
  if (
    !process.env.ZEROS_CURSOR_STATE_ROOT ||
    !ripgrepPath ||
    !path.isAbsolute(ripgrepPath)
  ) {
    return;
  }

  const childProcess = require("node:child_process");
  const directSpawn = childProcess.spawn;
  const sameExecutable = (command) => {
    if (typeof command !== "string") return false;
    if (process.platform === "win32") {
      return path.resolve(command).toLowerCase() === path.resolve(ripgrepPath).toLowerCase();
    }
    return path.resolve(command) === path.resolve(ripgrepPath);
  };
  const hasGlob = (args, pattern) =>
    args.some(
      (arg, index) =>
        (arg === "--glob" || arg === "--iglob" || arg === "-g") &&
        args[index + 1] === pattern,
    );

  childProcess.spawn = function containedRipgrepSpawn(command, args, options) {
    if (!sameExecutable(command) || !Array.isArray(args)) {
      return directSpawn.call(this, command, args, options);
    }
    const boundedArgs = [...args];
    const boundaryArgs = [];
    for (const pattern of ["!.git", "!**/.git"]) {
      if (!hasGlob(boundedArgs, pattern)) {
        boundaryArgs.push("--iglob", pattern);
      }
    }
    if (boundaryArgs.length > 0) {
      const separator = boundedArgs.indexOf("--");
      boundedArgs.splice(
        separator === -1 ? boundedArgs.length : separator,
        0,
        ...boundaryArgs,
      );
    }
    return directSpawn.call(this, command, boundedArgs, options);
  };
}

// ── First-turn latency attribution ────────────────────────
//
// WHY THIS EXISTS
// A Cursor turn is `agent.send()` followed by items arriving on `run.stream()`.
// Everything between them happens INSIDE @cursor/sdk's local runtime — it loads
// the settings layers named by `local.settingSources` (user/project/team/mdm/
// plugins), walks the workspace for rules/skills/ignore files, bootstraps its
// feature-gate client, and opens the backend connection — and none of it emits
// a single line. Measured against this host's own run store, the FIRST run in a
// fresh contained host spent 77s in that window while every later run in the
// same process spent ~4s; uncontained hosts start at ~4s cold. 77 seconds of
// total silence is not a diagnosable state, and the gap is exactly where a
// containment boundary changes the cost of ordinary work (every outbound
// request is proxied, every spawn is sandbox-wrapped, HOME is a fresh
// projection), so the missing information is always "which operation blocked".
//
// So: time every outbound request and every child spawn, and attribute the
// pre-first-item window to the ones that overlapped it. Recording is a closure
// and two timestamps per operation; nothing is logged unless an operation is
// slow or a run is slow to produce its first item, so a healthy turn stays
// silent. `ZEROS_CURSOR_TRANSPORT_DEBUG=1` additionally reports every recorded
// operation regardless of duration.
//
// Diagnostics go to stderr (stdout is the protocol) and the engine forwards
// them, so the attribution lands in the same log as the `[zsr] admitted` line.

/** An operation slower than this is reported on its own as it completes. */
const SLOW_OP_MS = Number(process.env.ZEROS_CURSOR_SLOW_OP_MS) || 3_000;
/** A run whose first stream item takes longer than this gets an attribution
 *  breakdown. Below it the wait is ordinary model latency, not a stall. */
const SLOW_FIRST_ITEM_MS =
  Number(process.env.ZEROS_CURSOR_SLOW_FIRST_ITEM_MS) || 5_000;
/** Ring-buffer ceiling. A turn that spawns thousands of children must not
 *  turn diagnostics into the leak they were added to find. */
const MAX_TRACED_OPS = 512;
/** Longest label kept per operation — URLs carry query strings and argv can be
 *  arbitrarily long, and neither belongs in a log at full length. */
const MAX_OP_LABEL_CHARS = 120;

/** Completed operations, oldest first, bounded to MAX_TRACED_OPS. */
const tracedOps = [];
/** Operations still running. Reported as `(in flight)` — a still-unfinished
 *  operation is the MOST likely culprit for a stall, so it must never be
 *  omitted just because it has no end time yet. */
const inFlightOps = new Set();

function shortLabel(value) {
  let text;
  try {
    text = String(value ?? "");
  } catch {
    // A null-prototype or Proxy-wrapped value can throw on coercion. A
    // diagnostic must never be the thing that breaks the transport it measures.
    text = "(unprintable)";
  }
  return text.length > MAX_OP_LABEL_CHARS
    ? `${text.slice(0, MAX_OP_LABEL_CHARS - 1)}…`
    : text;
}

/** Start timing one operation. The returned function ends it exactly once;
 *  extra calls (a socket that emits both `error` and `close`) are ignored so a
 *  single connect can attach to several events without double-reporting. */
function beginOp(kind, detail) {
  // Long-lived children (a stdio MCP server) and kept-alive sessions stay
  // in flight for the host's lifetime, so this set needs the same hard ceiling
  // the completed ring has. Past it, tracing stops rather than accumulating.
  if (inFlightOps.size >= MAX_TRACED_OPS) return () => {};
  const op = {
    kind,
    label: shortLabel(detail),
    startedAt: Date.now(),
    endedAt: null,
    outcome: null,
  };
  inFlightOps.add(op);
  return (outcome) => {
    if (op.endedAt !== null) return;
    op.endedAt = Date.now();
    op.outcome = outcome == null ? "ok" : shortLabel(outcome);
    inFlightOps.delete(op);
    tracedOps.push(op);
    if (tracedOps.length > MAX_TRACED_OPS) tracedOps.shift();
    const elapsed = op.endedAt - op.startedAt;
    if (elapsed >= SLOW_OP_MS || cursorTransportDebug) {
      process.stderr.write(
        `[cursor-host] slow ${op.kind} ${op.label} took ${elapsed}ms (${op.outcome})\n`,
      );
    }
  };
}

/** Every operation that was running at any point inside [from, to], slowest
 *  first. In-flight operations are treated as still running "now". */
function opsOverlapping(from, to) {
  const overlapping = [];
  for (const op of [...tracedOps, ...inFlightOps]) {
    const endedAt = op.endedAt ?? Date.now();
    if (endedAt < from || op.startedAt > to) continue;
    overlapping.push({
      kind: op.kind,
      label: op.label,
      outcome: op.endedAt === null ? "in flight" : op.outcome,
      // Only the part of the operation that overlaps the window can explain
      // the window; a connection opened long before and still open is not
      // 20 minutes of this turn's latency.
      elapsed: Math.min(endedAt, to) - Math.max(op.startedAt, from),
      // Offset from the start of the window. Durations alone cannot tell
      // five concurrent 3s calls (3s of latency) from five serial ones (15s),
      // and which one it is decides whether the fix is "make each call
      // cheaper" or "stop making so many".
      offset: Math.max(op.startedAt, from) - from,
    });
  }
  overlapping.sort((left, right) => right.elapsed - left.elapsed);
  return overlapping;
}

/** How much of a window had at least one traced operation in flight. A window
 *  far longer than its own covered span is waiting on something untraced
 *  (in-process work); one close to it is spending its time on these calls. */
function coveredSpan(ops) {
  const spans = ops
    .map((op) => [op.offset, op.offset + op.elapsed])
    .sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let cursor = -1;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) {
      covered += end - from;
      cursor = end;
    }
  }
  return covered;
}

/** Attribute a slow pre-first-item window to the operations inside it. */
function reportFirstItemLatency(runId, from, to, extra) {
  const waited = to - from;
  process.stderr.write(
    `[cursor-host] run ${runId} first model output after ${waited}ms (${extra})\n`,
  );
  const candidates = opsOverlapping(from, to).filter(
    (op) => op.elapsed >= 250 || cursorTransportDebug,
  );
  if (candidates.length === 0) {
    process.stderr.write(
      "[cursor-host]   ↳ no outbound request or child process overlapped the " +
        "wait — the time is inside @cursor/sdk's own work (settings layers, " +
        "workspace scan) or its already-open connection\n",
    );
    return;
  }
  // Ordered by START, not duration: read top to bottom and the serial chain is
  // visible as a staircase of offsets, while concurrent calls share one.
  const byStart = [...candidates].sort((left, right) => left.offset - right.offset);
  for (const op of byStart.slice(0, 14)) {
    process.stderr.write(
      `[cursor-host]   ↳ @${String(op.offset).padStart(6)}ms ` +
        `${String(op.elapsed).padStart(6)}ms ${op.kind} ${op.label} ` +
        `(${op.outcome})\n`,
    );
  }
  if (byStart.length > 14) {
    process.stderr.write(
      `[cursor-host]   ↳ …and ${byStart.length - 14} shorter operation(s)\n`,
    );
  }
  const covered = coveredSpan(candidates);
  process.stderr.write(
    `[cursor-host]   ∑ ${candidates.length} traced operation(s) covered ` +
      `${covered}ms of the ${waited}ms wait ` +
      `(${Math.round((covered / Math.max(waited, 1)) * 100)}%); ` +
      `${waited - covered}ms was untraced in-process work\n`,
  );
  // The dominant case is worth naming rather than leaving as a row in a table:
  // an MCP server the provider spawned, killed at its connect budget, having
  // consumed most of the window. A stdio MCP server that has to authorize
  // interactively can never finish in a headless contained session, so it costs
  // this on EVERY session until its credentials are valid on disk — and the only
  // visible symptom is the user's first message being slow.
  const dominant = candidates[0];
  if (
    dominant &&
    dominant.kind === "spawn" &&
    /SIGTERM|SIGKILL/.test(String(dominant.outcome)) &&
    dominant.elapsed >= waited / 2
  ) {
    process.stderr.write(
      `[cursor-host]   ⚠ "${dominant.label}" is almost certainly an MCP server ` +
        `from your MCP config: it never became usable and was killed at the ` +
        `provider's connect budget, and the turn started right after. Until its ` +
        `credentials are valid inside the session HOME, every first message ` +
        `pays this. Authorize it once on the host, or remove it from the MCP ` +
        `config, to get the time back.\n`,
    );
  }
}

/**
 * Wrap every transport @cursor/sdk can reach the network through, plus child
 * spawns. Install AFTER installEnvironmentProxyTransports so this wrapper is
 * outermost and measures what the SDK actually experiences (proxy dial + CONNECT
 * + TLS included), and BEFORE `require("@cursor/sdk")` so the SDK's bundled
 * connect-node/undici copies capture the wrapped functions.
 */
function installFirstTurnTracer() {
  const http = require("node:http");
  const https = require("node:https");
  const http2 = require("node:http2");
  const net = require("node:net");
  const tls = require("node:tls");
  const childProcess = require("node:child_process");

  const authorityOf = (options, fallback) => {
    if (typeof options === "string") return options;
    if (options && typeof options === "object") {
      const host = options.host ?? options.hostname;
      if (host) return options.port ? `${host}:${options.port}` : String(host);
      if (options.path) return String(options.path);
    }
    return fallback;
  };

  /** Label a net/tls connect from its argument list, which Node overloads as
   *  (options[, cb]) / (port[, host][, cb]) / (path[, cb]). Never interpolate
   *  an argument blindly: Node's own https agent passes a NULL-PROTOTYPE
   *  options object into tls.connect, and `${obj}` on one throws "Cannot
   *  convert object to primitive value" — which a diagnostic must never do to
   *  the transport it is measuring. */
  const connectLabel = (args) => {
    const [first, second] = args;
    if (typeof first === "number") {
      return `${typeof second === "string" ? second : "localhost"}:${first}`;
    }
    if (typeof first === "string") return first;
    return authorityOf(first, "socket");
  };

  // A socket's operation ends at the first terminal event. `connect` for a
  // plain socket, `secureConnect` for TLS; `error`/`close` cover the failures,
  // which is the case that matters — an outbound socket the sandbox never lets
  // reach anything is precisely the shape of stall this exists to name.
  const traceSocket = (socket, kind, label) => {
    if (!socket || typeof socket.once !== "function") return socket;
    const end = beginOp(kind, label);
    socket.once("connect", () => end("connected"));
    socket.once("secureConnect", () => end("tls-ready"));
    socket.once("error", (error) => end(error?.code || error?.message || "error"));
    socket.once("close", () => end("closed before connect"));
    return socket;
  };

  const directFetch = globalThis.fetch;
  if (typeof directFetch === "function") {
    globalThis.fetch = function tracedFetch(input, init) {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : String(input);
      const method = String(init?.method || input?.method || "GET");
      const end = beginOp("fetch", `${method} ${url.split("?", 1)[0]}`);
      let result;
      try {
        result = directFetch.call(this, input, init);
      } catch (error) {
        end(error?.code || error?.message || "threw");
        throw error;
      }
      return Promise.resolve(result).then(
        (response) => {
          end(String(response?.status ?? "ok"));
          return response;
        },
        (error) => {
          end(error?.code || error?.message || "rejected");
          throw error;
        },
      );
    };
  }

  for (const [module, scheme] of [
    [http, "http"],
    [https, "https"],
  ]) {
    // `get` does not route through the patched `request` export (Node resolves
    // it against the module's own scope), so both are wrapped.
    for (const name of ["request", "get"]) {
      const direct = module[name];
      if (typeof direct !== "function") continue;
      module[name] = function tracedHttpRequest(...args) {
        const request = direct.apply(this, args);
        const target =
          args[0] instanceof URL
            ? args[0].host
            : authorityOf(args[0], `${scheme} request`);
        const end = beginOp(`${scheme}`, target);
        request.once("response", (response) =>
          end(String(response?.statusCode ?? "ok")),
        );
        request.once("error", (error) =>
          end(error?.code || error?.message || "error"),
        );
        request.once("close", () => end("closed"));
        return request;
      };
    }
  }

  const directHttp2Connect = http2.connect;
  http2.connect = function tracedHttp2Connect(authority, options, listener) {
    const session = directHttp2Connect.call(this, authority, options, listener);
    const target =
      authority instanceof URL ? authority.host : String(authority ?? "http2");
    const end = beginOp("http2", target);
    session.once("connect", () => end("connected"));
    session.once("error", (error) =>
      end(error?.code || error?.message || "error"),
    );
    session.once("close", () => end("closed before connect"));
    return session;
  };

  for (const name of ["connect", "createConnection"]) {
    const direct = net[name];
    if (typeof direct !== "function") continue;
    net[name] = function tracedNetConnect(...args) {
      return traceSocket(direct.apply(this, args), "tcp", connectLabel(args));
    };
  }

  const directTlsConnect = tls.connect;
  tls.connect = function tracedTlsConnect(...args) {
    return traceSocket(
      directTlsConnect.apply(this, args),
      "tls",
      connectLabel(args),
    );
  };

  const directSpawn = childProcess.spawn;
  childProcess.spawn = function tracedSpawn(command, args, options) {
    const child = directSpawn.call(this, command, args, options);
    const end = beginOp(
      "spawn",
      `${path.basename(String(command))}${
        Array.isArray(args) && args.length > 0 ? ` ${args[0]}` : ""
      }`,
    );
    child.once("exit", (code, signal) => end(`exit ${signal || code}`));
    child.once("error", (error) => end(error?.code || error?.message || "error"));
    return child;
  };
}

installEnvironmentProxyTransports();
installContainedRipgrepBoundary();
installFirstTurnTracer();

// @cursor/sdk location: the engine passes an absolute path
// (ZEROS_CURSOR_SDK_ENTRY) resolved to the package's CJS entry — in a packaged
// app that's the app.asar.unpacked copy (its require closure reaches native
// bindings that can't be dlopen'd from inside asar — see electron-builder.yml's
// asarUnpack list, kept honest by `pnpm check:cursor-asar`). When unset (engine
// run from source with no Electron host) fall back to ordinary module
// resolution, which walks up to the repo node_modules.
const sdkEntry = process.env.ZEROS_CURSOR_SDK_ENTRY;
let sdk;
const sdkRequireStartedAt = Date.now();
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
// Loading the SDK is a multi-megabyte CJS bundle plus native bindings, and it
// happens lazily on the FIRST control request — so it sits on the critical path
// between ZSR admission and the session appearing, where it was previously
// indistinguishable from the boundary's own cost.
process.stderr.write(
  `[cursor-host] ready in ${Date.now() - hostStartedAt}ms ` +
    `(@cursor/sdk require=${Date.now() - sdkRequireStartedAt}ms)\n`,
);

const Agent = sdk && sdk.Agent;
const Cursor = sdk && sdk.Cursor;
const JsonlLocalAgentStore = sdk && sdk.JsonlLocalAgentStore;
const getDefaultSdkStateRoot = sdk && sdk.getDefaultSdkStateRoot;

// ── Workspace scan cache TTL ──────────────────────────────
//
// @cursor/sdk caches its scan of the workspace for rules, skills, AGENTS.md and
// ignore files, and expires it after 20s by default — a value tuned for an
// EDITOR, whose files change under it while the user works. Every expiry costs a
// full re-walk of the tree, which on a repo this size is seconds.
//
// That default undoes the prewarm. This host builds the workspace executor
// during session start precisely so the first turn doesn't pay for the walk; if
// the user opens a chat, reads for half a minute and then sends, the scan has
// already expired and the turn re-walks anyway. Widening the window keeps the
// warm scan alive across the gap between opening a chat and sending in it.
//
// THE TRADE IS FRESHNESS, and it is sharper here than in an editor because the
// agent edits the repo itself: a rule, skill or `.cursorignore` written DURING a
// session — by the user or by the agent — can go unseen for up to this long.
// Five minutes covers a realistic read-then-send gap without letting a session's
// own edits go stale for an unbounded time. It is not a correctness boundary:
// the scan governs which ambient rules load, not what a tool may touch.
//
// Precedence is deliberate: an explicit CURSOR_RIPWALK_CACHE_TTL_MS wins, so
// this only configures the dial when the operator has NOT set one. The SDK reads
// the configured value ahead of the env var (it is captured into the ripwalk
// cache when the local executor is built), so leaving it unset is the only way
// to let the environment through.
const WORKSPACE_SCAN_CACHE_TTL_MS = 5 * 60_000;
try {
  const configured = process.env.CURSOR_RIPWALK_CACHE_TTL_MS?.trim();
  const operatorSet =
    configured !== undefined &&
    configured !== "" &&
    Number.isFinite(Number(configured)) &&
    Number(configured) > 0;
  if (!operatorSet && typeof sdk.configureCursorSdk === "function") {
    sdk.configureCursorSdk({
      local: { workspaceScanCacheTtlMs: WORKSPACE_SCAN_CACHE_TTL_MS },
    });
  }
} catch (error) {
  // A rejected dial must never cost the session its host — the SDK validates
  // the value and throws, and the 20s default is a perfectly working fallback.
  process.stderr.write(
    `[cursor-host] workspace scan cache TTL left at the SDK default: ${
      error && error.message ? error.message : String(error)
    }\n`,
  );
}

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

// ── Workspace prewarm ─────────────────────────────────────
//
// @cursor/sdk 1.0.26 added `platform.prewarmLocalWorkspace(options)`: build the
// local executor — Cursor rules, skills, MCP, ignore mappings, and the backend
// auth/config round-trips they need — BEFORE the first `send()` instead of
// inside it. The SDK's own words: resolving a workspace "is the slowest part of
// a local agent's first turn, and on a large repo it dominates it."
//
// It is exactly the shape of the measured problem. A contained first turn spends
// its time on a SERIAL staircase of fresh connections to api2.cursor.sh (five
// `exchange_user_api_key` calls, `GetServerConfig`, statsig) plus a workspace
// scan — ~72% network, ~28% in-process — and none of it depends on the user's
// message. Meanwhile the host sits idle for ~9s between boot and the first
// prompt while admission, model discovery and `Agent.create` finish. Prewarming
// moves that work into the idle window.
//
// The executor cache is module-level and keyed on the options that SHAPE an
// executor (cwd, dirs, apiKey, settingSources, sandbox, autoReview, mcpServers,
// subagents), so a later `Agent.create` with the same options is a cache HIT.
// Passing anything different silently warms a different executor and the first
// turn still pays — so the adapter sends the identical option object it will
// create the agent with.
//
// The lease is reference counted; holding it keeps the executor alive for this
// host's lifetime, which is exactly one session. Prewarming is a pure
// optimization: every failure here is swallowed, and `send()` rebuilds.

/** Memoized platform handle — the prewarm entry point is a method on it. */
let platformPromise = null;
function getPlatform() {
  if (!platformPromise) {
    platformPromise = (async () => {
      if (typeof sdk.createAgentPlatform !== "function") return null;
      return sdk.createAgentPlatform(
        containedStateRoot ? { localStore: jsonlStoreAt(containedStateRoot) } : {},
      );
    })().catch(() => null);
  }
  return platformPromise;
}

/** Leases held for this host's lifetime. Releasing the last reference tears the
 *  executor down, which would hand the first turn back the cost we just paid. */
const prewarmLeases = [];

async function prewarmWorkspace(opts) {
  const platform = await getPlatform();
  if (!platform || typeof platform.prewarmLocalWorkspace !== "function") {
    return { prewarmed: false, reason: "unsupported" };
  }
  const startedAt = Date.now();
  const release = await platform.prewarmLocalWorkspace(withLocalStore(opts));
  if (typeof release === "function") prewarmLeases.push(release);
  const elapsed = Date.now() - startedAt;
  process.stderr.write(`[cursor-host] workspace prewarmed in ${elapsed}ms\n`);
  return { prewarmed: true, elapsedMs: elapsed };
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

/** Runs started by THIS host process. The first one pays every once-per-process
 *  cost @cursor/sdk defers to the first turn, so "cold" is the single most
 *  important qualifier on a slow first-item measurement. */
let runsStarted = 0;

/** Local acknowledgements rather than model output. The SDK's persisted run
 *  events show these landing at seq 1–2 within ~10ms of `send` even on a turn
 *  whose first token took 77s, so latency must be measured past them. */
const RUN_CONTROL_FRAME_TYPES = new Set(["request", "status"]);
function isRunControlFrame(msg) {
  return RUN_CONTROL_FRAME_TYPES.has(String(msg?.type ?? ""));
}

/** Report (and attribute) how long a run took to produce its first stream item.
 *  Quiet under SLOW_FIRST_ITEM_MS unless the transport debug flag is on, so
 *  ordinary turns add nothing to the log. */
function reportRunFirstItem(runId, timing, outcome) {
  if (!timing) return;
  const now = Date.now();
  const waited = now - timing.sentAt;
  if (waited < SLOW_FIRST_ITEM_MS && !cursorTransportDebug) return;
  reportFirstItemLatency(
    runId,
    timing.sentAt,
    now,
    `${timing.cold ? "cold host — first run in this process" : `run #${timing.index} in this process`}` +
      `; agent.send=${timing.sendMs}ms` +
      `; host up ${Math.round((timing.sentAt - hostStartedAt) / 1000)}s` +
      (outcome ? `; ${outcome}` : ""),
  );
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
function drainRun(runId, run, timing) {
  (async () => {
    let sawContent = false;
    try {
      for await (const msg of run.stream()) {
        // Measure to the first CONTENT item, not the first item. `request` and
        // `status` are local acknowledgements the SDK emits within ~10ms of
        // send — in the 77s stall they arrived on time and everything waited
        // behind them, so keying on "first item" would report nothing at all.
        if (!sawContent && !isRunControlFrame(msg)) {
          sawContent = true;
          reportRunFirstItem(runId, timing);
        }
        debugCursorTransport(
          `run ${runId} stream message (${String(msg?.type || "unknown")})`,
        );
        send({ k: "ev", ev: "run.msg", runId, msg });
      }
      // A run that ends without ever producing content still spent the whole
      // turn somewhere; attribute it rather than losing the only measurement.
      if (!sawContent) reportRunFirstItem(runId, timing, "no content streamed");
      const entry = runs.get(runId);
      if (entry && entry.run === run) entry.endedAt = Date.now();
      send({ k: "ev", ev: "run.streamEnd", runId });
    } catch (err) {
      if (!sawContent) reportRunFirstItem(runId, timing, "stream failed");
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
    case "platform.prewarm": {
      ok(id, await prewarmWorkspace(args));
      return;
    }
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
      const sendStartedAt = Date.now();
      const run = await agent.send(args.message, sendOptions);
      const timing = {
        index: ++runsStarted,
        cold: runsStarted === 1,
        sendMs: Date.now() - sendStartedAt,
        // The window to attribute opens at `send` (not at its return): a local
        // run's pre-turn work can happen on either side of that boundary.
        sentAt: sendStartedAt,
      };
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
      drainRun(runId, run, timing);
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
      debugCursorTransport(
        `run ${args.runId} wait completed (status=${String(
          res?.status || "unknown",
        )}, resultChars=${String(
          typeof res?.result === "string" ? res.result.length : 0,
        )})`,
      );
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
