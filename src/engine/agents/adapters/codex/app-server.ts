// ──────────────────────────────────────────────────────────
// Codex app-server runtime — long-lived JSON-RPC over stdio.
// ──────────────────────────────────────────────────────────
//
// Replaces per-turn `codex exec --json` spawning with one long-lived
// `codex app-server` child per Zeros session. JSON-RPC 2.0 over stdio,
// line-delimited (no length-prefix). Uses the shared stdio JSON-RPC
// fabric (adapters/shared/{stdio-process,jsonrpc}.ts) — process-group
// signal handling + JsonRpcStdioClient.
//
// Protocol summary (verified against the codex version pinned in
// `package.json#codexProtocolVersion`; generated bindings at
// `./generated/v2/`):
//   - Client → Server requests: initialize, thread/start, thread/resume,
//     turn/start, turn/interrupt, account/*, mcpServer/*, etc.
//     (~80 methods total).
//   - Client → Server notifications: only `initialized` (post-init).
//   - Server → Client requests: item/{commandExecution,fileChange,
//     permissions}/requestApproval, account/chatgptAuthTokens/refresh,
//     attestation/generate.
//   - Server → Client notifications: ~60 events including thread/started,
//     turn/{started,completed}, item/{started,completed}, item/agentMessage/
//     delta, item/reasoning/textDelta, item/commandExecution/outputDelta,
//     item/fileChange/patchUpdated, error, account/{updated,rateLimits/
//     updated,login/completed}, warning, deprecationNotice.
//
// Lifecycle:
//   bootCodexAppServerRuntime(opts)
//     → spawn child, run handshake (initialize + initialized + version check)
//     → returns CodexAppServerHandle
//     → caller: startThread() | resumeThread() → runTurn() → dispose()
//
// Min CLI version: 0.131.0
// (per docs/archive/codex-app-server-migration-2026-05-24.md).
// Below that, the initialize handshake completes but several methods we
// need (permissionProfile/list, codex_hooks → hooks migration) are
// missing or buggy. We refuse to boot.
//
// Error handling:
//   - JSON-RPC error -32001 ("Server overloaded; retry later"):
//     exponential backoff with jitter, max 3 retries.
//   - Process exit before initialize completes: throw with stderr tail.
//   - Initialize response carries no `protocolVersion` field — version
//     check uses the `userAgent` string (e.g. "codex_cli 0.133.0").
//
// ──────────────────────────────────────────────────────────

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

import { spawnStdioAgent, type StdioAgentProcess } from "../shared/stdio-process";
import type { McpServerRegistration } from "../../types";
import { JsonRpcStdioClient, JsonRpcRequestError } from "../shared/jsonrpc";
import { buildSpawnEnvWithLoginPath } from "../shared/login-shell-path";
import { resolveCodexBinary, type CodexBinarySource } from "./binary-resolver";
import { PERMISSION_RESPONSE_TIMEOUT_MS } from "../shared/constants";

// ── Type re-exports (subset of generated bindings) ─────────

/** `userAgent` string returned by `initialize`. e.g. "codex_cli 0.133.0" */
export interface CodexInitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ── Wire types: re-exported from generated bindings ──────
//
// Every type below is sourced from `./generated/v2/*`, which is
// regenerated from the upstream openai/codex Rust protocol source on
// every `pnpm build:engine` (or manually via `pnpm codegen:codex`).
// We alias them with our `Codex…` prefix so call sites keep their
// historical naming, but the SHAPES come straight from the upstream
// `ts-rs` export — no more hand-transcribing serde attributes and
// drifting on casing (the bug class we hit twice in three days
// before this codegen landed).
//
// Pinned version lives in `package.json#codexProtocolVersion`.

import type { SandboxMode as GenSandboxMode } from "./generated/v2/SandboxMode";
import type { SandboxPolicy as GenSandboxPolicy } from "./generated/v2/SandboxPolicy";
import type { AskForApproval as GenAskForApproval } from "./generated/v2/AskForApproval";
import type { UserInput as GenUserInput } from "./generated/v2/UserInput";
import type { ThreadStartParams as GenThreadStartParams } from "./generated/v2/ThreadStartParams";
import type { TurnStartParams as GenTurnStartParams } from "./generated/v2/TurnStartParams";

/** Content blocks accepted by `turn/start.input`. */
export type CodexUserInput = GenUserInput;

/** SandboxMode — used by `thread/start.sandbox` (a plain kebab-case
 *  string like `"workspace-write"`). */
export type CodexSandboxMode = GenSandboxMode;

/** SandboxPolicy — used by `turn/start.sandboxPolicy` AND returned
 *  as `thread/start.sandbox` in the response. Internally-tagged on
 *  `type` with camelCase variant + field names. */
export type CodexSandboxPolicy = GenSandboxPolicy;

/** AskForApproval — used by `approvalPolicy` on both thread/start
 *  and turn/start. Kebab-case strings for unit variants, single-key
 *  `{ "granular": {...} }` map for the Granular variant. */
export type CodexApprovalPolicy = GenAskForApproval;

/** `thread/start` params. */
export type CodexThreadStartParams = GenThreadStartParams;

/** `turn/start` params. */
export type CodexTurnStartParams = GenTurnStartParams;

/** Server-initiated approval request shape passed to the adapter.
 *  The adapter stores `permissionId` for routing and eventually calls
 *  `runtime.respondToPermission(permissionId, response)` with a payload
 *  whose shape matches `method`:
 *
 *    item/commandExecution/requestApproval → CommandExecutionRequestApprovalResponse
 *    item/fileChange/requestApproval       → FileChangeRequestApprovalResponse
 *    item/permissions/requestApproval      → PermissionsRequestApprovalResponse
 *
 *  Per the codex generated bindings at `./generated/v2/` (version pinned
 *  in `package.json#codexProtocolVersion`). */
export interface CodexApprovalRequest {
  /** Stable id Zeros mints; survives across method-specific decision
   *  shapes (used as the lookup key in respondToPermission). */
  permissionId: string;
  /** Server method name — tells the adapter which response shape to send. */
  method: CodexApprovalMethod;
  params: Record<string, unknown>;
}

export type CodexApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval";

/** A server-initiated blocking user-input question (item/tool/requestUserInput).
 *  Twin of CodexApprovalRequest — the answer is deferred until
 *  respondToUserInput(questionId, response). */
export interface CodexUserInputRequest {
  /** Stable id Zeros mints; the lookup key for respondToUserInput. */
  questionId: string;
  /** Raw ToolRequestUserInputParams. */
  params: Record<string, unknown>;
}

export interface CodexAppServerBootOptions {
  /** Working directory for the codex process. */
  cwd: string;
  /** Optional cliBinary override (Settings → Providers → Advanced). */
  cliBinary?: string;
  /** Extra env to layer on top of process.env + login-shell PATH. */
  env?: Record<string, string>;
  /** Client identity reported in `initialize.clientInfo`. */
  clientInfo: { name: string; version: string; title?: string };
  /** MCP servers to register via `-c mcp_servers.<name>.…` overrides at
   *  spawn time. No mutation of `~/.codex/config.toml` — config is
   *  per-process only. */
  mcpServers?: readonly McpServerRegistration[];
  /** Server-initiated approval request received. Fired synchronously
   *  inside the JSON-RPC handler — the response is deferred until
   *  `respondToPermission(permissionId, response)` is called. If unset,
   *  every approval is auto-denied with a stderr log line. */
  onApprovalRequest?: (request: CodexApprovalRequest) => void;
  /** Server-initiated blocking user-input question received (item/tool/
   *  requestUserInput). Fired synchronously; the response is deferred until
   *  `respondToUserInput(questionId, response)`. If unset, answers empty. */
  onUserInputRequest?: (request: CodexUserInputRequest) => void;
  /** A pending user-input question settled WITHOUT a respondToUserInput
   *  call — its response timeout fired and the codex side was answered
   *  empty. Lets the adapter evict its own pending entry and tell the
   *  renderer to drop the parked card. */
  onUserInputSettled?: (questionId: string) => void;
  /** Called with each line the server writes to stderr. */
  onStderr?: (line: string) => void;
  /** Called when the server exits (gracefully or otherwise). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Forwarded to the JSON-RPC client for debug logging. */
  logTag?: string;
}

export interface CodexAppServerHandle {
  /** What initialize returned. Includes userAgent string we parse for
   *  the version check. */
  readonly initializeResponse: CodexInitializeResponse;

  /** Detected CLI version (e.g. "0.133.0") parsed from userAgent. Null
   *  if parsing failed — caller may decide to refuse anyway. */
  readonly cliVersion: string | null;

  /** Binary source for diagnostics. */
  readonly binarySource: CodexBinarySource;

  /** Underlying child process — exposed for diagnostics (pid, exit). */
  readonly child: ChildProcess;

  /** Start a new conversation thread. Returns the threadId the server
   *  assigned, plus the resolved policy/model so the caller can render
   *  the initial state. */
  startThread(params: CodexThreadStartParams): Promise<{
    threadId: string;
    model: string;
    approvalPolicy: CodexApprovalPolicy;
    sandbox: CodexSandboxPolicy;
    raw: unknown;
  }>;

  /** Resume a prior thread by id. Subsequent turns continue on the
   *  same conversation. `model` is the thread's resolved model when the
   *  server reports it (used as the collaboration-mode fallback). */
  resumeThread(params: { threadId: string } & Partial<CodexThreadStartParams>): Promise<{
    threadId: string;
    model?: string;
    raw: unknown;
  }>;

  /** Send a turn. Resolves ONLY when the server emits `turn/completed`
   *  (or `error`) for the started turn — NOT when `turn/start` returns
   *  its acknowledgment. Per the codex app-server contract,
   *  `turn/start` returns immediately with `status: "inProgress"` and
   *  completion arrives asynchronously via the notification stream.
   *
   *  Two-pronged correlation:
   *    1. The `turn/start` response carries the turnId — `onTurnStarted`
   *       fires synchronously once we know it, so the adapter can
   *       capture it on session state for `interruptTurn` and the UI's
   *       activeTurnId tracking.
   *    2. We then await the `turn/completed` notification matching
   *       that turnId.
   *
   *  Race-safe: if `turn/completed` arrives between when the response
   *  resolves and the runtime registers its waiter, the notification
   *  is buffered for ~5s so the awaiter sees it. */
  runTurn(
    params: CodexTurnStartParams,
    opts?: {
      /** Fires synchronously once the turnId is known (from the
       *  `turn/start` response, before completion). Use this to set
       *  `session.activeTurnId` so cancel() can route. */
      onTurnStarted?: (turnId: string) => void;
    },
  ): Promise<{
    turnId: string;
    status: "completed" | "failed" | "cancelled";
    raw: unknown;
  }>;

  /** Cancel the current turn — request the server interrupt; turn
   *  resolves with status="cancelled". */
  interruptTurn(threadId: string, turnId: string): Promise<void>;

  /** Resolve a pending approval request the adapter received via
   *  `onApprovalRequest`. The `response` shape MUST match the
   *  request's `method`:
   *    item/commandExecution/requestApproval → { decision: ... }
   *    item/fileChange/requestApproval       → { decision: ... }
   *    item/permissions/requestApproval      → { permissions, scope }
   *  No-op if the permissionId is unknown (already responded or
   *  dispatched by dispose). */
  respondToPermission(permissionId: string, response: unknown): void;

  /** Resolve a pending user-input question the adapter received via
   *  `onUserInputRequest`. `response` MUST be a ToolRequestUserInputResponse
   *  ({ answers: { [questionId]: { answers: string[] } } }). No-op if unknown. */
  respondToUserInput(questionId: string, response: unknown): void;

  /** Subscribe to a server-to-client notification by method name.
   *  Returns an unsubscribe function. Multiple subscribers per method
   *  are supported (fan-out). */
  onNotification(method: string, handler: (params: unknown) => void): () => void;

  /** Send a one-off JSON-RPC request (escape hatch for methods the
   *  handle doesn't wrap explicitly — account/read, model/list, etc.). */
  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;

  /** Tear down: stop the in-flight turn, close JSON-RPC, kill child. */
  dispose(): Promise<void>;
}

const MIN_CLI_VERSION = "0.131.0";
const INITIALIZE_TIMEOUT_MS = 15_000;
const RPC_DEFAULT_TIMEOUT_MS = 60_000;
const OVERLOAD_MAX_RETRIES = 3;
const OVERLOAD_RETRY_BASE_MS = 500;
// No fixed wall-clock limit on a Codex turn: goal-style runs may work for
// hours as long as the app-server keeps sending progress. This watchdog only
// fails a turn after a quiet app-server for the same 30-minute window used by
// approval/question auto-cancel.
const TURN_INACTIVITY_TIMEOUT_MS = PERMISSION_RESPONSE_TIMEOUT_MS;
// Cap on how long we'll hold an in-flight approval waiting for the
// renderer to respond. The renderer normally responds within seconds
// — if it doesn't (window closed, IPC drop, runaway render loop),
// the turn would otherwise stay parked indefinitely. Settling
// with `cancel` releases the codex side promptly. Source of truth is
// PERMISSION_RESPONSE_TIMEOUT_MS in shared/constants.ts so all
// adapters share one cap.
const APPROVAL_TIMEOUT_MS = PERMISSION_RESPONSE_TIMEOUT_MS;

/** Boot a codex app-server. Resolves with a ready-to-use handle once
 *  the initialize handshake succeeds and the version check passes.
 *  Throws on:
 *    - binary resolution failure
 *    - process exits before initialize completes
 *    - initialize timeout (15s)
 *    - CLI version < 0.131.0
 */
export async function bootCodexAppServerRuntime(
  opts: CodexAppServerBootOptions,
): Promise<CodexAppServerHandle> {
  const logTag = opts.logTag ?? "codex-app-server";

  const binarySource = await resolveCodexBinary({ override: opts.cliBinary });
  const env = await buildSpawnEnvWithLoginPath(opts.env);

  // The binary-resolver returns either an executable path or the
  // wrapper script `bin/codex.js`. For the latter, we need to spawn
  // via node so it runs.
  const [command, baseArgs] = binarySource.path.endsWith(".js")
    ? [process.execPath, [binarySource.path]]
    : [binarySource.path, []];

  const mcpArgs = buildMcpServerOverrides(opts.mcpServers ?? []);

  // Feature overrides (per-process `-c`, no ~/.codex/config.toml mutation):
  //   • default_mode_request_user_input — codex only puts the
  //     `request_user_input` tool in the model's toolset in PLAN collaboration
  //     mode (ModeKind::allows_request_user_input); Zeros threads run in the
  //     default mode, so without this flag the model literally cannot ask a
  //     blocking question ("I can't call request_user_input in this mode" —
  //     field report 2026-07-04). Upstream stage: UnderDevelopment,
  //     default-off — pairs with `capabilities.experimentalApi` in the
  //     initialize handshake below (the server↔client half of the channel).
  //   • suppress_unstable_features_warning — the flag above makes codex
  //     append "Warning: Under-development features enabled…" to EVERY
  //     turn's output (it rendered into each chat transcript — field report
  //     2026-07-04). We enabled the feature deliberately; the per-turn
  //     banner is pure noise for the user.
  const featureArgs = [
    "-c",
    "features.default_mode_request_user_input=true",
    "-c",
    "suppress_unstable_features_warning=true",
  ];

  const proc = spawnStdioAgent({
    command,
    args: [...baseArgs, "app-server", ...featureArgs, ...mcpArgs],
    cwd: opts.cwd,
    env,
    logTag,
  });

  // Wire stderr fan-out BEFORE the handshake so startup banners are
  // captured for diagnostics if the boot fails.
  if (proc.child.stderr) {
    proc.child.stderr.setEncoding("utf-8");
    let stderrBuf = "";
    let stderrTail = "";
    proc.child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      stderrTail = (stderrTail + chunk).slice(-4096);
      // M9: cap an un-newlined stderr line so a runaway child can't OOM us.
      if (stderrBuf.length > 8 * 1024 * 1024) {
        const nlOverflow = stderrBuf.indexOf("\n");
        stderrBuf = nlOverflow === -1 ? "" : stderrBuf.slice(nlOverflow + 1);
        return;
      }
      let nl = stderrBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) opts.onStderr?.(line);
        nl = stderrBuf.indexOf("\n");
      }
    });
    // Stash tail on proc so failure paths can include it.
    Object.defineProperty(proc, "_stderrTail", { get: () => stderrTail });
  }

  // RPC tracing is opt-in: `turn/start` params carry user prompt text
  // (and image metadata), so unconditional console.log would violate
  // the prompts-stay-out-of-production-logs rule. Set DEBUG_CODEX_RPC=1
  // to enable; even then we redact `params.input` before printing.
  const rpcTraceEnabled = process.env.DEBUG_CODEX_RPC === "1";
  // Turn inactivity listeners are registered by runTurn() after the
  // `turn/start` ack. Any inbound JSON-RPC frame from this per-session
  // app-server counts as activity: streamed output, progress, warnings,
  // approval/user-input requests, or terminal completion.
  const turnActivityListeners = new Set<() => void>();
  const touchActiveTurnActivity = (): void => {
    for (const touch of turnActivityListeners) {
      try {
        touch();
      } catch {
        /* activity accounting must never break JSON-RPC dispatch */
      }
    }
  };

  const client = new JsonRpcStdioClient(proc.child, {
    logTag,
    defaultTimeoutMs: RPC_DEFAULT_TIMEOUT_MS,
    onOutbound: rpcTraceEnabled
      ? (line) => {
          if (line.length < 2_000)
            console.log(`[${logTag}] OUT ${truncate(redactRpcLine(line), 400)}`);
        }
      : undefined,
    onInbound: (line) => {
      touchActiveTurnActivity();
      if (rpcTraceEnabled && line.length < 2_000) {
        console.log(`[${logTag}] IN  ${truncate(redactRpcLine(line), 400)}`);
      }
    },
  });

  // ── Handshake: initialize ─────────────────────────────────
  let initResp: CodexInitializeResponse;
  try {
    initResp = await client.request<CodexInitializeResponse>(
      "initialize",
      {
        clientInfo: {
          name: opts.clientInfo.name,
          version: opts.clientInfo.version,
          title: opts.clientInfo.title ?? null,
        },
        capabilities: {
          // Opt into experimental API methods — REQUIRED for the blocking
          // question channel: `item/tool/requestUserInput` (and its whole
          // Tool* payload family) is marked EXPERIMENTAL in the app-server
          // protocol and is only offered when the client declares it can
          // handle it. Without this the model itself refuses ("I can't open
          // the question-card tool from this mode") because the tool is
          // never in its toolset. Safe to enable broadly: our JSON-RPC
          // client answers any UNHANDLED experimental server→client request
          // with a clean -32601 (no hang), and unknown notifications drop.
          experimentalApi: true,
        },
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    );
  } catch (err) {
    await teardown(proc, client);
    throw wrapBootError("initialize", err, (proc as unknown as { _stderrTail?: string })._stderrTail);
  }

  const cliVersion = parseCliVersion(initResp.userAgent);
  if (cliVersion && compareSemver(cliVersion, MIN_CLI_VERSION) < 0) {
    await teardown(proc, client);
    throw new Error(
      `codex CLI ${cliVersion} is too old for the app-server adapter. ` +
        `Upgrade to >= ${MIN_CLI_VERSION} via 'npm install -g @openai/codex@latest'.`,
    );
  }

  // ── Handshake: initialized notification ──────────────────
  //
  // Codex app-server requires the client to send `initialized` once
  // after the initialize response. Until we do, the server holds back
  // some notifications (e.g. account/updated).
  client.notify("initialized", {});

  // ── Approval round-trip: ACP-style permissionId resolver map ──
  //
  // Server fires `item/{commandExecution,fileChange,permissions}/
  // requestApproval` as a JSON-RPC request. We:
  //   1. mint a Zeros permissionId (returned to the adapter so
  //      respondToPermission can route).
  //   2. create a deferred Promise; resolve from JSON-RPC handler
  //      returns the decision back as the response.
  //   3. fire `opts.onApprovalRequest({permissionId, method, params})`
  //      synchronously — the adapter pushes to its session-side map
  //      and emits a Zeros permission request to the gateway.
  //   4. respondToPermission(permissionId, response) resolves the
  //      Promise → JSON-RPC sends back the response.
  //
  // If the adapter never set onApprovalRequest, every approval auto-
  // denies (safe default — also the path the integration test relies on
  // since it doesn't wire an approval handler).
  //
  // 2026-05-28: added APPROVAL_TIMEOUT_MS so the codex side isn't held
  // open indefinitely when the renderer never responds (window closed,
  // IPC drop, hung event loop). On timeout we settle the codex side
  // with cancel and remove the pending entry. The adapter's pendingApprovals
  // map will also have a stale entry which respondToPermission tolerates.
  interface PendingApprovalEntry {
    resolve: (response: unknown) => void;
    method: CodexApprovalMethod;
    /** setTimeout handle so respondToPermission can clear it. */
    timer: NodeJS.Timeout;
  }
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  const wireApproval = (method: CodexApprovalMethod) => {
    client.onRequest(method, (params) => {
      return new Promise<unknown>((resolve) => {
        const permissionId = randomUUID();
        if (!opts.onApprovalRequest) {
          // No adapter handler — auto-deny with the method-appropriate shape.
          console.warn(
            `[${logTag}] ${method} received but no onApprovalRequest set — auto-denying`,
          );
          resolve(defaultDenyResponse(method));
          return;
        }
        const timer = setTimeout(() => {
          if (!pendingApprovals.has(permissionId)) return;
          pendingApprovals.delete(permissionId);
          console.warn(
            `[${logTag}] approval ${permissionId} (${method}) timed out after ${APPROVAL_TIMEOUT_MS}ms — auto-cancelling`,
          );
          // Settle with cancel rather than deny so the codex turn ends
          // cleanly (cancel is the explicit "user gave up" path; deny
          // suggests an active rejection by the user, which would be
          // misleading).
          resolve(defaultCancelResponse(method));
        }, APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        pendingApprovals.set(permissionId, { resolve, method, timer });
        // A blocking approval is healthy activity, but it can legitimately
        // wait for the full approval timeout. Reset after arming that timer
        // so the inactivity watchdog cannot beat the auto-cancel timer.
        touchActiveTurnActivity();
        opts.onApprovalRequest({
          permissionId,
          method,
          params: (params ?? {}) as Record<string, unknown>,
        });
      });
    });
  };
  wireApproval("item/commandExecution/requestApproval");
  wireApproval("item/fileChange/requestApproval");
  wireApproval("item/permissions/requestApproval");

  // ── User-input round-trip (item/tool/requestUserInput) ──
  // Twin of the approval flow: a blocking question whose answer is deferred
  // until respondToUserInput. No cancel variant exists in the response schema,
  // so timeout / dispose / no-handler all answer `{ answers: {} }` (empty).
  interface PendingUserInputEntry {
    resolve: (response: unknown) => void;
    timer: NodeJS.Timeout;
  }
  const pendingUserInputs = new Map<string, PendingUserInputEntry>();
  client.onRequest("item/tool/requestUserInput", (params) => {
    return new Promise<unknown>((resolve) => {
      const questionId = randomUUID();
      if (!opts.onUserInputRequest) {
        resolve({ answers: {} });
        return;
      }
      const timer = setTimeout(() => {
        if (!pendingUserInputs.has(questionId)) return;
        pendingUserInputs.delete(questionId);
        console.warn(
          `[${logTag}] user-input ${questionId} timed out after ${APPROVAL_TIMEOUT_MS}ms — answering empty`,
        );
        resolve({ answers: {} });
        // The renderer's card is still parked on this id — tell the adapter
        // so it evicts the pending entry and the UI drops the card.
        opts.onUserInputSettled?.(questionId);
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      pendingUserInputs.set(questionId, { resolve, timer });
      // Same ordering as approvals: the question may sit open for the whole
      // timeout, so reset the inactivity watchdog after the auto-empty timer
      // is armed.
      touchActiveTurnActivity();
      opts.onUserInputRequest({
        questionId,
        params: (params ?? {}) as Record<string, unknown>,
      });
    });
  });

  // ── Fan-out for general notifications ────────────────────
  const notifSubscribers = new Map<string, Set<(params: unknown) => void>>();
  const subscribe = (method: string, handler: (params: unknown) => void): (() => void) => {
    let set = notifSubscribers.get(method);
    if (!set) {
      set = new Set();
      notifSubscribers.set(method, set);
      client.onNotification(method, (params) => {
        const subs = notifSubscribers.get(method);
        if (!subs) return;
        for (const sub of subs) {
          try {
            sub(params);
          } catch (err) {
            console.warn(`[${logTag}] notification handler '${method}' threw: ${String(err)}`);
          }
        }
      });
    }
    set.add(handler);
    return () => {
      const subs = notifSubscribers.get(method);
      subs?.delete(handler);
    };
  };

  // ── Track turn lifecycle for runTurn correlation ─────────
  //
  // Per the codex app-server protocol, `turn/start` returns
  // **immediately** with `status: "inProgress"` (the response is an
  // acknowledgment, not a completion). The actual final status arrives
  // via the `turn/completed` notification, or via `error` for failure
  // modes (auth refresh, network) that close the turn server-side.
  //
  // runTurn() therefore:
  //   1. Sends `turn/start` and awaits the ack response → captures
  //      turnId, fires `onTurnStarted`, sets session.activeTurnId.
  //   2. Awaits a turnId-keyed `turn/completed` (or `error`) notification.
  //
  // **Race window**: the JSON-RPC stdout reader could surface
  // `turn/completed` synchronously between when our await resolves
  // and when runTurn registers its waiter. To survive that window we
  // buffer completions by turnId for 5s — runTurn checks the buffer
  // first before awaiting.
  const turnWaiters = new Map<
    string,
    {
      resolve: (status: "completed" | "failed" | "cancelled") => void;
      touchActivity: () => void;
    }
  >();
  const pendingTurnCompletions = new Map<
    string,
    "completed" | "failed" | "cancelled"
  >();

  const recordCompletion = (
    turnId: string,
    status: "completed" | "failed" | "cancelled",
  ): void => {
    const w = turnWaiters.get(turnId);
    if (w) {
      turnWaiters.delete(turnId);
      w.resolve(status);
      return;
    }
    // No waiter yet — buffer in case runTurn() is about to register.
    pendingTurnCompletions.set(turnId, status);
    setTimeout(() => pendingTurnCompletions.delete(turnId), 5_000).unref?.();
  };

  subscribe("turn/completed", (params) => {
    const p = params as { threadId?: string; turn?: { id?: string; status?: string } };
    const turnId = p?.turn?.id;
    if (!turnId) return;
    const status = p.turn?.status;
    // Generated TurnStatus has no "cancelled" — a user abort is
    // "interrupted". The old "cancelled" compare was dead, so Cancel was
    // recorded as a normal completion.
    recordCompletion(
      turnId,
      status === "failed" ? "failed" : status === "interrupted" ? "cancelled" : "completed",
    );
  });
  subscribe("error", (params) => {
    const p = params as { threadId?: string; turnId?: string; willRetry?: boolean };
    // willRetry=true means codex will retry the SAME turn — settling it as
    // terminal here would orphan/duplicate the still-running turn (runTurn
    // would resolve early while codex keeps streaming the retry).
    if (p.willRetry === true) return;
    if (p.turnId) {
      recordCompletion(p.turnId, "failed");
      return;
    }
    // (Low) A server-level error with NO turnId would otherwise be ignored,
    // leaving the turn hung until the inactivity watchdog fires (composer
    // locked). Fail all in-flight turns so the UI unlocks promptly.
    console.warn(
      `[codex-app-server] error without turnId — failing all pending turns: ${JSON.stringify(p)}`,
    );
    for (const w of turnWaiters.values()) w.resolve("failed");
    turnWaiters.clear();
  });

  // ── Exit cleanup ──────────────────────────────────────────
  void proc.exited.then(({ code, signal }) => {
    client.close(`codex exited code=${code} signal=${signal ?? ""}`);
    for (const w of turnWaiters.values()) w.resolve("failed");
    turnWaiters.clear();
    opts.onExit?.(code, signal);
  });

  // ── Public handle ─────────────────────────────────────────
  let disposed = false;

  const requestWithRetry = async <T>(
    method: string,
    params: unknown,
    rpcOpts?: { timeoutMs?: number },
  ): Promise<T> => {
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt <= OVERLOAD_MAX_RETRIES) {
      try {
        return await client.request<T>(method, params, rpcOpts);
      } catch (err) {
        lastErr = err;
        if (err instanceof JsonRpcRequestError && err.code === -32001) {
          // Server overloaded. Back off with jitter.
          const wait = OVERLOAD_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
          console.warn(`[${logTag}] server overloaded on ${method}; retrying in ${wait}ms (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, wait));
          attempt++;
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`codex ${method} failed after ${OVERLOAD_MAX_RETRIES + 1} attempts`);
  };

  return {
    initializeResponse: initResp,
    cliVersion,
    binarySource,
    child: proc.child,

    async startThread(params) {
      const result = await requestWithRetry<{
        thread: { id: string };
        model: string;
        approvalPolicy: CodexApprovalPolicy;
        // ThreadStartResponse.sandbox is the legacy SandboxPolicy object
        // (matches codex-rs/app-server-protocol/v2/thread.rs) even though
        // the *request* takes a SandboxMode string. We only read the
        // shape here for diagnostics — passing it through unchanged.
        sandbox: CodexSandboxPolicy;
      }>("thread/start", params);
      return {
        threadId: result.thread.id,
        model: result.model,
        approvalPolicy: result.approvalPolicy,
        sandbox: result.sandbox,
        raw: result,
      };
    },

    async resumeThread(params) {
      const result = await requestWithRetry<{
        thread: { id: string };
        model?: string;
      }>("thread/resume", params);
      return {
        threadId: result.thread.id,
        ...(typeof result.model === "string" ? { model: result.model } : {}),
        raw: result,
      };
    },

    async runTurn(params, runOpts) {
      // Step 1 — send `turn/start` and await its ACKNOWLEDGMENT.
      //
      // Per the codex app-server contract, this response carries the
      // freshly-allocated turnId and `status: "inProgress"`. The
      // actual final status arrives later via the `turn/completed`
      // notification.
      //
      // The RPC timeout here is short (60s default) because the ack
      // should be near-instant. After that there is no wall-clock turn
      // limit; only the inactivity watchdog below can fail a quiet turn.
      const ack = await requestWithRetry<{
        turn: { id: string; status: string };
      }>("turn/start", params);
      const turnId = ack.turn.id;
      runOpts?.onTurnStarted?.(turnId);

      // Fast-path: in rare cases the ack may already carry a terminal
      // status (server caught a validation failure synchronously, or
      // returned a cached completion). Use it directly.
      const ackStatus = ack.turn.status;
      if (
        ackStatus === "completed" ||
        ackStatus === "failed" ||
        ackStatus === "cancelled"
      ) {
        return {
          turnId,
          status: ackStatus as "completed" | "failed" | "cancelled",
          raw: ack,
        };
      }

      // Step 2 — await `turn/completed` (or `error`) for this turnId.
      //
      // The notification may have arrived BETWEEN the ack landing on
      // our event loop and us registering the waiter — that's why the
      // notification handlers buffer into `pendingTurnCompletions`.
      // Check the buffer first.
      const buffered = pendingTurnCompletions.get(turnId);
      if (buffered) {
        pendingTurnCompletions.delete(turnId);
        return { turnId, status: buffered, raw: ack };
      }

      // Long goal runs can legitimately last hours. Do not cap total turn
      // duration; fail only when the app-server goes quiet for the inactivity
      // window, which catches lost/missed `turn/completed` without killing a
      // healthy long-running turn.
      const finalStatus = await new Promise<"completed" | "failed" | "cancelled">(
        (resolve) => {
          let timer: NodeJS.Timeout | null = null;
          const cleanup = () => {
            if (timer) clearTimeout(timer);
            timer = null;
            turnActivityListeners.delete(touchActivity);
          };
          const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              if (turnWaiters.delete(turnId)) {
                cleanup();
                console.warn(
                  `[${logTag}] turn ${turnId}: no app-server activity for ${TURN_INACTIVITY_TIMEOUT_MS}ms; treating as failed`,
                );
                resolve("failed");
              }
            }, TURN_INACTIVITY_TIMEOUT_MS);
            timer.unref?.();
          };
          const touchActivity = () => arm();
          turnActivityListeners.add(touchActivity);
          arm();
          turnWaiters.set(turnId, {
            resolve: (status) => {
              cleanup();
              resolve(status);
            },
            touchActivity,
          });
        },
      );
      return { turnId, status: finalStatus, raw: ack };
    },

    async interruptTurn(threadId, turnId) {
      await client
        .request("turn/interrupt", { threadId, turnId }, { timeoutMs: 5_000 })
        .catch(() => {
          /* best-effort; if it fails the dispose() path catches it */
        });
    },

    respondToPermission(permissionId, response) {
      const pending = pendingApprovals.get(permissionId);
      if (!pending) {
        // Already responded (e.g. via dispose's cancel-all sweep, or
        // the approval timeout fired) or an unknown id — no-op.
        // Logged at debug so dev can correlate.
        console.log(`[${logTag}] respondToPermission: unknown id ${permissionId}`);
        return;
      }
      pendingApprovals.delete(permissionId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    },

    respondToUserInput(questionId, response) {
      const pending = pendingUserInputs.get(questionId);
      if (!pending) {
        console.log(`[${logTag}] respondToUserInput: unknown id ${questionId}`);
        return;
      }
      pendingUserInputs.delete(questionId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    },

    onNotification(method, handler) {
      return subscribe(method, handler);
    },

    request<T>(method: string, params?: unknown, rpcOpts?: { timeoutMs?: number }) {
      return requestWithRetry<T>(method, params ?? {}, rpcOpts);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // Settle any in-flight approval requests before the JSON-RPC
      // client closes so the server doesn't see an abrupt stream
      // disconnect mid-request (avoids stuck threads server-side).
      for (const [permissionId, pending] of pendingApprovals) {
        clearTimeout(pending.timer);
        pending.resolve(defaultCancelResponse(pending.method));
        pendingApprovals.delete(permissionId);
      }
      for (const [questionId, pending] of pendingUserInputs) {
        clearTimeout(pending.timer);
        pending.resolve({ answers: {} });
        pendingUserInputs.delete(questionId);
      }
      for (const w of turnWaiters.values()) w.resolve("cancelled");
      turnWaiters.clear();
      client.close("dispose");
      await proc.stop();
    },
  };
}

// ── Internal helpers ─────────────────────────────────────────

async function teardown(proc: StdioAgentProcess, client: JsonRpcStdioClient): Promise<void> {
  client.close("boot failure");
  await proc.stop();
}

function wrapBootError(stage: string, err: unknown, stderrTail?: string): Error {
  const inner = err instanceof Error ? err.message : String(err);
  const tail = stderrTail ? `\nstderr tail:\n${stderrTail.slice(-1024)}` : "";
  return new Error(`codex app-server boot failed at ${stage}: ${inner}${tail}`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…(${s.length - n} more)`;
}

/** Redact prompt-bearing fields from a JSON-RPC line before logging.
 *  Currently scrubs `params.input` (turn/start) — the only field that
 *  carries user text. If the line is not valid JSON or has no input,
 *  the original line is returned unchanged. */
function redactRpcLine(line: string): string {
  try {
    const obj = JSON.parse(line) as {
      params?: { input?: unknown };
      method?: string;
    };
    if (obj.params && Array.isArray(obj.params.input)) {
      obj.params.input = `[redacted ${obj.params.input.length} input parts]`;
      return JSON.stringify(obj);
    }
    return line;
  } catch {
    return line;
  }
}

/** Extract a semver-shaped version from the userAgent string. The
 *  upstream format is roughly "codex_cli 0.133.0" or "codex-cli/0.133.0";
 *  match either. Returns null when parsing fails — caller decides
 *  whether to proceed defensively. */
function parseCliVersion(userAgent: string): string | null {
  const m = userAgent.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

/** Translate Zeros-registered MCP servers into `-c` overrides codex's
 *  config loader accepts. Codex parses `-c key=value` where value is
 *  TOML — strings need quoting. Codex INFERS the transport from the keys
 *  (`command` ⇒ stdio, `url` ⇒ Streamable HTTP — there is NO `type` field), so
 *  an http server becomes:
 *
 *    -c mcp_servers.<name>.url="<url>"
 *    -c mcp_servers.<name>.http_headers={ "K" = "v" }   (if any)
 *
 *  and a stdio server emits `.command`/`.args`/`.env`. Per the codex 0.32+ MCP
 *  config schema. */
export function buildMcpServerOverrides(servers: readonly McpServerRegistration[]): string[] {
  const args: string[] = [];
  for (const s of servers) {
    // Names go into TOML keys; only allow alnum + underscore + dash to
    // avoid syntax injection. Skip silently rather than throw — a
    // misconfigured MCP entry shouldn't kill the boot.
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) continue;
    const base = `mcp_servers.${s.name}`;
    // Codex infers the transport from the keys — `command` ⇒ stdio,
    // `url` ⇒ Streamable HTTP (no `type` field). Each `-c` value is parsed as
    // TOML, so arrays/tables are emitted as TOML literals.
    if (s.transport === "http") {
      args.push("-c", `${base}.url="${escapeTomlString(s.url)}"`);
      if (s.headers && Object.keys(s.headers).length > 0) {
        args.push("-c", `${base}.http_headers=${tomlInlineTable(s.headers)}`);
      }
    } else {
      args.push("-c", `${base}.command="${escapeTomlString(s.command)}"`);
      if (s.args && s.args.length > 0) {
        args.push("-c", `${base}.args=${tomlStringArray(s.args)}`);
      }
      if (s.env && Object.keys(s.env).length > 0) {
        args.push("-c", `${base}.env=${tomlInlineTable(s.env)}`);
      }
    }
  }
  return args;
}

/** TOML array-of-strings literal for a `-c` value, e.g. `["-y", "pkg"]`. */
function tomlStringArray(items: readonly string[]): string {
  return `[${items.map((a) => `"${escapeTomlString(a)}"`).join(", ")}]`;
}

/** TOML inline-table literal for a `-c` value, e.g. `{ "K" = "v" }`. Keys are
 *  quoted so header names with hyphens (`X-Foo`) stay valid. */
function tomlInlineTable(table: Record<string, string>): string {
  const entries = Object.entries(table).map(
    ([k, v]) => `"${escapeTomlString(k)}" = "${escapeTomlString(v)}"`,
  );
  return `{ ${entries.join(", ")} }`;
}

/** Escape a string for TOML embedding inside `key="value"`. TOML basic strings
 *  forbid raw control characters, so we escape ALL of them — not just \n/\t.
 *  A raw CR/backspace/formfeed/NUL in a header or env value would otherwise
 *  produce invalid TOML and fail the ENTIRE Codex `-c` parse (every MCP server
 *  on the command line, not just the offending one). Order matters: the
 *  backslash escape must run first so it doesn't double-escape the others. */
function escapeTomlString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\f/g, "\\f")
    // eslint-disable-next-line no-control-regex -- intentional: escape backspace
    .replace(/\x08/g, "\\b")
    // Any remaining C0 control char (incl. NUL) -> \uXXXX (TOML basic-string escape).
    // eslint-disable-next-line no-control-regex -- intentional: escape all C0 controls
    .replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Method-appropriate "auto-deny" response when no approval handler is
 *  registered. Used as a safe default. */
/** The response sent when an approval has NO adapter handler wired (auto-deny)
 *  — must reject, never grant. Exported for unit tests. */
export function defaultDenyResponse(method: CodexApprovalMethod): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      // No granted permissions, scope ="turn" — the server interprets
      // an empty grant as "user declined the extra permission ask".
      return {
        permissions: { network: { enabled: false }, fileSystem: { read: [], write: [] } },
        scope: "turn",
      };
  }
}

/** Response used on approval TIMEOUT and during dispose to settle in-flight
 *  approvals so the server doesn't see a stream disconnect mid-request — the
 *  "user gave up" path, never a grant. Exported for unit tests. */
export function defaultCancelResponse(method: CodexApprovalMethod): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "cancel" };
    case "item/permissions/requestApproval":
      return defaultDenyResponse(method);
  }
}
