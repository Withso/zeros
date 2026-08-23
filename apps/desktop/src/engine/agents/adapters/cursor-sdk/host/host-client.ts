// ──────────────────────────────────────────────────────────
// Cursor host client — engine-side driver for the Node @cursor/sdk subprocess
// ──────────────────────────────────────────────────────────
//
// The engine runs under bun, where @cursor/sdk's agent-run streaming is broken:
// it rides @connectrpc/connect-node → node:http2, and bun's node:http2 + TLS
// compat layer can't reliably connect to api2.cursor.sh (cert SAN mis-parse +
// flaky ALPN — see cursor-host.cjs for the full story). So instead of loading
// @cursor/sdk in-process, the engine spawns a tiny **Node** subprocess
// (cursor-host.cjs) that owns the SDK and talks to it over stdio with a
// newline-delimited JSON protocol.
//
// This module is the bun-side half. It exposes `getCursorHostModule()`, which
// returns an object shaped exactly like the slice of @cursor/sdk the adapter
// uses (CursorSdkModule) — Agent.create/resume/list, Cursor.models.list,
// localStore.open — but every call is proxied to the host subprocess.
// Because the adapter already programs against those structural interfaces, the
// adapter's logic (model resolution, classify, translator, retry) is unchanged:
// only the transport for the raw SDK calls moved out of process.
//
// Production sessions use one host per prepared ZSR boundary, so SDK tools,
// local MCP, plugins and shell descendants are causally contained. A shared
// host remains only for non-session probes and legacy direct-adapter tests.
//
// Runtime resolution reuses the PTY host's (set by apps/desktop/electron/sidecar.ts; both
// hosts just need a real Node, not bun):
//   - ZEROS_PTY_HOST_RUNTIME           binary that runs the host (the Electron
//                                      app binary, run as Node) — else `node`.
//   - ZEROS_PTY_HOST_RUNTIME_ELECTRON  "1" ⇒ add ELECTRON_RUN_AS_NODE=1.
//   - ZEROS_CURSOR_HOST_SCRIPT         absolute path to cursor-host.cjs — else
//                                      the sibling .cjs (source mode).
//   - ZEROS_CURSOR_SDK_ENTRY           absolute @cursor/sdk entry, forwarded to
//                                      the host (read there) — else "@cursor/sdk".
// ──────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  preserveAmbientConfigRoots,
  stripEngineAuthorityEnv,
} from "../../shared/config-isolation";
import type {
  BoundaryProcess,
  PreparedBoundary,
} from "../../../containment/types";
import type {
  CursorSdkModule,
  SdkAgent,
  SdkRun,
  CursorLocalStore,
  CursorModelListItem,
  CursorSdkSendOptions,
  CursorAgentUsage,
} from "../adapter";

/** A reconstructed SDK error carrying the fields the adapter's classifier
 *  keys on (status / name / code), rebuilt from the host's JSON serialization
 *  so auth / rate-limit / session-expired detection survives the boundary. */
export interface SerializedHostError {
  message?: string;
  name?: string;
  status?: number;
  code?: string;
}

/** `code` stamped on the rejection when the host process dies UNEXPECTEDLY
 *  (crash/kill — no `fatal` line). The classifier routes it to
 *  `transport-closed` (RECOVERABLE): the next call lazily respawns the host,
 *  so the renderer's silent rebuild+resend is the right response, not a hard
 *  error toast. A `fatal`-preceded death (e.g. @cursor/sdk failed to load)
 *  and a spawn failure stay untagged — a respawn would fail identically, so
 *  those remain terminal. */
export const CURSOR_HOST_EXITED_CODE = "CURSOR_HOST_EXITED";

/** `code` stamped when the crash-loop guard trips (MAX_CONSECUTIVE_EARLY_DEATHS
 *  boot crashes in a row). TERMINAL, but distinctly tagged so the classifier
 *  can attach `failure.advice` — the toast layer suppresses technical message
 *  detail, and advice is the only channel that still reaches the user. */
export const CURSOR_HOST_CRASH_LOOP_CODE = "CURSOR_HOST_CRASH_LOOP";

/** The user-facing fix instructions for a crash-looping host. Single source —
 *  embedded in the rejection message (logs) AND carried as `failure.advice`
 *  (toast description) by classifyCursorSdkError. */
export const CURSOR_HOST_CRASH_LOOP_ADVICE =
  "The Cursor SDK host keeps crashing at startup. Check [cursor-host] lines " +
  "in the engine log, reinstall the app/dependencies, or point " +
  "ZEROS_PTY_HOST_RUNTIME at a working Node.";

// ── Crash-loop guard ──────────────────────────────────────
// A host that dies EARLY (before its `ready` line, or within this window of
// spawn) is probably crash-looping (broken install, incompatible runtime) —
// respawning it on every message would machine-gun subprocesses forever.
/** Deaths within this many ms of spawn count as "early" (boot crashes). */
const EARLY_DEATH_WINDOW_MS = 5_000;
/** After this many CONSECUTIVE early deaths, rejections turn TERMINAL
 *  (CRASH_LOOP tag, not the recoverable EXITED tag) so the renderer stops
 *  silently retrying into a dead host and the user sees the actionable
 *  advice (failure.advice → toast description) instead. */
const MAX_CONSECUTIVE_EARLY_DEATHS = 3;
/** Exponential respawn hold-off after repeated early deaths (2nd: 1s,
 *  3rd: 2s, …, capped). Requests during the hold-off fail fast without
 *  spawning. A single early death gets NO hold-off — the renderer's one
 *  silent retry should still heal a one-off boot blip seamlessly. */
const RESPAWN_BACKOFF_BASE_MS = 1_000;
const RESPAWN_BACKOFF_CAP_MS = 30_000;
/** Ceiling on run.msg events buffered for a consumer that stopped iterating —
 *  see AsyncMsgQueue.push. */
const MAX_QUEUED_MSGS = 10_000;
/** Ceiling for a partial (un-newline-terminated) protocol line — see onLine. */
const MAX_PARTIAL_LINE_CHARS = 32 * 1024 * 1024;
/** A control-plane reply (create/resume/list/send/store) should arrive well
 * before a model turn completes. Bound it independently so a lost NDJSON
 * response or wedged HTTP/2 CONNECT cannot leave session admission in
 * `warming` forever. `run.wait` explicitly opts out because it spans the
 * user-visible model turn and is cancelled by the owning prompt lifecycle. */
const CONTROL_REQUEST_TIMEOUT_MS = 30_000;

type HostRunQueueItem =
  | { zerosCursorHostEvent: "message"; value: unknown }
  | { zerosCursorHostEvent: "delta"; value: unknown }
  | { zerosCursorHostEvent: "step"; value: unknown };

export function toHostError(e: SerializedHostError | undefined): Error {
  const err = new Error(e?.message ?? "cursor host error") as Error & {
    status?: number;
    code?: string;
  };
  if (e?.name) err.name = e.name;
  if (typeof e?.status === "number") err.status = e.status;
  if (e?.code != null) err.code = e.code;
  return err;
}

/** Single-consumer async queue fed by the host's `run.msg` events. The
 *  adapter iterates `run.stream()` exactly once, so a one-consumer queue is
 *  sufficient. push() appends + wakes; the iterator drains the buffer, then
 *  throws on failure, returns on end, else awaits the next wake. */
export class AsyncMsgQueue<T = unknown> {
  private buffer: T[] = [];
  private resolveNext: (() => void) | null = null;
  private ended = false;
  private failure: unknown = null;

  push(msg: T): void {
    if (this.ended || this.failure !== null) return;
    // The consumer (one adapter turn) normally drains as fast as the host
    // produces; a backlog this deep means the turn stopped iterating (retry
    // `continue`, cancel, classified failure) while the host keeps streaming.
    // Fail the stream instead of buffering decoded messages without bound.
    if (this.buffer.length >= MAX_QUEUED_MSGS) {
      this.fail(
        new Error(
          `cursor run stream backlog exceeded ${MAX_QUEUED_MSGS} messages with no consumer`,
        ),
      );
      this.buffer = [];
      return;
    }
    this.buffer.push(msg);
    this.wake();
  }
  end(): void {
    this.ended = true;
    this.wake();
  }
  fail(err: unknown): void {
    if (this.ended) return;
    this.failure = err ?? new Error("cursor run stream error");
    this.wake();
  }
  private wake(): void {
    const r = this.resolveNext;
    this.resolveNext = null;
    if (r) r();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    for (;;) {
      while (this.buffer.length > 0) yield this.buffer.shift() as T;
      if (this.failure !== null) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
  }
}

/** Minimal stdio transport the client drives. Abstracted so unit tests can
 *  inject an in-memory fake instead of a real subprocess. */
export interface HostTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  dispose(): void | Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function clearPendingTimer(pending: Pending): void {
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = undefined;
}

/** Drives one Cursor host subprocess: correlates request/response, routes run
 *  stream events to per-run queues, and surfaces host death cleanly. */
export class CursorHostClient {
  private transport: HostTransport | null = null;
  private buf = "";
  private nextReqId = 1;
  private nextRunId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queues = new Map<string, AsyncMsgQueue<HostRunQueueItem>>();
  /** Captured from a `fatal` line so the rejection that follows host death can
   *  explain WHY (e.g. @cursor/sdk couldn't load) instead of "host exited". */
  private fatalMessage: string | null = null;
  private spawnFailed = false;
  /** Crash-loop accounting: consecutive deaths that happened before the host
   *  proved healthy (`ready` seen AND ≥ EARLY_DEATH_WINDOW_MS uptime). A
   *  healthy death resets it. */
  private consecutiveEarlyDeaths = 0;
  /** Respawn hold-off deadline (ms epoch). While in the future, requests fail
   *  fast instead of spawning. */
  private respawnBlockedUntil = 0;
  private sawReady = false;
  private spawnedAt = 0;

  /** @param spawnTransport returns a fresh transport, or null when the host
   *  can't be located/spawned (→ requests fail with an actionable error). */
  constructor(private readonly spawnTransport: () => HostTransport | null) {}

  private ensure(): boolean {
    if (this.transport) return true;
    // Crash-loop hold-off: don't machine-gun respawns for a host that keeps
    // dying at boot. request() shapes the rejection (recoverable vs terminal).
    if (Date.now() < this.respawnBlockedUntil) {
      this.spawnFailed = false;
      return false;
    }
    this.fatalMessage = null;
    const t = this.spawnTransport();
    if (!t) {
      this.spawnFailed = true;
      return false;
    }
    this.spawnFailed = false;
    this.sawReady = false;
    this.spawnedAt = Date.now();
    this.transport = t;
    this.buf = "";
    t.onLine((line) => this.onLine(line));
    t.onExit(() => this.onExit());
    return true;
  }

  private onLine(chunk: string): void {
    // `chunk` is a raw stdout slice, NOT a whole line — chunks may arrive
    // coalesced (several lines) OR split mid-line (a line larger than the pipe
    // buffer, or under load). Append raw and let the loop below extract only
    // complete newline-terminated lines, leaving any trailing partial in
    // `this.buf` for the next chunk. Appending a `\n` here would force-terminate
    // a split line, so both halves fail JSON.parse and the message is dropped —
    // a lost `res` hangs a request forever, a lost `run.streamEnd` hangs the
    // stream. (Mirrors cursor-host.cjs's own stdin parser.)
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      const one = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (one.length > 0) this.dispatch(one);
      nl = this.buf.indexOf("\n");
    }
    // A newline never arriving (host wedged mid-write, garbage on stdout)
    // would grow this partial-line buffer without bound. Legit protocol lines
    // sit far below this cap; past it the line is already unparseable — drop
    // it rather than let the engine's memory follow a broken host.
    if (this.buf.length > MAX_PARTIAL_LINE_CHARS) {
      console.error(
        `[cursor-host] dropped ${this.buf.length}-char partial protocol line (no newline)`,
      );
      this.buf = "";
    }
  }

  private dispatch(line: string): void {
    let m: Record<string, unknown> | null = null;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!m || typeof m.k !== "string") return;
    switch (m.k) {
      case "ready":
        // Ready-line gate for the crash-loop guard: the host booted far
        // enough to load @cursor/sdk. A death before this line is always an
        // "early" (boot) crash regardless of timing.
        this.sawReady = true;
        return;
      case "fatal":
        this.fatalMessage = typeof m.message === "string" ? m.message : null;
        if (this.fatalMessage)
          console.error(`[cursor-host] fatal: ${this.fatalMessage}`);
        return;
      case "res": {
        const id = typeof m.id === "number" ? m.id : Number(m.id);
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearPendingTimer(p);
        if (m.ok) p.resolve(m.result);
        else p.reject(toHostError(m.error as SerializedHostError | undefined));
        return;
      }
      case "ev": {
        const runId = typeof m.runId === "string" ? m.runId : String(m.runId);
        const q = this.queues.get(runId);
        if (!q) return;
        if (m.ev === "run.msg") {
          q.push({ zerosCursorHostEvent: "message", value: m.msg });
        } else if (m.ev === "run.delta") {
          q.push({ zerosCursorHostEvent: "delta", value: m.update });
        } else if (m.ev === "run.step") {
          q.push({ zerosCursorHostEvent: "step", value: m.step });
        } else if (m.ev === "run.streamEnd") {
          q.end();
          this.queues.delete(runId);
        } else if (m.ev === "run.streamError") {
          q.fail(toHostError(m.error as SerializedHostError | undefined));
          this.queues.delete(runId);
        }
        return;
      }
      default:
        return;
    }
  }

  /** The host vanished: reject every in-flight request and fail every live run
   *  stream, then reset so the next call respawns. */
  private onExit(): void {
    this.transport = null;
    this.buf = "";
    // Crash-loop accounting. A death before the ready line, or within the
    // early window of spawn, counts toward the loop; a death after a healthy
    // run resets it (a long-lived host crashing once is a blip, not a loop).
    const uptime = Date.now() - this.spawnedAt;
    const early = !this.sawReady || uptime < EARLY_DEATH_WINDOW_MS;
    if (early) {
      this.consecutiveEarlyDeaths += 1;
      // No hold-off on the FIRST early death (the renderer's one silent
      // retry heals a one-off blip); exponential from the second.
      this.respawnBlockedUntil =
        this.consecutiveEarlyDeaths >= 2
          ? Date.now() +
            Math.min(
              RESPAWN_BACKOFF_CAP_MS,
              RESPAWN_BACKOFF_BASE_MS * 2 ** (this.consecutiveEarlyDeaths - 2),
            )
          : 0;
    } else {
      this.consecutiveEarlyDeaths = 0;
      this.respawnBlockedUntil = 0;
    }
    const crashLooping =
      this.consecutiveEarlyDeaths >= MAX_CONSECUTIVE_EARLY_DEATHS;
    const fatal = this.fatalMessage;
    const reason =
      fatal ?? "the Cursor SDK host (Node subprocess) exited unexpectedly";
    const err = new Error(
      crashLooping
        ? `cursor host: ${reason} — and has now crashed ` +
            `${this.consecutiveEarlyDeaths} times in a row at boot. Respawn is ` +
            `held off; it will be retried automatically. ` +
            CURSOR_HOST_CRASH_LOOP_ADVICE
        : `cursor host: ${reason}`,
    ) as Error & { code?: string };
    // Unexpected death (no fatal line) → recoverable: the next call respawns
    // the host, so classifyCursorSdkError routes this to transport-closed and
    // the renderer silently rebuilds + resends instead of a hard error toast.
    // TERMINAL otherwise — but distinctly tagged: a crash-looping host gets
    // CRASH_LOOP (classifier attaches the user-facing advice; stop feeding
    // the silent-retry loop), while a fatal-preceded death (respawn fails
    // identically) stays untagged.
    if (crashLooping) err.code = CURSOR_HOST_CRASH_LOOP_CODE;
    else if (!fatal) err.code = CURSOR_HOST_EXITED_CODE;
    for (const p of this.pending.values()) {
      clearPendingTimer(p);
      p.reject(err);
    }
    this.pending.clear();
    for (const q of this.queues.values()) q.fail(err);
    this.queues.clear();
  }

  request<T = unknown>(
    op: string,
    args: unknown,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.ensure()) {
      // Respawn hold-off (crash-loop guard): fail fast without spawning.
      // Below the loop threshold the rejection stays RECOVERABLE (a blip the
      // renderer may silently absorb); at the threshold it's TERMINAL with
      // the actionable message so the user isn't strung along. A death the
      // host itself declared fatal (this.fatalMessage — ensure() only clears
      // it when it actually spawns, so it still names the LAST death here) is
      // terminal at ANY count: a respawn would fail identically, so tagging
      // it recoverable would feed the silent-retry loop a known-broken host.
      const now = Date.now();
      if (!this.spawnFailed && now < this.respawnBlockedUntil) {
        const waitS = Math.max(
          1,
          Math.ceil((this.respawnBlockedUntil - now) / 1000),
        );
        const crashLooping =
          this.consecutiveEarlyDeaths >= MAX_CONSECUTIVE_EARLY_DEATHS;
        const fatal = this.fatalMessage;
        const err = new Error(
          `cursor host: ${fatal ?? "the Cursor SDK host"} — crashed ` +
            `${this.consecutiveEarlyDeaths} times in a row at boot — holding ` +
            `off respawn for ~${waitS}s.` +
            (crashLooping ? ` ${CURSOR_HOST_CRASH_LOOP_ADVICE}` : ""),
        ) as Error & { code?: string };
        if (crashLooping) err.code = CURSOR_HOST_CRASH_LOOP_CODE;
        else if (!fatal) err.code = CURSOR_HOST_EXITED_CODE;
        return Promise.reject(err);
      }
      return Promise.reject(
        new Error(
          "cursor host: couldn't start the Cursor SDK host (Node subprocess). " +
            "Cursor needs a Node runtime because the engine's bun runtime can't " +
            "establish the SDK's HTTP/2 connection. " +
            (this.spawnFailed
              ? "Set ZEROS_CURSOR_HOST_SCRIPT / ZEROS_PTY_HOST_RUNTIME, or run the packaged app."
              : ""),
        ),
      );
    }
    const id = this.nextReqId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      this.pending.set(id, pending);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.pending.delete(id);
          pending.timer = undefined;
          reject(
            new Error(
              `cursor host request ${op} timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      try {
        this.transport!.send(JSON.stringify({ k: "req", id, op, args }));
      } catch (err) {
        this.pending.delete(id);
        clearPendingTimer(pending);
        reject(err);
      }
    });
  }

  async dispose(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    for (const p of this.pending.values()) {
      clearPendingTimer(p);
      p.reject(new Error("cursor host: disposed"));
    }
    this.pending.clear();
    for (const q of this.queues.values()) q.end();
    this.queues.clear();
    if (t) await t.dispose();
  }

  // ── CursorSdkModule proxy ─────────────────────────────────

  private makeRun(
    runId: string,
    sdkRunId: string | null,
    queue: AsyncMsgQueue<HostRunQueueItem>,
    observers: Pick<CursorSdkSendOptions, "onDelta" | "onStep">,
  ): SdkRun {
    return {
      id: sdkRunId ?? undefined,
      stream: async function* () {
        for await (const item of queue) {
          if (item.zerosCursorHostEvent === "delta") {
            await observers.onDelta?.({ update: item.value });
          } else if (item.zerosCursorHostEvent === "step") {
            await observers.onStep?.({ step: item.value });
          } else {
            yield item.value;
          }
        }
      },
      wait: () =>
        this.request<Awaited<ReturnType<SdkRun["wait"]>> | null>(
          "run.wait",
          { runId },
          0,
        ).then((r) => r ?? undefined),
      cancel: async () => {
        try {
          await this.request<void>("run.cancel", { runId });
        } finally {
          // Cancellation is a hard local ordering boundary. End/delete first
          // so provider callbacks already in flight cannot mutate a stopped
          // turn after the host acknowledges the abort.
          queue.end();
          this.queues.delete(runId);
        }
      },
    };
  }

  private makeAgent(agentId: string): SdkAgent {
    return {
      agentId,
      send: async (
        message: unknown,
        options?: CursorSdkSendOptions,
      ): Promise<SdkRun> => {
        // Assign the runId + register its stream queue BEFORE the request, so a
        // run.msg event can never arrive before its queue exists.
        const runId = String(this.nextRunId++);
        const queue = new AsyncMsgQueue<HostRunQueueItem>();
        this.queues.set(runId, queue);
        const { onDelta, onStep, ...wireOptions } = options ?? {};
        try {
          const res = await this.request<{ sdkRunId: string | null }>(
            "agent.send",
            {
              agentId,
              runId,
              message,
              options: wireOptions,
              observers: {
                delta: typeof onDelta === "function",
                step: typeof onStep === "function",
              },
            },
          );
          return this.makeRun(runId, res?.sdkRunId ?? null, queue, {
            onDelta,
            onStep,
          });
        } catch (err) {
          this.queues.delete(runId);
          throw err;
        }
      },
      getUsage: (options) =>
        this.request<CursorAgentUsage>("agent.getUsage", {
          agentId,
          options: options ?? {},
        }),
      close: () => {
        // Fire-and-forget; swallow rejection (host may already be gone).
        void this.request("agent.close", { agentId }).catch(() => {});
      },
    };
  }

  private makeStore(storeId: string | null): CursorLocalStore {
    return {
      runs: {
        get: (input) =>
          storeId == null
            ? Promise.resolve(null)
            : this.request("store.runGet", {
                storeId,
                agentId: input.agentId,
                runId: input.runId,
              }),
      },
      dispose: () =>
        storeId == null
          ? Promise.resolve()
          : this.request<void>("store.dispose", { storeId }).then(() => {}),
    };
  }

  module(): CursorSdkModule {
    return {
      Agent: {
        create: async (opts) => {
          const res = await this.request<{ agentId: string }>(
            "agent.create",
            opts,
          );
          return this.makeAgent(res.agentId);
        },
        resume: async (agentId, opts) => {
          const res = await this.request<{ agentId: string }>("agent.resume", {
            agentId,
            opts: opts ?? {},
          });
          return this.makeAgent(res.agentId);
        },
        list: (opts) =>
          this.request<{ items?: Array<Record<string, unknown>> }>(
            "agent.list",
            { opts: opts ?? {} },
          ),
      },
      Cursor: {
        models: {
          list: (opts) =>
            this.request<CursorModelListItem[]>(
              "models.list",
              { opts: opts ?? {} },
            ),
        },
      },
      localStore: {
        open: async (opts) => {
          const res = await this.request<{ storeId: string | null }>(
            "store.open",
            opts,
          );
          return this.makeStore(res?.storeId ?? null);
        },
      },
      platform: {
        // Building the workspace executor can outlast the ordinary control
        // budget on a cold contained host — that IS the cost being moved off
        // the turn — and nothing waits on the reply, so it opts out of the
        // 30s timeout the way `run.wait` does.
        prewarm: (opts) =>
          this.request<{ prewarmed: boolean; elapsedMs?: number }>(
            "platform.prewarm",
            opts,
            Number.POSITIVE_INFINITY,
          ),
      },
    };
  }
}

// ── Real subprocess transport ─────────────────────────────

function resolveHostScript(): string | null {
  const explicit = process.env.ZEROS_CURSOR_HOST_SCRIPT;
  if (explicit && existsSync(explicit)) return explicit;
  // Source mode (`bun apps/desktop/src/cli.ts` with no Electron host): the .cjs sits next to
  // this module. import.meta.url is a real file URL there; in a bun-compiled
  // binary fileURLToPath throws, so this is best-effort.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.join(here, "cursor-host.cjs");
    if (existsSync(sibling)) return sibling;
  } catch {
    /* compiled binary — no source path on disk */
  }
  return null;
}

function resolveRuntime(): { cmd: string; electron: boolean } {
  const explicit = process.env.ZEROS_PTY_HOST_RUNTIME;
  if (explicit && explicit.length > 0) {
    return {
      cmd: explicit,
      electron: process.env.ZEROS_PTY_HOST_RUNTIME_ELECTRON === "1",
    };
  }
  return { cmd: "node", electron: false };
}

function resolveExecutable(command: string): string | null {
  if (path.isAbsolute(command)) return existsSync(command) ? command : null;
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The cwd to spawn the host subprocess in. **Must NOT be a git repository.**
 *
 * One host process serves EVERY Cursor session across EVERY worktree, so its
 * `process.cwd()` can't be any one session's directory. Per-session cwd is
 * carried as data instead: the adapter passes `local.cwd` into
 * `Agent.create`/`Agent.resume`, and @cursor/sdk's local executor roots shell
 * commands at `this.options.local.cwd`.
 *
 * The danger: that SDK lookup is `getCwd(this.options) ?? process.cwd()` — it
 * silently falls back to the HOST's process cwd whenever the per-agent cwd is
 * absent for ANY reason (an un-threaded code path, SDK version drift, a re-lease
 * before options settle). If the host inherited the engine's own repo root (the
 * default when spawned with no `cwd`), that fallback turns a missing cwd into an
 * agent running `git commit` / writing files inside Zeros' OWN source tree —
 * exactly the "commit landed in the root checkout instead of the worktree" bug.
 *
 * Anchoring the host at a neutral, guaranteed-non-repo dir makes the fallback
 * fail LOUD and HARMLESS instead (`fatal: not a git repository`, writes land in
 * a throwaway temp dir) — it never corrupts a real checkout. The happy path is
 * unchanged: when `local.cwd` is present (the norm), shells still run in the
 * worktree; this only changes where the *fallback* points.
 */
export function resolveHostCwd(): string {
  const override = process.env.ZEROS_CURSOR_HOST_CWD;
  if (override && override.length > 0) return override;
  return os.tmpdir();
}

export interface CursorHostSpawnOptions {
  executionBoundary: PreparedBoundary;
  cwd: string;
  /** Complete, already-scrubbed provider environment. */
  env: Record<string, string>;
}

export function spawnSubprocessTransport(
  options?: CursorHostSpawnOptions,
): HostTransport | null {
  const script = resolveHostScript();
  if (!script) {
    console.error(
      "[cursor-host] cannot locate cursor-host.cjs (set ZEROS_CURSOR_HOST_SCRIPT) — Cursor unavailable",
    );
    return null;
  }
  const runtime = resolveRuntime();
  const cmd = options ? resolveExecutable(runtime.cmd) : runtime.cmd;
  if (!cmd) {
    console.error(
      `[cursor-host] cannot resolve host runtime ${runtime.cmd} to an absolute executable`,
    );
    return null;
  }
  // A session host receives the gateway's complete environment verbatim
  // (minus engine authority). The legacy shared probe host constructs ambient
  // compatibility here because it has no session admission edge.
  const env: Record<string, string> = options
    ? stripEngineAuthorityEnv({ ...options.env })
    : preserveAmbientConfigRoots({
        ...(process.env as Record<string, string>),
      });
  if (options) {
    // Cursor's SDK uses global fetch plus Node's HTTP/1 transport during
    // Agent.create. Node does not consult HTTP(S)_PROXY by default, so a
    // contained host otherwise attempts a direct socket that the kernel fence
    // correctly denies before SRT can authenticate and inspect the request.
    // Electron 43 embeds Node 24, whose built-in proxy support covers fetch,
    // http.request and https.request when enabled at process startup.
    env.NODE_USE_ENV_PROXY = "1";
  }
  if (runtime.electron) env.ELECTRON_RUN_AS_NODE = "1";

  // cwd is deliberately a non-repo dir — see resolveHostCwd(). NEVER inherit the
  // engine's cwd here, or a missing per-agent cwd corrupts the Zeros repo.
  const hostCwd = options?.cwd ?? resolveHostCwd();

  const launch = options?.executionBoundary.wrapSpawn({
    command: cmd,
    args: [script],
    cwd: hostCwd,
    env,
    stdio: "pipe",
  });

  let child: ChildProcess;
  try {
    child = spawn(launch?.command ?? cmd, launch?.args ?? [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: launch?.env ?? env,
      cwd: launch?.cwd ?? hostCwd,
      detached: Boolean(options),
    });
  } catch (err) {
    console.error(
      `[cursor-host] failed to spawn host runtime (${cmd}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  const boundaryProcess: BoundaryProcess | undefined =
    options?.executionBoundary.trackProcess(child);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const s = String(chunk).replace(/\s+$/, "");
    if (s) console.error(`[cursor-host] ${s}`);
  });

  return {
    send: (line: string) => {
      if (child.stdin && !child.stdin.destroyed) {
        try {
          child.stdin.write(line + "\n");
        } catch {
          /* pipe broke — onExit reconciles */
        }
      }
    },
    onLine: (cb) => {
      child.stdout?.on("data", (chunk: string) => cb(chunk));
    },
    onExit: (cb) => {
      child.on("exit", () => cb());
      child.on("error", (err) => {
        console.error(`[cursor-host] runtime error: ${err.message}`);
        cb();
      });
    },
    dispose: async () => {
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      if (!child.killed && !boundaryProcess) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
      if (boundaryProcess) {
        await boundaryProcess.stopAndProve();
      }
    },
  };
}

export interface CursorHostRuntime {
  module: CursorSdkModule;
  dispose(): Promise<void>;
}

/** Create a dedicated Cursor host rooted below one prepared execution
 * boundary. No singleton or in-process escape hatch is used on this path. */
export function createCursorHostRuntime(
  options: CursorHostSpawnOptions,
): CursorHostRuntime {
  const client = new CursorHostClient(() => spawnSubprocessTransport(options));
  return { module: client.module(), dispose: () => client.dispose() };
}

let singleton: CursorHostClient | null = null;

/** The shared CursorSdkModule backed by the Node host subprocess. */
export function getCursorHostModule(): CursorSdkModule {
  if (!singleton) singleton = new CursorHostClient(spawnSubprocessTransport);
  return singleton.module();
}

/** Tear down the host subprocess (engine stop + process-exit safety net). */
export function disposeCursorHost(): void {
  void singleton?.dispose();
  singleton = null;
}

// Safety net: if the engine exits without an explicit stop, take the host down
// too so it never strands an orphan. The host also self-exits on stdin EOF.
process.once("exit", () => disposeCursorHost());
