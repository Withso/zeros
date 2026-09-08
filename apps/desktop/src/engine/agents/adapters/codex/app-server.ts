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
//   - Client → Server requests: 156 generated methods. This harness wraps the
//     interactive lifecycle directly and keeps the rest available only to
//     typed, Codex-only engine integrations.
//   - Client → Server notifications: only `initialized` (post-init).
//   - Server → Client requests: all 11 methods are deliberately handled or
//     provider-conditional; none can silently strand the app-server.
//   - Server → Client notifications: 83 generated events including thread/started,
//     turn/{started,completed}, item/{started,completed}, item/agentMessage/
//     delta, item/reasoning/textDelta, item/commandExecution/outputDelta,
//     item/fileChange/patchUpdated, error, account/{updated,rateLimits/
//     updated,login/completed}, warning, and deprecationNotice. See
//     protocol-coverage.json for the exact canonical/handled/forwarded split.
//
// Lifecycle:
//   bootCodexAppServerRuntime(opts)
//     → spawn child, run handshake (initialize + initialized + version check)
//     → returns CodexAppServerHandle
//     → caller: startThread() | resumeThread() → runTurn() → dispose()
//
// Min CLI version: 0.131.0.
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

import {
  spawnStdioAgent,
  type StdioAgentProcess,
} from "../shared/stdio-process";
import type { McpServerRegistration } from "../../types";
import type { PreparedBoundary } from "../../containment/types";
import { hasKernelExecutionBoundary } from "../../containment/status";
import {
  JSON_RPC_NO_RESPONSE,
  JsonRpcStdioClient,
  JsonRpcRequestError,
} from "../shared/jsonrpc";
import { buildSpawnEnvWithLoginPath } from "../shared/login-shell-path";
import { resolveCodexBinary, type CodexBinarySource } from "./binary-resolver";
import { PERMISSION_RESPONSE_TIMEOUT_MS } from "../shared/constants";
import { MAX_PENDING_MCP_ELICITATIONS } from "../shared/mcp-elicitation";

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
import type { ThreadStartResponse as GenThreadStartResponse } from "./generated/v2/ThreadStartResponse";
import type { ThreadResumeResponse as GenThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
import type { TurnStartParams as GenTurnStartParams } from "./generated/v2/TurnStartParams";
import type { ReviewStartParams as GenReviewStartParams } from "./generated/v2/ReviewStartParams";
import type { AttestationGenerateResponse as GenAttestationGenerateResponse } from "./generated/v2/AttestationGenerateResponse";
import type { ChatgptAuthTokensRefreshParams as GenChatgptAuthTokensRefreshParams } from "./generated/v2/ChatgptAuthTokensRefreshParams";
import type { ChatgptAuthTokensRefreshResponse as GenChatgptAuthTokensRefreshResponse } from "./generated/v2/ChatgptAuthTokensRefreshResponse";
import type { CurrentTimeReadResponse as GenCurrentTimeReadResponse } from "./generated/v2/CurrentTimeReadResponse";
import type { DynamicToolCallParams as GenDynamicToolCallParams } from "./generated/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse as GenDynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse";
import type { ClientRequest as GenClientRequest } from "./generated/ClientRequest";
import type { InitializeCapabilities as GenInitializeCapabilities } from "./generated/InitializeCapabilities";
import type { ServerNotificationEnvelope as GenServerNotificationEnvelope } from "./generated/ServerNotificationEnvelope";
import type { ServerRequest as GenServerRequest } from "./generated/ServerRequest";

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

/** Method/params pairs derived directly from the generated app-server unions.
 * Product integrations can opt into these helpers without adding an arbitrary
 * string RPC surface to a renderer or shared Zeros protocol. */
export type CodexClientRequestMethod = GenClientRequest["method"];
export type CodexClientRequestParams<Method extends CodexClientRequestMethod> =
  Extract<GenClientRequest, { method: Method }>["params"];
export type CodexServerNotificationMethod =
  GenServerNotificationEnvelope["method"];
export type CodexServerNotificationParams<
  Method extends CodexServerNotificationMethod,
> = Extract<GenServerNotificationEnvelope, { method: Method }>["params"];

type CodexHostRequestResponses = {
  "account/chatgptAuthTokens/refresh": GenChatgptAuthTokensRefreshResponse;
  "attestation/generate": GenAttestationGenerateResponse;
  "currentTime/read": GenCurrentTimeReadResponse;
  "item/tool/call": GenDynamicToolCallResponse;
};

type CodexHostRequestMethod = keyof CodexHostRequestResponses;
type CodexHostRequestParams<Method extends CodexHostRequestMethod> = Extract<
  GenServerRequest,
  { method: Method }
>["params"];

type CodexHostRequestRegistrar = Pick<JsonRpcStdioClient, "onRequest">;

function registerTypedCodexHostRequest<Method extends CodexHostRequestMethod>(
  client: CodexHostRequestRegistrar,
  method: Method,
  handler: (
    params: CodexHostRequestParams<Method>,
  ) =>
    | CodexHostRequestResponses[Method]
    | Promise<CodexHostRequestResponses[Method]>,
): void {
  client.onRequest(method, async (params) =>
    handler(params as CodexHostRequestParams<Method>),
  );
}

export interface CodexHostRequestOptions {
  /** Injectable only for deterministic tests; runtime callers use Date.now. */
  now?: () => number;
  /** Execute a client-defined tool advertised through thread/start. */
  onDynamicToolCall?: (
    params: GenDynamicToolCallParams,
  ) => Promise<GenDynamicToolCallResponse> | GenDynamicToolCallResponse;
  /** External-host token refresh for Codex's explicit
   * `chatgptAuthTokens` login mode. This must never be wired to an unrelated
   * Zeros application token. */
  refreshChatgptAuthTokens?: (
    params: GenChatgptAuthTokensRefreshParams,
  ) =>
    | Promise<GenChatgptAuthTokensRefreshResponse>
    | GenChatgptAuthTokensRefreshResponse;
  /** Optional upstream attestation provider. */
  generateAttestation?: () =>
    | Promise<GenAttestationGenerateResponse>
    | GenAttestationGenerateResponse;
}

export function buildInitializeCapabilities({
  requestAttestation,
}: {
  requestAttestation: boolean;
}): GenInitializeCapabilities {
  return {
    experimentalApi: true,
    requestAttestation,
    mcpServerOpenaiFormElicitation: true,
  };
}

/** Register generated, server-initiated host requests that do not belong to
 * the approval/question lifecycle. Optional providers remain explicit seams;
 * their absence never borrows credentials or capabilities from Zeros. */
export function registerCodexHostRequestHandlers(
  client: CodexHostRequestRegistrar,
  options: CodexHostRequestOptions = {},
): void {
  const now = options.now ?? Date.now;
  registerTypedCodexHostRequest(client, "currentTime/read", () => ({
    currentTimeAt: Math.floor(now() / 1_000),
  }));
  registerTypedCodexHostRequest(client, "item/tool/call", async (params) => {
    if (!options.onDynamicToolCall) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "No host handler is registered for this dynamic tool.",
          },
        ],
      };
    }
    try {
      return await options.onDynamicToolCall(params);
    } catch (error) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: `Dynamic tool failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  });
  if (options.refreshChatgptAuthTokens) {
    registerTypedCodexHostRequest(
      client,
      "account/chatgptAuthTokens/refresh",
      async (params) =>
        validateChatgptAuthTokensRefreshResponse(
          await options.refreshChatgptAuthTokens!(params),
        ),
    );
  }
  if (options.generateAttestation) {
    registerTypedCodexHostRequest(client, "attestation/generate", async () => {
      const response = await options.generateAttestation!();
      if (!response || typeof response.token !== "string" || !response.token) {
        throw new Error(
          "The host attestation provider returned an empty token.",
        );
      }
      return response;
    });
  }
}

function validateChatgptAuthTokensRefreshResponse(
  response: GenChatgptAuthTokensRefreshResponse,
): GenChatgptAuthTokensRefreshResponse {
  if (
    !response ||
    typeof response.accessToken !== "string" ||
    !response.accessToken ||
    typeof response.chatgptAccountId !== "string" ||
    !response.chatgptAccountId ||
    (response.chatgptPlanType !== null &&
      typeof response.chatgptPlanType !== "string")
  ) {
    throw new Error(
      "The ChatGPT authentication provider returned an invalid refresh response.",
    );
  }
  return response;
}

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
  | "item/permissions/requestApproval"
  /** Deprecated v1 request names remain in the pinned generated schema and
   * can still surface from migrated sessions / compatibility feature flags. */
  | "execCommandApproval"
  | "applyPatchApproval";

export type CodexUserInputMethod =
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request";

/** A server-initiated blocking question. This covers Codex's own
 *  item/tool/requestUserInput and MCP form/URL elicitation. Twin of
 *  CodexApprovalRequest — the answer is deferred until
 *  respondToUserInput(questionId, response). */
export interface CodexUserInputRequest {
  /** Stable id Zeros mints; the lookup key for respondToUserInput. */
  questionId: string;
  /** Peer-authored JSON-RPC id, retained for replay/cancellation correlation. */
  rpcRequestId: string;
  method: CodexUserInputMethod;
  /** Exact engine-side deadline for the parked JSON-RPC resolver. */
  expiresAt?: number;
  /** Raw method-specific params. */
  params: Record<string, unknown>;
}

export interface CodexAppServerBootOptions {
  /** Working directory for the codex process. */
  cwd: string;
  /** Optional cliBinary override (Settings → Providers → Advanced). */
  cliBinary?: string;
  /** Extra env to layer on top of process.env + login-shell PATH. */
  env?: Record<string, string>;
  /** Zeros-owned outer process boundary for this app-server and every child. */
  executionBoundary?: PreparedBoundary;
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
  /** A pending approval settled WITHOUT a respondToPermission call — its
   *  response timeout fired, or `dispose()` auto-cancelled it — and the codex
   *  side is already answered. Twin of onUserInputSettled: lets the adapter
   *  evict its own pending entry, drop the renderer's parked card, and keep the
   *  engine's re-adoption replay set from re-presenting a gate nothing can
   *  answer. */
  onApprovalSettled?: (permissionId: string) => void;
  /** Server-initiated blocking user-input question received (Codex native
   *  question or MCP elicitation). Fired synchronously; the response is
   *  deferred until `respondToUserInput(questionId, response)`. If unset, the
   *  request is answered with its safe empty/cancel response. */
  onUserInputRequest?: (request: CodexUserInputRequest) => void;
  /** A pending user-input question settled WITHOUT a respondToUserInput
   *  call — timeout, server-side resolution, or dispose. Lets the adapter
   *  evict its own pending entry and tell the renderer to drop the card. */
  onUserInputSettled?: (questionId: string) => void;
  /** Execute an experimental client-defined tool advertised on thread/start. */
  onDynamicToolCall?: CodexHostRequestOptions["onDynamicToolCall"];
  /** External-host refresh for the explicit `chatgptAuthTokens` mode. */
  refreshChatgptAuthTokens?: CodexHostRequestOptions["refreshChatgptAuthTokens"];
  /** Presence opts into upstream attestation during initialize. */
  generateAttestation?: CodexHostRequestOptions["generateAttestation"];
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
    providerSessionId: string;
    gitInfo?: {
      sha: string | null;
      branch: string | null;
      originUrl: string | null;
    } | null;
    model: string;
    approvalPolicy: CodexApprovalPolicy;
    sandbox: CodexSandboxPolicy;
    raw: unknown;
  }>;

  /** Resume a prior thread by id. Subsequent turns continue on the
   *  same conversation. `model` is the thread's resolved model when the
   *  server reports it (used as the collaboration-mode fallback). */
  resumeThread(
    params: { threadId: string } & Partial<CodexThreadStartParams>,
  ): Promise<{
    threadId: string;
    providerSessionId: string;
    gitInfo?: {
      sha: string | null;
      branch: string | null;
      originUrl: string | null;
    } | null;
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

  /** Start Codex's native reviewer inline on an existing thread and settle on
   * the same turn-completion channel as an ordinary turn. */
  runReview(
    params: GenReviewStartParams,
    opts?: { onTurnStarted?: (turnId: string) => void },
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
   *  `onUserInputRequest`. The response must match the originating method
   *  (ToolRequestUserInputResponse or McpServerElicitationRequestResponse).
   *  No-op if unknown. */
  respondToUserInput(questionId: string, response: unknown): void;

  /** Subscribe to a server-to-client notification by method name.
   *  Returns an unsubscribe function. Multiple subscribers per method
   *  are supported (fan-out). */
  onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void;

  /** Send a one-off JSON-RPC request (escape hatch for methods the
   *  handle doesn't wrap explicitly — account/read, model/list, etc.). */
  request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T>;

  /** Generated method/params dispatch for Codex-only engine integrations.
   * This remains inside the adapter and is not a renderer capability bridge. */
  requestTyped<Method extends CodexClientRequestMethod, Result = unknown>(
    method: Method,
    params: CodexClientRequestParams<Method>,
    opts?: { timeoutMs?: number },
  ): Promise<Result>;

  /** Generated notification dispatch for Codex-only engine integrations. */
  onNotificationTyped<Method extends CodexServerNotificationMethod>(
    method: Method,
    handler: (params: CodexServerNotificationParams<Method>) => void,
  ): () => void;

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

/** Per-process Codex configuration. A ZSR child cannot access the host
 * keychain by design, so both Codex and MCP OAuth refreshes must remain in the
 * generation-private CODEX_HOME owned for that contained session. */
export function codexAppServerFeatureArgs(contained: boolean): string[] {
  return [
    "-c",
    "features.default_mode_request_user_input=true",
    "-c",
    "suppress_unstable_features_warning=true",
    ...(contained
      ? [
          "-c",
          'cli_auth_credentials_store="file"',
          "-c",
          'mcp_oauth_credentials_store="file"',
        ]
      : []),
  ];
}

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
  //     default mode, so without this flag the model cannot ask a blocking
  //     question. Upstream stage: UnderDevelopment,
  //     default-off — pairs with `capabilities.experimentalApi` in the
  //     initialize handshake below (the server↔client half of the channel).
  //   • suppress_unstable_features_warning — the flag above makes codex
  //     append "Warning: Under-development features enabled…" to EVERY
  //     turn's output. We enabled the feature deliberately; the per-turn
  //     banner is pure noise for the user.
  const featureArgs = codexAppServerFeatureArgs(
    hasKernelExecutionBoundary(opts.executionBoundary),
  );

  const proc = spawnStdioAgent({
    command,
    args: [...baseArgs, "app-server", ...featureArgs, ...mcpArgs],
    cwd: opts.cwd,
    env,
    executionBoundary: opts.executionBoundary,
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
      // Cap an un-newlined stderr line so a runaway child cannot exhaust memory.
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
            console.log(
              `[${logTag}] OUT ${truncate(redactCodexRpcLine(line), 400)}`,
            );
        }
      : undefined,
    onInbound: (line) => {
      touchActiveTurnActivity();
      if (rpcTraceEnabled && line.length < 2_000) {
        console.log(
          `[${logTag}] IN  ${truncate(redactCodexRpcLine(line), 400)}`,
        );
      }
    },
  });
  registerCodexHostRequestHandlers(client, {
    onDynamicToolCall: opts.onDynamicToolCall,
    refreshChatgptAuthTokens: opts.refreshChatgptAuthTokens,
    generateAttestation: opts.generateAttestation,
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
        // The helper keeps experimental question/dynamic-tool delivery on and
        // advertises attestation only when its host request can be answered.
        capabilities: buildInitializeCapabilities({
          requestAttestation: !!opts.generateAttestation,
        }),
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    );
  } catch (err) {
    await teardown(proc, client);
    throw wrapBootError(
      "initialize",
      err,
      (proc as unknown as { _stderrTail?: string })._stderrTail,
    );
  }

  const cliVersion = parseCliVersion(initResp.userAgent);
  if (cliVersion && compareSemver(cliVersion, MIN_CLI_VERSION) < 0) {
    await teardown(proc, client);
    throw new Error(
      `codex CLI ${cliVersion} is too old for the app-server adapter. ` +
        `Upgrade to >= ${MIN_CLI_VERSION} via 'npm install -g @openai/codex@latest'.`,
    );
  }

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
  // IPC drop, hung event loop). On timeout we settle the codex side with
  // cancel, remove the pending entry, and fire onApprovalSettled so the
  // adapter drops its twin entry instead of leaving one for a later
  // respondToPermission to merely tolerate.
  interface PendingApprovalEntry {
    resolve: (response: unknown) => void;
    method: CodexApprovalMethod;
    rpcRequestId: string;
    /** setTimeout handle so respondToPermission can clear it. */
    timer: NodeJS.Timeout;
  }
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  const pendingApprovalByRpcId = new Map<string, string>();
  const wireApproval = (method: CodexApprovalMethod) => {
    client.onRequest(method, (params, context) => {
      return new Promise<unknown>((resolve) => {
        const permissionId = randomUUID();
        const rpcRequestId = String(context.id);
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
          pendingApprovalByRpcId.delete(rpcRequestId);
          console.warn(
            `[${logTag}] approval ${permissionId} (${method}) timed out after ${APPROVAL_TIMEOUT_MS}ms — auto-cancelling`,
          );
          // Settle with cancel rather than deny so the codex turn ends
          // cleanly (cancel is the explicit "user gave up" path; deny
          // suggests an active rejection by the user, which would be
          // misleading).
          resolve(defaultCancelResponse(method));
          // Twin of onUserInputSettled below: the renderer's card is still
          // parked on this id, and the engine keeps it in its replay set until
          // told otherwise — so a reload would re-present a card whose resolver
          // is already gone.
          opts.onApprovalSettled?.(permissionId);
        }, APPROVAL_TIMEOUT_MS);
        timer.unref?.();
        pendingApprovals.set(permissionId, {
          resolve,
          method,
          rpcRequestId,
          timer,
        });
        pendingApprovalByRpcId.set(rpcRequestId, permissionId);
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
  wireApproval("execCommandApproval");
  wireApproval("applyPatchApproval");

  // ── Blocking question round-trips ──────────────────────
  // Twin of the approval flow. Codex's own requestUserInput has no cancel
  // variant and receives an empty answer on abandonment. MCP elicitation does
  // have explicit decline/cancel actions, so timeout/dispose use cancel and a
  // missing host handler declines immediately. Keeping those shapes separate
  // is required: app-server validates the method-specific response schema.
  interface PendingUserInputEntry {
    resolve: (response: unknown) => void;
    timer: NodeJS.Timeout;
    method: CodexUserInputMethod;
    rpcRequestId: string;
    cancelResponse: unknown;
  }
  const pendingUserInputs = new Map<string, PendingUserInputEntry>();
  const pendingUserInputByRpcId = new Map<string, string>();
  const safeMcpResponse = (action: "decline" | "cancel") => ({
    action,
    content: null,
    _meta: null,
  });
  const wireUserInput = (
    method: CodexUserInputMethod,
    noHandlerResponse: unknown,
    cancelResponse: unknown,
  ): void => {
    client.onRequest(method, (params, context) => {
      return new Promise<unknown>((resolve) => {
        if (
          method === "mcpServer/elicitation/request" &&
          [...pendingUserInputs.values()].filter(
            (pending) => pending.method === method,
          ).length >= MAX_PENDING_MCP_ELICITATIONS
        ) {
          console.warn(
            `[${logTag}] refusing concurrent MCP elicitation above ` +
              `${MAX_PENDING_MCP_ELICITATIONS}; responding cancel`,
          );
          resolve(cancelResponse);
          return;
        }
        const questionId = randomUUID();
        const rpcRequestId = String(context.id);
        if (!opts.onUserInputRequest) {
          resolve(noHandlerResponse);
          return;
        }
        const requestParams = (params ?? {}) as Record<string, unknown>;
        const timeoutMs = userInputTimeoutMs(method, requestParams);
        const expiresAt = Date.now() + timeoutMs;
        const timer = setTimeout(() => {
          if (!pendingUserInputs.has(questionId)) return;
          pendingUserInputs.delete(questionId);
          pendingUserInputByRpcId.delete(rpcRequestId);
          console.warn(
            `[${logTag}] user-input ${questionId} (${method}) timed out after ${timeoutMs}ms — auto-cancelling`,
          );
          resolve(cancelResponse);
          // The renderer's card is still parked on this id — tell the adapter
          // so it evicts the pending entry and the UI drops the card.
          opts.onUserInputSettled?.(questionId);
        }, timeoutMs);
        timer.unref?.();
        pendingUserInputs.set(questionId, {
          resolve,
          timer,
          method,
          rpcRequestId,
          cancelResponse,
        });
        pendingUserInputByRpcId.set(rpcRequestId, questionId);
        // Same ordering as approvals: the question may sit open for the whole
        // timeout, so reset the inactivity watchdog after the auto-cancel
        // timer is armed.
        touchActiveTurnActivity();
        opts.onUserInputRequest({
          questionId,
          rpcRequestId,
          method,
          expiresAt,
          params: requestParams,
        });
      });
    });
  };
  wireUserInput("item/tool/requestUserInput", { answers: {} }, { answers: {} });
  wireUserInput(
    "mcpServer/elicitation/request",
    safeMcpResponse("decline"),
    safeMcpResponse("cancel"),
  );

  // ── Fan-out for general notifications ────────────────────
  const notifSubscribers = new Map<string, Set<(params: unknown) => void>>();
  const subscribe = (
    method: string,
    handler: (params: unknown) => void,
  ): (() => void) => {
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
            console.warn(
              `[${logTag}] notification handler '${method}' threw: ${String(err)}`,
            );
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

  // The server can resolve/cancel a parked request independently (for example
  // when its owning turn is interrupted). Correlate the peer's original RPC id
  // back to our UI id and release both sides; otherwise the renderer keeps a
  // dead question until the full 30-minute timeout.
  subscribe("serverRequest/resolved", (params) => {
    const requestId = (params as { requestId?: string | number } | null)
      ?.requestId;
    if (requestId == null) return;
    const rpcRequestId = String(requestId);
    const permissionId = pendingApprovalByRpcId.get(rpcRequestId);
    if (permissionId) {
      const pending = pendingApprovals.get(permissionId);
      if (pending) {
        pendingApprovals.delete(permissionId);
        pendingApprovalByRpcId.delete(rpcRequestId);
        clearTimeout(pending.timer);
        // The server has already retired this JSON-RPC request. Settle our
        // handler closure without sending a second, late response.
        pending.resolve(JSON_RPC_NO_RESPONSE);
        opts.onApprovalSettled?.(permissionId);
      }
      return;
    }
    const questionId = pendingUserInputByRpcId.get(rpcRequestId);
    if (!questionId) return;
    const pending = pendingUserInputs.get(questionId);
    if (!pending) return;
    pendingUserInputs.delete(questionId);
    pendingUserInputByRpcId.delete(rpcRequestId);
    clearTimeout(pending.timer);
    pending.resolve(JSON_RPC_NO_RESPONSE);
    opts.onUserInputSettled?.(questionId);
  });

  // Codex starts ordinary notification and host-request delivery after this
  // acknowledgement. Register every blocking handler first so the first frame
  // cannot race a partially initialized host.
  client.notify("initialized", {});

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
  /** Monotonic marker closes the small window where a server-level terminal
   * error arrives after turn/start was sent but before its ACK gives us the
   * turn id needed to install a waiter. */
  let unscopedTerminalErrorEpoch = 0;

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
    const p = params as {
      threadId?: string;
      turn?: { id?: string; status?: string };
    };
    const turnId = p?.turn?.id;
    if (!turnId) return;
    const status = p.turn?.status;
    // Generated TurnStatus has no "cancelled" — a user abort is
    // "interrupted". The old "cancelled" compare was dead, so Cancel was
    // recorded as a normal completion.
    recordCompletion(
      turnId,
      status === "failed"
        ? "failed"
        : status === "interrupted"
          ? "cancelled"
          : "completed",
    );
  });
  subscribe("error", (params) => {
    const p = params as {
      threadId?: string;
      turnId?: string;
      willRetry?: boolean;
    };
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
    unscopedTerminalErrorEpoch += 1;
    for (const w of turnWaiters.values()) w.resolve("failed");
    turnWaiters.clear();
  });

  /** Release server-initiated request closures after an unexpected process
   * exit. There is no peer left to answer, so suppress wire responses while
   * still evicting adapter/renderer cards immediately. */
  const abandonPendingServerRequests = (): void => {
    for (const [permissionId, pending] of pendingApprovals) {
      clearTimeout(pending.timer);
      pendingApprovals.delete(permissionId);
      pendingApprovalByRpcId.delete(pending.rpcRequestId);
      pending.resolve(JSON_RPC_NO_RESPONSE);
      opts.onApprovalSettled?.(permissionId);
    }
    for (const [questionId, pending] of pendingUserInputs) {
      clearTimeout(pending.timer);
      pendingUserInputs.delete(questionId);
      pendingUserInputByRpcId.delete(pending.rpcRequestId);
      pending.resolve(JSON_RPC_NO_RESPONSE);
      opts.onUserInputSettled?.(questionId);
    }
  };

  // ── Exit cleanup ──────────────────────────────────────────
  void proc.exited.then(({ code, signal }) => {
    client.close(`codex exited code=${code} signal=${signal ?? ""}`);
    abandonPendingServerRequests();
    for (const w of turnWaiters.values()) w.resolve("failed");
    turnWaiters.clear();
    opts.onExit?.(code, signal);
  });

  // ── Public handle ─────────────────────────────────────────
  let disposePromise: Promise<void> | null = null;

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
          const wait =
            OVERLOAD_RETRY_BASE_MS * 2 ** attempt +
            Math.floor(Math.random() * 250);
          console.warn(
            `[${logTag}] server overloaded on ${method}; retrying in ${wait}ms (attempt ${attempt + 1})`,
          );
          await new Promise((r) => setTimeout(r, wait));
          attempt++;
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(
          `codex ${method} failed after ${OVERLOAD_MAX_RETRIES + 1} attempts`,
        );
  };

  /** `turn/start` and inline `review/start` acknowledge with the same Turn
   * shape and settle through the same `turn/completed` notification stream.
   * Keep correlation, terminal-error races, and inactivity handling in one
   * place so native review cannot strand or prematurely unlock the composer. */
  const runTurnLike = async (
    method: "turn/start" | "review/start",
    params: unknown,
    runOpts?: { onTurnStarted?: (turnId: string) => void },
  ): Promise<{
    turnId: string;
    status: "completed" | "failed" | "cancelled";
    raw: unknown;
  }> => {
    const startingErrorEpoch = unscopedTerminalErrorEpoch;
    const ack = await requestWithRetry<{
      turn: { id: string; status: string };
    }>(method, params);
    const turnId = ack.turn.id;
    runOpts?.onTurnStarted?.(turnId);

    const ackStatus = ack.turn.status;
    if (
      ackStatus === "completed" ||
      ackStatus === "failed" ||
      ackStatus === "cancelled" ||
      ackStatus === "interrupted"
    ) {
      return {
        turnId,
        status: ackStatus === "interrupted" ? "cancelled" : ackStatus,
        raw: ack,
      };
    }

    if (unscopedTerminalErrorEpoch !== startingErrorEpoch) {
      return { turnId, status: "failed", raw: ack };
    }

    const buffered = pendingTurnCompletions.get(turnId);
    if (buffered) {
      pendingTurnCompletions.delete(turnId);
      return { turnId, status: buffered, raw: ack };
    }

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
                `[${logTag}] ${method} turn ${turnId}: no app-server activity for ${TURN_INACTIVITY_TIMEOUT_MS}ms; treating as failed`,
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
  };

  return {
    initializeResponse: initResp,
    cliVersion,
    binarySource,
    child: proc.child,

    async startThread(params) {
      const result = await requestWithRetry<GenThreadStartResponse>(
        "thread/start",
        params,
      );
      return {
        threadId: result.thread.id,
        providerSessionId: result.thread.sessionId,
        gitInfo: result.thread.gitInfo ?? null,
        model: result.model,
        approvalPolicy: result.approvalPolicy,
        sandbox: result.sandbox,
        raw: result,
      };
    },

    async resumeThread(params) {
      const result = await requestWithRetry<GenThreadResumeResponse>(
        "thread/resume",
        params,
      );
      return {
        threadId: result.thread.id,
        providerSessionId: result.thread.sessionId,
        gitInfo: result.thread.gitInfo ?? null,
        ...(typeof result.model === "string" ? { model: result.model } : {}),
        raw: result,
      };
    },

    async runTurn(params, runOpts) {
      return runTurnLike("turn/start", params, runOpts);
    },

    async runReview(params, runOpts) {
      return runTurnLike("review/start", params, runOpts);
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
        console.log(
          `[${logTag}] respondToPermission: unknown id ${permissionId}`,
        );
        return;
      }
      pendingApprovals.delete(permissionId);
      pendingApprovalByRpcId.delete(pending.rpcRequestId);
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
      pendingUserInputByRpcId.delete(pending.rpcRequestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    },

    onNotification(method, handler) {
      return subscribe(method, handler);
    },

    onNotificationTyped(method, handler) {
      return subscribe(method, handler as (params: unknown) => void);
    },

    request<T>(
      method: string,
      params?: unknown,
      rpcOpts?: { timeoutMs?: number },
    ) {
      return requestWithRetry<T>(method, params ?? {}, rpcOpts);
    },

    requestTyped(method, params, rpcOpts) {
      return requestWithRetry(method, params, rpcOpts);
    },

    dispose() {
      // A lifecycle timeout does not cancel the underlying disposal promise.
      // Every retry must await that SAME process-group stop, never observe the
      // prior attempt and falsely report success while its stop still hangs.
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        // Settle any in-flight approval requests before the JSON-RPC
        // client closes so the server doesn't see an abrupt stream
        // disconnect mid-request (avoids stuck threads server-side).
        for (const [permissionId, pending] of pendingApprovals) {
          clearTimeout(pending.timer);
          pending.resolve(defaultCancelResponse(pending.method));
          pendingApprovals.delete(permissionId);
          pendingApprovalByRpcId.delete(pending.rpcRequestId);
          // Same reason as the timeout path above: this resolver is gone without
          // a user choice, so the adapter and renderer both need telling. Reached
          // when the runtime is disposed from underneath a parked approval — a
          // sidecar teardown or a crash-recovery rebuild, neither of which routes
          // through disposeSession's own drain.
          opts.onApprovalSettled?.(permissionId);
        }
        for (const [questionId, pending] of pendingUserInputs) {
          clearTimeout(pending.timer);
          pending.resolve(pending.cancelResponse);
          pendingUserInputs.delete(questionId);
          pendingUserInputByRpcId.delete(pending.rpcRequestId);
          opts.onUserInputSettled?.(questionId);
        }
        for (const w of turnWaiters.values()) w.resolve("cancelled");
        turnWaiters.clear();
        client.close("dispose");
        await proc.stop();
      })();
      return disposePromise;
    },
  };
}

function userInputTimeoutMs(
  method: CodexUserInputMethod,
  params: Record<string, unknown>,
): number {
  if (method !== "item/tool/requestUserInput") {
    return APPROVAL_TIMEOUT_MS;
  }
  const requested = params.autoResolutionMs;
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < 1_000
  ) {
    return APPROVAL_TIMEOUT_MS;
  }
  return Math.min(requested, APPROVAL_TIMEOUT_MS);
}

// ── Internal helpers ─────────────────────────────────────────

async function teardown(
  proc: StdioAgentProcess,
  client: JsonRpcStdioClient,
): Promise<void> {
  client.close("boot failure");
  await proc.stop();
}

function wrapBootError(
  stage: string,
  err: unknown,
  stderrTail?: string,
): Error {
  const inner = err instanceof Error ? err.message : String(err);
  const tail = stderrTail ? `\nstderr tail:\n${stderrTail.slice(-1024)}` : "";
  return new Error(`codex app-server boot failed at ${stage}: ${inner}${tail}`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…(${s.length - n} more)`;
}

/** Redact prompt- and answer-bearing fields from a JSON-RPC line before
 * logging. Server-request responses do not carry a method name, so their
 * `result.answers` / `result.content` fields need explicit treatment too.
 * If the line is not valid JSON or has no sensitive payload, return it as-is. */
export function redactCodexRpcLine(line: string): string {
  try {
    const obj = JSON.parse(line) as {
      params?: {
        input?: unknown;
        url?: unknown;
        requestedSchema?: unknown;
      };
      result?: { answers?: unknown; content?: unknown };
      method?: string;
    };
    let changed = false;
    if (obj.params && Array.isArray(obj.params.input)) {
      obj.params.input = `[redacted ${obj.params.input.length} input parts]`;
      changed = true;
    }
    if (obj.result && "answers" in obj.result) {
      obj.result.answers = "[redacted answers]";
      changed = true;
    }
    if (obj.result && "content" in obj.result) {
      obj.result.content = "[redacted content]";
      changed = true;
    }
    if (obj.method === "mcpServer/elicitation/request" && obj.params) {
      if ("url" in obj.params) {
        obj.params.url = redactMcpTraceUrl(obj.params.url);
        changed = true;
      }
      if ("requestedSchema" in obj.params) {
        obj.params.requestedSchema = "[redacted MCP schema]";
        changed = true;
      }
    }
    return changed ? JSON.stringify(obj) : line;
  } catch {
    return line;
  }
}

function redactMcpTraceUrl(value: unknown): string {
  if (typeof value !== "string") return "[redacted MCP URL]";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname ? "/…" : ""} [redacted MCP URL]`;
  } catch {
    return "[redacted MCP URL]";
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
export function buildMcpServerOverrides(
  servers: readonly McpServerRegistration[],
): string[] {
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
      if (s.headersFromEnv && Object.keys(s.headersFromEnv).length > 0) {
        args.push(
          "-c",
          `${base}.env_http_headers=${tomlInlineTable(s.headersFromEnv)}`,
        );
      }
    } else {
      args.push("-c", `${base}.command="${escapeTomlString(s.command)}"`);
      if (s.args && s.args.length > 0) {
        args.push("-c", `${base}.args=${tomlStringArray(s.args)}`);
      }
      if (s.env && Object.keys(s.env).length > 0) {
        args.push("-c", `${base}.env=${tomlInlineTable(s.env)}`);
      }
      if (
        typeof s.startupTimeoutSec === "number" &&
        Number.isInteger(s.startupTimeoutSec) &&
        s.startupTimeoutSec > 0 &&
        s.startupTimeoutSec <= 3_600
      ) {
        args.push("-c", `${base}.startup_timeout_sec=${s.startupTimeoutSec}`);
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
  return (
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/\r/g, "\\r")
      .replace(/\f/g, "\\f")
      // eslint-disable-next-line no-control-regex -- intentional: escape backspace
      .replace(/\x08/g, "\\b")
      // Any remaining C0 control char (incl. NUL) -> \uXXXX (TOML basic-string escape).
      .replace(
        // eslint-disable-next-line no-control-regex -- intentional: escape all C0 controls
        /[\x00-\x1f]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )
  );
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
        permissions: {
          network: { enabled: false },
          fileSystem: { read: [], write: [] },
        },
        scope: "turn",
      };
    case "execCommandApproval":
    case "applyPatchApproval":
      return {
        decision: {
          denied: { rejection: "No approval handler is available." },
        },
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
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "abort" };
  }
}
