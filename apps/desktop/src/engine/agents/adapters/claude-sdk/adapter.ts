// ──────────────────────────────────────────────────────────
// ClaudeSdkAdapter — Claude Code via the official Agent SDK
// ──────────────────────────────────────────────────────────
//
// The "deep native" Claude integration. Instead of spawning a fresh
// `claude -p … --resume` process per turn (the old StreamJsonAdapter path,
// now REMOVED — there is no fallback), this holds ONE persistent `query()`
// per session, fed user messages over a push-based AsyncIterable. The single `claude`
// process stays alive across turns — Anthropic's documented + recommended
// "streaming input" mode.
//
// Why this matters (each fixes a class of bug that bites every CLI-driving
// integration):
//   - Thinking-block 400s on resume (Opus 4.8) — the SDK keeps the whole
//     conversation in-process and round-trips thinking blocks itself, so
//     we never reconstruct them across a `--resume` boundary.
//   - "Tool approvals could be skipped" — `canUseTool` is a SYNCHRONOUS
//     gate the SDK awaits before running a tool; there's no hook-server
//     round-trip to race. No HTTP hook server is used for Claude at all.
//   - "Responses under the wrong chat turn" — one turn runs at a time and
//     we await its `result` before accepting the next prompt.
//   - "First message: No conversation found" — the FIRST turn never passes
//     `resume`; we only resume once the SDK has minted + reported a
//     session id (captured from the `system/init` message, persisted to
//     the session dir so it survives an engine restart).
//
// The bundled `@anthropic-ai/claude-agent-sdk` ships its own pinned
// `claude-code` CLI, so depending on the SDK IS the binary pin (the
// deterministic, known-good version, independent of the user's global
// `claude`). Auth still comes from the user's keychain / ~/.claude.
//
// SDK message shapes mirror the raw stream-json events, so we reuse
// ClaudeStreamTranslator verbatim for SDKMessage → SessionNotification.
//
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

import {
  query,
  type AccountInfo,
  type EffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
  type SlashCommand,
  type UserDialogRequest,
  type UserDialogResult,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  AdvertisedModel,
  AvailableCommand,
} from "@zeros/protocol/agent-events";
import type { AccountDetails } from "@zeros/protocol/messages";
import { buildQuestionStamp } from "@zeros/protocol/agent-messages";

import {
  AgentFailureError,
  type AgentAdapter,
  type AgentAdapterContext,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionResponse,
  type ListSessionsResponse,
  type McpServerRegistration,
  type NewSessionResponse,
  type PromptResponse,
  type QuestionAnswer,
  type QuestionRequest,
  type QuestionResponse,
  type QuestionSpec,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type StopReason,
  type TurnUsage,
} from "../../types";
import { SESSION_EXPIRED_KEYWORDS } from "../shared/session-expiry";
import { PERMISSION_RESPONSE_TIMEOUT_MS } from "../shared/constants";
import { preserveAmbientConfigRoots } from "../shared/config-isolation";
import { isDevRuntime } from "../../../runtime";
import {
  ensureSessionDir,
  removeSessionDir,
  sessionDir,
  writeSessionMeta,
} from "../../session-paths";
import {
  ClaudeStreamTranslator,
  isScheduledWakeupTaskId,
} from "../claude/translator";
import {
  claudeCliMissingMessage,
  isPinnedClaudeRuntime,
  resolveClaudeCli,
  type ClaudeCliSourceKind,
} from "./binary-resolver";
import { InputQueue, createDeferred, type Deferred } from "./input-queue";

/** Which CLI tier we last logged, so the breadcrumb lands once per engine boot
 *  (and again if the tier ever changes mid-run) instead of once per turn. */
let loggedCliSource: ClaudeCliSourceKind | null = null;

const CLAUDE_IDLE_TIMEOUT_ENV_VAR = "ZEROS_CLAUDE_IDLE_TIMEOUT_MINUTES";
const DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES = 30;
const ALLOWED_CLAUDE_IDLE_TIMEOUT_MINUTES = new Set([30, 60, 120, 300]);

type ClaudeMode = "default" | "plan" | "accept-edits" | "auto" | "bypass";

// Mirrors the engine adapters' auth-keyword matching. When the SDK
// errors because the user isn't signed in, route it to `auth-required` so
// the gateway grays the agent dot + the chat shows a Sign-in chip, rather
// than a confusing transport/protocol error.
const AUTH_RX =
  /\b(login|signed?\s*in|credentials?|unauthori[sz]ed|api[-\s]?key|oauth|authentic\w*|please\s+sign|access\s+token|permission\s+denied)\b/i;

/** True when a blob of output reads like an auth/sign-in nudge rather than
 *  real model output — routes SDK/terminal errors to an auth-required
 *  failure. Was imported from the now-removed adapters/base; inlined here
 *  since claude-sdk is its only remaining consumer. */
function looksLikeAuthPrompt(text: string): boolean {
  return AUTH_RX.test(text);
}

// A result{is_error} whose text reads like a network/availability failure —
// the CLI already retried the call itself (api_retry × max_retries) and gave
// up. These are transient by definition, so they route to `transport-closed`
// (RECOVERABLE): the renderer silently rebuilds (resuming the same Claude
// session id, full context) and resends — or, when the turn already streamed
// content, keeps the partial answer + AGENT STOPPED pill. Without this they
// fell through to a normal resolve with stopReason "refusal": the turn just
// silently ended mid-answer with no error and no retry. Checked AFTER
// auth/session-expired, which own their wordings. 5xx/overload matches are
// anchored to "API error" phrasing so a body that merely mentions a number
// can't trip it.
const TRANSIENT_NETWORK_RX =
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|fetch\s+failed|socket\s+hang\s?up|getaddrinfo|network\s+(?:error|failure|timeout|unreachable)|connection\s+(?:error|closed|reset|refused|failed|lost)|timed?\s+out|api\s+error[:\s(]*5\d\d\b|overloaded_error|\boverloaded\b/i;

/** Our kebab mode ids → the SDK's PermissionMode tokens. */
function toSdkPermissionMode(mode: ClaudeMode): PermissionMode {
  switch (mode) {
    case "accept-edits":
      return "acceptEdits";
    case "bypass":
      return "bypassPermissions";
    case "plan":
      return "plan";
    case "auto":
      // SDK 'auto' — a model classifier approves/denies each permission prompt.
      return "auto";
    default:
      return "default";
  }
}

/** File-modification tools. For these, the SDK's only "always allow" suggestion
 *  is `setMode:"acceptEdits"` (no scoped rule), so "Allow for this project"
 *  offers an explicit project-wide edit allow (rules for this whole family,
 *  = accept-edits expressed as scoped allow rules). Bash/exec tools are
 *  deliberately absent — we never synthesize a tool-wide rule for them. Missing
 *  a future edit tool here fails safe (it simply keeps prompting). */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Normalize whatever mode id the renderer sends to our canonical
 *  ClaudeMode. The composer pill sends the AGENT mode ids
 *  (default/plan/accept-edits/bypass) when the session advertises modes,
 *  but falls back to its LOCAL ids (full/auto-edit/ask/plan-only) when it
 *  doesn't — e.g. a resumed session whose loadSession didn't re-advertise
 *  them. Accepting BOTH means a mode switch (especially "Full Access") is
 *  never silently dropped. Returns null for an unrecognized id. */
function normalizeModeId(modeId: string): ClaudeMode | null {
  switch (modeId) {
    case "default":
    case "ask":
      return "default";
    case "plan":
    case "plan-only":
      return "plan";
    case "accept-edits":
    case "auto-edit":
      return "accept-edits";
    case "auto":
      return "auto";
    case "bypass":
    case "full":
      return "bypass";
    default:
      return null;
  }
}

/** Map a settings.json `permissions.defaultMode` token (the SDK PermissionMode
 *  vocabulary) to our ClaudeMode. `dontAsk` has no UI here → fall back to the
 *  prompting "default". Unknown → null (skip). */
function defaultModeTokenToClaudeMode(token: string): ClaudeMode | null {
  switch (token) {
    case "default":
      return "default";
    case "plan":
      return "plan";
    case "acceptEdits":
      return "accept-edits";
    case "auto":
      return "auto";
    case "bypassPermissions":
      return "bypass";
    case "dontAsk":
      return "default";
    default:
      return null;
  }
}

/** A fresh chat's initial permission mode = the user's configured default from
 *  the Claude settings hierarchy (local > project > user), so e.g.
 *  `permissions.defaultMode: "acceptEdits"` in ~/.claude/settings.json is
 *  honoured instead of forcing "default". Best-effort + synchronous (tiny files,
 *  once per session create): any missing/unreadable/invalid file is skipped.
 *  A persisted per-chat mode still overrides this — the renderer reconciles the
 *  chat's saved mode right after the session binds (see sessions-provider). */
function resolveDefaultPermissionMode(cwd: string): ClaudeMode {
  // An in-repository `.claude` file from an untrusted clone must not be able to
  // start a fresh chat in a PRIVILEGED mode — `bypass` skips canUseTool entirely
  // (no prompt for Bash/edits = RCE-by-repo), and accept-edits/auto silently
  // accept changes. Those may come ONLY from the user's own ~/.claude. Harmless
  // modes (plan/default) from a project file are still honored.
  const PRIVILEGED: ReadonlySet<ClaudeMode> = new Set([
    "bypass",
    "accept-edits",
    "auto",
  ]);
  const candidates: Array<{ file: string; userScope: boolean }> = [
    {
      file: path.join(cwd, ".claude", "settings.local.json"),
      userScope: false,
    },
    { file: path.join(cwd, ".claude", "settings.json"), userScope: false },
    { file: path.join(homedir(), ".claude", "settings.json"), userScope: true },
  ];
  for (const { file, userScope } of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        permissions?: { defaultMode?: unknown };
      };
      const token = parsed?.permissions?.defaultMode;
      if (typeof token === "string") {
        const mapped = defaultModeTokenToClaudeMode(token);
        if (mapped) {
          if (!userScope && PRIVILEGED.has(mapped)) {
            console.warn(
              `[claude-sdk] ignoring in-repo permissions.defaultMode="${token}" ` +
                `(${file}) — privileged modes are honored only from ~/.claude.`,
            );
            continue;
          }
          return mapped;
        }
      }
    } catch {
      /* missing / unreadable / non-JSON — fall through to the next, then default */
    }
  }
  return "default";
}

/** A blocking AskUserQuestion in flight. Either or both channel-resolvers may
 *  be attached (canUseTool → toolResolve; onUserDialog → dialogResolve); both
 *  are settled together when the user answers/dismisses/times out. */
interface PendingQuestion {
  questionId: string;
  toolUseID?: string;
  /** The AskUserQuestion tool input / dialog payload — kept for the output echo. */
  input: Record<string, unknown>;
  request: QuestionRequest;
  toolResolve?: (r: PermissionResult) => void;
  dialogResolve?: (r: UserDialogResult) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: Array<() => void>;
}

/** AskUserQuestionInput / dialog payload → the canonical QuestionRequest. */
function buildClaudeQuestionRequest(
  sessionId: string,
  questionId: string,
  toolUseID: string | undefined,
  input: Record<string, unknown>,
): QuestionRequest {
  const rawQuestions = Array.isArray(input?.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  const questions: QuestionSpec[] = rawQuestions.map((q, qi) => ({
    id: `q${qi}`,
    prompt: typeof q?.question === "string" ? q.question : "",
    header: typeof q?.header === "string" ? q.header : undefined,
    multiSelect:
      typeof q?.multiSelect === "boolean" ? q.multiSelect : undefined,
    options: (Array.isArray(q?.options)
      ? (q.options as Array<Record<string, unknown>>)
      : []
    ).map((o, oi) => ({
      id: `o${oi}`,
      label: typeof o?.label === "string" ? o.label : String(o?.label ?? ""),
      description:
        typeof o?.description === "string" ? o.description : undefined,
      preview: typeof o?.preview === "string" ? o.preview : undefined,
    })),
    // Claude auto-provides an "Other" free-text option (per the tool schema).
    allowOther: true,
  }));
  return {
    sessionId: sessionId as never,
    questionId,
    nativeRequestId: toolUseID ?? questionId,
    toolCallId: toolUseID,
    source: "native_dialog",
    blocking: true,
    // raiseQuestion arms its auto-skip timer right after building this, so
    // "now + timeout" is the moment settleQuestion(dismissed) will fire.
    expiresAt: Date.now() + PERMISSION_RESPONSE_TIMEOUT_MS,
    questions,
  };
}

/** Map a canonical answer for `q${i}` back to the original option labels. */
function claudeAnswerLabels(
  rawQuestion: Record<string, unknown> | undefined,
  answer: QuestionAnswer | undefined,
): string[] {
  const options = Array.isArray(rawQuestion?.options)
    ? (rawQuestion!.options as Array<Record<string, unknown>>)
    : [];
  const labels = (answer?.selectedOptionIds ?? []).map((id) => {
    const oi = Number(String(id).replace(/^o/, ""));
    const label = options[oi]?.label;
    return typeof label === "string" ? label : String(id);
  });
  if (answer?.freeText) labels.push(answer.freeText);
  return labels;
}

/** Reconstruct the SDK's AskUserQuestionOutput (echo questions + keyed answers)
 *  for the onUserDialog `{completed, result}` path. */
function buildAskUserQuestionOutput(
  input: Record<string, unknown>,
  answers: QuestionAnswer[],
): Record<string, unknown> {
  const rawQuestions = Array.isArray(input?.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  const answerMap: Record<string, string> = {};
  rawQuestions.forEach((q, qi) => {
    const a = answers.find((x) => x.questionId === `q${qi}`);
    answerMap[typeof q?.question === "string" ? q.question : `q${qi}`] =
      claudeAnswerLabels(q, a).join(", ");
  });
  return { questions: rawQuestions, answers: answerMap };
}

/** Human-readable answer string for the canUseTool deny-message (B) path. */
function formatAnswerForClaude(
  input: Record<string, unknown>,
  answers: QuestionAnswer[],
): string {
  const rawQuestions = Array.isArray(input?.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  const lines = rawQuestions.map((q, qi) => {
    const a = answers.find((x) => x.questionId === `q${qi}`);
    const prompt =
      typeof q?.question === "string" ? q.question : `Question ${qi + 1}`;
    const value = claudeAnswerLabels(q, a).join(", ") || "(no selection)";
    return `- ${prompt} → ${value}`;
  });
  return `The user answered your question(s):\n${lines.join("\n")}`;
}

interface WorkflowApprovalPhase {
  title: string;
  agents: number | null;
}

/** Read only the small literal `meta.phases` declaration accepted by Claude
 * workflows. Deliberately no eval/Function: workflow scripts are agent-authored
 * code and permission presentation must never execute them. */
function parseWorkflowApprovalPhases(script: unknown): WorkflowApprovalPhase[] {
  if (typeof script !== "string" || script.length === 0) return [];
  const phasesKey = /\bphases\s*:/.exec(script);
  if (!phasesKey) return [];
  const arrayStart = script.indexOf("[", phasesKey.index + phasesKey[0].length);
  if (arrayStart < 0) return [];
  const arrayEnd = matchingDelimiter(script, arrayStart, "[", "]");
  if (arrayEnd < 0) return [];
  const body = script.slice(arrayStart + 1, arrayEnd);
  const objects: string[] = [];
  // String-aware at the OBJECT boundary too, not just inside it: a brace in a
  // phase's own copy (`detail: "8 agents {parallel}"`) would otherwise open a
  // bogus object and leave matchingDelimiter resyncing from inside a literal,
  // silently dropping or garbling the remaining phase pills.
  for (let cursor = 0; cursor < body.length; cursor += 1) {
    const char = body[cursor];
    if (char === '"' || char === "'" || char === "`") {
      const literalEnd = endOfStringLiteral(body, cursor);
      if (literalEnd < 0) break;
      cursor = literalEnd;
      continue;
    }
    if (char !== "{") continue;
    const end = matchingDelimiter(body, cursor, "{", "}");
    if (end < 0) break;
    objects.push(body.slice(cursor, end + 1));
    cursor = end;
  }
  return objects
    .slice(0, 100)
    .map((object) => {
      const title =
        readLiteralStringProperty(object, "title") ??
        readLiteralStringProperty(object, "name");
      if (!title) return null;
      const numeric =
        readNumericProperty(object, "agents") ??
        readNumericProperty(object, "agentCount") ??
        readNumericProperty(object, "count") ??
        readAgentCountFromDetail(readLiteralStringProperty(object, "detail"));
      return { title, agents: numeric };
    })
    .filter((phase): phase is WorkflowApprovalPhase => phase !== null);
}

/** Index of the quote that CLOSES the literal opening at `start`, or -1 when it
 * is unterminated. */
function endOfStringLiteral(source: string, start: number): number {
  const quote = source[start];
  let escaped = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === quote) return i;
  }
  return -1;
}

function matchingDelimiter(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return i;
  }
  return -1;
}

function readLiteralStringProperty(
  source: string,
  property: string,
): string | null {
  const match = new RegExp(
    `(?:\\b${property}\\b|["']${property}["'])\\s*:\\s*(["'\\x60])`,
  ).exec(source);
  if (!match) return null;
  const quote = match[1];
  const start = match.index + match[0].length;
  let escaped = false;
  let value = "";
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return value.trim() || null;
    } else {
      value += char;
    }
  }
  return null;
}

function readNumericProperty(source: string, property: string): number | null {
  const match = new RegExp(
    `(?:\\b${property}\\b|["']${property}["'])\\s*:\\s*(\\d+)\\b`,
  ).exec(source);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readAgentCountFromDetail(detail: string | null): number | null {
  if (!detail) return null;
  const match = /\b(\d+)\s+(?:agents?|helpers?|tasks?)\b/i.exec(detail);
  return match ? Number(match[1]) : null;
}

interface SdkSession {
  /** Zeros-side routing id (returned to the renderer; keys persistence). */
  readonly zerosSessionId: string;
  cwd: string;
  env?: Record<string, string>;
  /** Optional path-to-executable override (Settings → Advanced). Usually
   *  unset → the SDK's bundled, pinned CLI is used (the whole point). */
  cliBinary?: string;
  /** Per-session MCP registry the gateway resolved for this cwd (user + repo +
   *  workspace layers, RCE-gated). Undefined → fall back to the global
   *  ctx.mcpServers in buildOptions. */
  mcpServers?: McpServerRegistration[];
  permissionMode: ClaudeMode;
  /** Live model override set via setModel(). Wins over env.ANTHROPIC_MODEL
   *  (the creation-time choice) in buildOptions, and is applied to an alive
   *  query via query.setModel(). Undefined = use the env/default model. */
  model?: string;
  /** The SDK's own session id, captured from `system/init`. Used for
   *  `resume`; null until the first turn has started. Persisted to the
   *  session dir so a reopen / engine-restart can resume the real id. */
  claudeSessionId: string | null;
  /** The live persistent query (null until the first prompt, or after an idle
   *  release / dispose / fatal error — recreated lazily with `resume`). */
  query: Query | null;
  /** Push channel feeding the query's prompt iterable. */
  input: InputQueue<SDKUserMessage>;
  /** Long-lived consumer loop draining the query's output. */
  consumer: Promise<void> | null;
  /** Per-session translator (SDKMessage → SessionNotification). Resets its
   *  per-turn state on each `result`, so it's safe to reuse across turns. */
  translator: ClaudeStreamTranslator;
  /** The in-flight turn's deferred, settled when the consumer sees `result`
   *  (or the query errors). Null when idle. */
  turn: Deferred<{ stopReason: StopReason; usage?: TurnUsage }> | null;
  /** Resolves only after prompt() has run its turn teardown. Control requests
   * that require a truly idle persistent query wait on this seam rather than
   * relying on promise-reaction ordering around the result deferred. */
  turnIdle: Deferred<void> | null;
  /** Serializes the idle interrupt used to cancel a one-shot wake-up with the
   * next prompt, so the control request can never hit an unrelated turn. */
  scheduledWakeupStop: Promise<void> | null;
  /** Timer that detaches only the live query after a bounded idle period. */
  idleTeardownTimer: ReturnType<typeof setTimeout> | null;
  /** Start of the current uninterrupted eligible-idle interval. */
  idleSince: number | null;
  /** prompt() calls admitted but not fully unwound, including boundary waits. */
  pendingPromptCalls: number;
  /** Locally queued turnless runs (currently /compact) awaiting a result. */
  turnlessRunsPending: number;
  /** Provider-originated work running without a local prompt() deferred. */
  providerRunActive: boolean;
  /** Permission resolvers from canUseTool, keyed by permissionId. */
  readonly pendingPermissions: Map<
    string,
    (r: RequestPermissionResponse) => void
  >;
  /** Blocking user-input questions (AskUserQuestion), keyed by questionId. A
   *  question may be raised by canUseTool (B, the demonstrable path) and/or
   *  onUserDialog (A, speculative); both channel-resolvers park here and settle
   *  together. */
  readonly pendingQuestions: Map<string, PendingQuestion>;
  /** toolUseID → questionId, so the two channels dedupe onto ONE question. */
  readonly questionByToolUse: Map<string, string>;
  /** Cancels the whole query (dispose / hard abort). */
  abort: AbortController;
  /** Set by cancel() so the settled turn maps to `cancelled`, and by
   *  teardown so an in-flight turn ends silently. Reset per turn. */
  cancelRequested: boolean;
  /** Monotonic count of cancels on this session. prompt() captures it in its
   *  SYNCHRONOUS prologue and uses it to decide whether the flag above is a
   *  stale leftover (clear it) or a Stop for the turn it was just handed (keep
   *  it). The per-turn reset alone couldn't tell those apart, so a Stop landing
   *  while prompt() waited on the previous turn's teardown seam was erased and
   *  the new turn streamed to completion. */
  cancelSeq: number;
  disposed: boolean;
  /** Set by updateConfig when a restart-only knob (CLAUDE_MAX_TURNS / the "max"
   *  effort tier) changes — the live flag-settings layer can't express those,
   *  so the NEXT prompt() recreates the query (with resume) to pick up the
   *  staged env. Deferred to prompt() rather than torn down eagerly so it never
   *  races a concurrent prompt() nor interrupts an in-flight turn. */
  pendingRestart: boolean;
  /** Whether the LIVE query was built with `allowDangerouslySkipPermissions`
   *  (i.e. created in "bypass"). That flag is a CREATION-only Option required
   *  for `bypassPermissions` to take effect, so a query built without it can't
   *  truly bypass even after a live setPermissionMode("bypassPermissions") —
   *  switching INTO bypass on such a query schedules a resume-rebuild. Once a
   *  query has the flag it keeps it, so we never rebuild twice. */
  queryAllowsBypass: boolean;
  /** Skill names reported by the most recent `system/init` (or a mid-session
   *  `reloadSkills()` refresh). The SDK returns skills + commands in ONE merged
   *  `supportedCommands()` list with no per-entry flag, but carries the skill
   *  NAME subset separately on the init message (`init.skills: string[]`), so
   *  we intersect by name to tag each emitted command as kind:"skill" vs
   *  "command". Empty until the first init lands. */
  skillNames: Set<string>;
}

const SDK_SESSION_FILE = "claude-sdk.json";

export class ClaudeSdkAdapter implements AgentAdapter {
  readonly agentId = "claude";

  private readonly ctx: AgentAdapterContext;
  private readonly sessions = new Map<string, SdkSession>();
  /** ADAPTER-LEVEL index of parked questions: questionId → the SdkSession
   *  object whose map holds it. respondToQuestion resolves through this
   *  FIRST — the session-map scan alone misses a question parked on a state
   *  object that a rebuild replaced in `sessions` (the resolvers on the
   *  orphaned object are still live and still block the old query's turn).
   *  Entries are removed in settleQuestion; the state ref pins the orphan
   *  only until its question settles. */
  private readonly questionIndex = new Map<string, SdkSession>();
  private cachedInitialize: InitializeResponse | null = null;
  /** Single-flight guard for Claude's model/list equivalent
   *  (query.supportedModels()). One adapter instance serves ALL sessions, so a
   *  burst of concurrent first-prompts would otherwise each fire the SDK call;
   *  this memo collapses them onto one in-flight discovery. Reset to null on
   *  failure or an empty result so a later turn retries. Mirrors
   *  CursorSdkAdapter.modelDiscovery. */
  private modelDiscovery: Promise<void> | null = null;
  /** Injectable so tests can drive the lifecycle with a scripted query
   *  without spawning a real `claude` process. Defaults to the SDK's. */
  private readonly queryFn: typeof query;
  /** Test-only millisecond override; production always uses the bounded env. */
  private readonly idleTimeoutOverrideMs: number | undefined;

  constructor(
    ctx: AgentAdapterContext,
    opts?: { queryFn?: typeof query; idleTimeoutMs?: number },
  ) {
    this.ctx = ctx;
    this.queryFn = opts?.queryFn ?? query;
    this.idleTimeoutOverrideMs = opts?.idleTimeoutMs;
  }

  // ── initialize ────────────────────────────────────────

  async initialize(): Promise<InitializeResponse> {
    if (this.cachedInitialize) return this.cachedInitialize;
    this.cachedInitialize = {
      protocolVersion: 1 as never,
      agentInfo: { name: "Claude Code", version: "sdk" } as never,
      agentCapabilities: {
        loadSession: { enabled: true } as never,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        } as never,
        mcpCapabilities: { http: true, sse: false } as never,
        sessionCapabilities: { list: {} } as never,
        // Mid-turn steering: steer() pushes a user message into the live
        // streaming-input queue; the CLI's async command queue injects it
        // into the running loop. Drives the queued-card "Send now" action.
        steering: true,
      } as never,
      authMethods: [
        {
          id: "terminal",
          name: "Sign in via Terminal",
          description: "Open Terminal.app and run `claude /login`.",
        },
      ] as never,
      // Model carried via ANTHROPIC_MODEL. `modelsDynamic` (with no models yet)
      // makes the gateway re-poll until discoverModels() fills `_meta.models`
      // from the SDK's query.supportedModels() — which needs a live query, so it
      // runs after the first prompt. The renderer's cold-start floor covers the
      // picker until then.
      _meta: {
        modelEnvVar: "ANTHROPIC_MODEL",
        modelsDynamic: true,
      },
    };
    return this.cachedInitialize;
  }

  /** Surface Claude's live model catalog onto the cached InitializeResponse's
   *  `_meta.models` from the SDK's `query.supportedModels()`. The SDK is the
   *  source of truth — it returns whatever the pinned claude-code CLI knows,
   *  plus per-model effort/fast capabilities — so this replaces the bundled
   *  catalog. Needs a live query, so it runs once after the first prompt creates
   *  one (best-effort; the gateway re-poll then surfaces the live list to the
   *  empty composer + subsequent chats). `ultracode` is OUR setting-layer tier
   *  (xhigh + dynamic workflows) which the SDK's effort enum (capped at "max")
   *  doesn't list, so we append it wherever the model supports xhigh — keeping
   *  the 7th pill tier. */
  private async discoverModels(state: SdkSession): Promise<void> {
    if (this.modelDiscovery) return this.modelDiscovery;
    // Capture the live query ONCE — don't re-read state.query after the await
    // (a concurrent dispose/restart could null it mid-flight). With no live
    // query there's nothing to ask yet; do NOT memoize that case so the next
    // prompt (which creates the query) retries.
    const q = state.query;
    if (!q) return Promise.resolve();
    this.modelDiscovery = (async () => {
      try {
        const infos = await q.supportedModels();
        const models: AdvertisedModel[] = (infos ?? []).map((mi) => {
          const base = (mi.supportedEffortLevels ?? []) as string[];
          const effortLevels = !mi.supportsEffort
            ? []
            : base.includes("xhigh")
              ? [...base, "ultracode"]
              : base;
          return {
            value: mi.value,
            label: mi.displayName || mi.value,
            effortLevels,
            ...(mi.supportsFastMode ? { supportsFast: true } : {}),
          };
        });
        if (models.length === 0) {
          // Nothing usable yet — reset so a later turn retries.
          this.modelDiscovery = null;
          return;
        }
        const base = await this.initialize();
        const meta = (base._meta ?? {}) as Record<string, unknown>;
        this.cachedInitialize = { ...base, _meta: { ...meta, models } };
      } catch {
        // Best-effort — the cold-start floor / catalog fallback still applies.
        // Reset the memo so a later turn can retry.
        this.modelDiscovery = null;
      }
    })();
    return this.modelDiscovery;
  }

  /** Background one-shot text generation (the AI chat-title call). A
   *  throwaway `query()` — string prompt in, final `result` text out. No
   *  tools, no user settings (settingSources: [] skips CLAUDE.md/MCP; auth
   *  still comes from the keychain), maxTurns: 1, plain-string system
   *  prompt instead of the claude_code preset. cwd is $HOME on purpose:
   *  the call is workspace-independent and must never trip repo trust. */
  async generateText(opts: {
    model: string;
    systemPrompt: string;
    prompt: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 30_000);
    try {
      const q = this.queryFn({
        prompt: opts.prompt,
        options: {
          cwd: homedir(),
          // Same env contract as buildOptions: the SDK REPLACES the
          // subprocess env when `env` is set, so spread process.env.
          ...(opts.env && Object.keys(opts.env).length > 0
            ? {
                env: preserveAmbientConfigRoots({
                  ...(process.env as Record<string, string>),
                  ...opts.env,
                }),
              }
            : {}),
          model: opts.model,
          maxTurns: 1,
          allowedTools: [],
          includePartialMessages: false,
          settingSources: [],
          systemPrompt: opts.systemPrompt,
          abortController: abort,
        },
      });
      let text = "";
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const m = msg as { type?: string; subtype?: string; result?: string };
        if (m.type === "result") {
          if (m.subtype === "success" && typeof m.result === "string") {
            text = m.result;
          }
          break;
        }
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── newSession / loadSession ──────────────────────────

  async newSession(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
  }): Promise<{ session: NewSessionResponse; initialize: InitializeResponse }> {
    const initialize = await this.initialize();
    const zerosSessionId = randomUUID();
    await ensureSessionDir(zerosSessionId);
    await writeSessionMeta(zerosSessionId, {
      agentId: this.agentId,
      cwd: opts.cwd,
      pid: process.pid,
      createdAt: Date.now(),
    });
    const state = this.makeState(zerosSessionId, opts);
    this.sessions.set(zerosSessionId, state);
    const session: NewSessionResponse = {
      sessionId: zerosSessionId,
      modes: {
        // Report the resolved default (from settings.json) so the permission
        // pill shows it immediately. A persisted per-chat mode overrides it via
        // the renderer's reconcile right after bind.
        currentModeId: state.permissionMode,
        availableModes: MODES,
      } as never,
    } as never;
    return { session, initialize };
  }

  async loadSession(opts: {
    sessionId: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
  }): Promise<LoadSessionResponse> {
    const existing = this.sessions.get(opts.sessionId);
    if (existing) {
      existing.cwd = opts.cwd;
      existing.env = opts.env;
      existing.cliBinary = opts.cliBinary?.trim() || undefined;
      existing.mcpServers = opts.mcpServers;
      this.refreshIdleTeardown(existing);
      return loadResponseWithModes(existing.permissionMode);
    }
    await ensureSessionDir(opts.sessionId);
    const state = this.makeState(opts.sessionId, opts);
    // Re-attach the SDK session id so the next prompt resumes the real
    // conversation (the renderer hydrates the transcript from its own
    // SQLite — we never re-replay Claude's JSONL). Survives engine restart.
    state.claudeSessionId = await this.readClaudeSessionId(opts.sessionId);
    this.sessions.set(opts.sessionId, state);
    // Re-advertise modes on resume. Without this the renderer's permission
    // pill falls back to its generic local ids (full/auto-edit/ask/plan-only)
    // for a resumed chat, and "Full Access" wouldn't route to bypass.
    // No persisted Claude session id → the next prompt starts a FRESH
    // conversation (nothing to `--resume`), so the first-turn preamble isn't in
    // any history; tell the gateway to re-inject it (resumedFresh).
    return loadResponseWithModes(
      state.permissionMode,
      state.claudeSessionId == null,
    );
  }

  async listSessions(): Promise<ListSessionsResponse> {
    return { sessions: [] } as never;
  }

  private makeState(
    zerosSessionId: string,
    opts: {
      cwd: string;
      env?: Record<string, string>;
      cliBinary?: string;
      mcpServers?: McpServerRegistration[];
    },
  ): SdkSession {
    return {
      zerosSessionId,
      cwd: opts.cwd,
      env: opts.env,
      cliBinary: opts.cliBinary?.trim() || undefined,
      mcpServers: opts.mcpServers,
      // Fresh chat → honour the user's configured default mode (settings.json
      // hierarchy); a persisted per-chat mode overrides via reconcile.
      permissionMode: resolveDefaultPermissionMode(opts.cwd),
      claudeSessionId: null,
      query: null,
      input: new InputQueue<SDKUserMessage>(),
      consumer: null,
      translator: new ClaudeStreamTranslator({
        sessionId: zerosSessionId,
        emit: (n) => this.ctx.emit.onSessionUpdate(this.agentId, n),
        // Token-by-token live streaming: render text/thinking from
        // `stream_event` deltas (see includePartialMessages below) and skip
        // the matching full blocks of the final assistant message.
        streamPartials: true,
        onUnknown: () => {
          /* benign — the SDK emits many message subtypes we don't render */
        },
      }),
      turn: null,
      turnIdle: null,
      scheduledWakeupStop: null,
      idleTeardownTimer: null,
      idleSince: null,
      pendingPromptCalls: 0,
      turnlessRunsPending: 0,
      providerRunActive: false,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      questionByToolUse: new Map(),
      abort: new AbortController(),
      cancelRequested: false,
      cancelSeq: 0,
      disposed: false,
      pendingRestart: false,
      queryAllowsBypass: false,
      skillNames: new Set(),
    };
  }

  private idleTimeoutMs(state: SdkSession): number {
    if (
      typeof this.idleTimeoutOverrideMs === "number" &&
      Number.isFinite(this.idleTimeoutOverrideMs) &&
      this.idleTimeoutOverrideMs >= 0
    ) {
      return this.idleTimeoutOverrideMs;
    }
    const minutes = Number(state.env?.[CLAUDE_IDLE_TIMEOUT_ENV_VAR]);
    const boundedMinutes = ALLOWED_CLAUDE_IDLE_TIMEOUT_MINUTES.has(minutes)
      ? minutes
      : DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES;
    return boundedMinutes * 60_000;
  }

  private clearIdleTeardown(state: SdkSession): void {
    if (state.idleTeardownTimer !== null) clearTimeout(state.idleTeardownTimer);
    state.idleTeardownTimer = null;
  }

  private markSessionBusy(state: SdkSession): void {
    this.clearIdleTeardown(state);
    state.idleSince = null;
  }

  /** Rechecked both when arming and when the callback fires. In particular,
   * wake-ups, queued input, provider-owned work, and approval/question gates
   * keep the process alive. A known SDK session id is mandatory so teardown
   * can never discard an unborn conversation that cannot be resumed. */
  private canDetachIdleQuery(state: SdkSession): boolean {
    return Boolean(
      !state.disposed &&
      state.query &&
      !state.input.closed &&
      state.claudeSessionId &&
      state.turn === null &&
      state.turnIdle === null &&
      state.pendingPromptCalls === 0 &&
      state.turnlessRunsPending === 0 &&
      !state.providerRunActive &&
      state.scheduledWakeupStop === null &&
      state.pendingPermissions.size === 0 &&
      state.pendingQuestions.size === 0 &&
      state.input.pendingCount === 0 &&
      !state.translator.hasActiveWork,
    );
  }

  private refreshIdleTeardown(state: SdkSession): void {
    this.clearIdleTeardown(state);
    if (!this.canDetachIdleQuery(state)) {
      state.idleSince = null;
      return;
    }
    if (state.idleSince == null) state.idleSince = Date.now();
    const remaining = Math.max(
      0,
      state.idleSince + this.idleTimeoutMs(state) - Date.now(),
    );
    const timer = setTimeout(() => {
      if (state.idleTeardownTimer !== timer) return;
      state.idleTeardownTimer = null;
      if (!this.canDetachIdleQuery(state)) {
        state.idleSince = null;
        this.refreshIdleTeardown(state);
        return;
      }
      const deadline =
        (state.idleSince ?? Date.now()) + this.idleTimeoutMs(state);
      if (Date.now() < deadline) {
        this.refreshIdleTeardown(state);
        return;
      }
      this.detachIdleQuery(state);
    }, remaining);
    state.idleTeardownTimer = timer;
  }

  /** End only the resumable live query. The SdkSession, translator, SDK
   * session id, and on-disk metadata remain intact for ensureQuery() to lazily
   * resume on the next turn. Null the generation slot before abort/close so a
   * stale consumer can never clobber a concurrently-created replacement. */
  private detachIdleQuery(state: SdkSession): void {
    const q = state.query;
    if (!q) return;
    this.clearIdleTeardown(state);
    state.idleSince = null;
    state.query = null;
    state.consumer = null;
    state.queryAllowsBypass = false;
    state.input.end();
    try {
      state.abort.abort();
    } catch {
      /* already aborted */
    }
    try {
      q.close();
    } catch {
      /* already closed */
    }
    console.info(
      `[claude-sdk] released idle query for ${state.zerosSessionId}`,
    );
  }

  // ── prompt ────────────────────────────────────────────

  async prompt(opts: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<{ stopReason: StopReason; response: PromptResponse }> {
    let state = this.mustState(opts.sessionId);
    if (state.turn) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: "a prompt is already in flight for this session",
        stage: "prompt",
        agentId: this.agentId,
      });
    }
    // Captured before the first await: from here on, a cancel belongs to THIS
    // turn (the engine has already accepted it), so the stale-flag reset below
    // must not erase it. See cancelSeq.
    const entryState = state;
    const entryCancelSeq = state.cancelSeq;
    let reservedState = state;
    reservedState.pendingPromptCalls += 1;
    this.markSessionBusy(reservedState);
    const transferPromptReservation = (next: SdkSession) => {
      if (next === reservedState) return;
      reservedState.pendingPromptCalls = Math.max(
        0,
        reservedState.pendingPromptCalls - 1,
      );
      this.refreshIdleTeardown(reservedState);
      reservedState = next;
      reservedState.pendingPromptCalls += 1;
      this.markSessionBusy(reservedState);
    };
    try {
      // The consumer clears `turn` immediately before settling its result, but
      // prompt() may still be unwinding. Serialize on the explicit teardown
      // seam so a control action cannot observe that transient half-idle state.
      const previousTurnIdle = state.turnIdle;
      if (previousTurnIdle) {
        await previousTurnIdle.promise;
        state = this.mustState(opts.sessionId);
        transferPromptReservation(state);
        if (state.turn) {
          throw new AgentFailureError({
            kind: "protocol-error",
            message: "a prompt is already in flight for this session",
            stage: "prompt",
            agentId: this.agentId,
          });
        }
      }
      // A scheduled-wakeup stop must issue its interrupt while the persistent
      // query is genuinely idle. A queued prompt that arrives at the previous
      // turn boundary waits here until that control request has settled.
      const pendingWakeupStop = state.scheduledWakeupStop;
      if (pendingWakeupStop) {
        await pendingWakeupStop.catch(() => undefined);
        state = this.mustState(opts.sessionId);
        transferPromptReservation(state);
        if (state.turn) {
          throw new AgentFailureError({
            kind: "protocol-error",
            message: "a prompt is already in flight for this session",
            stage: "prompt",
            agentId: this.agentId,
          });
        }
      }
      // Clear the PREVIOUS turn's flag, but keep a Stop that arrived while this
      // call was waiting on the teardown seams above — that one is for the turn
      // about to run, and dropping it let a stopped turn stream to completion.
      // Only comparable while this is still the same session object: a rebuild
      // between here and entry mints a fresh one (cancelSeq back at 0).
      state.cancelRequested =
        state === entryState && state.cancelSeq !== entryCancelSeq;
      this.ensureQuery(state);

      const turn = createDeferred<{
        stopReason: StopReason;
        usage?: TurnUsage;
      }>();
      const turnIdle = createDeferred<void>();
      state.turn = turn;
      state.turnIdle = turnIdle;
      try {
        state.translator.beginTurn();
        state.input.push({
          type: "user",
          message: { role: "user", content: this.buildContent(opts.prompt) },
          parent_tool_use_id: null,
        } as SDKUserMessage);
        const { stopReason, usage } = await turn.promise;
        // Prefer the session's configured model. Claude's perModel list is
        // sorted priciest-first for the usage popover and can lead with an
        // expensive subagent/fallback instead of the foreground turn model.
        const effectiveModel =
          state.model ||
          usage?.perModel?.find((entry) => entry.model)?.model ||
          undefined;
        // (The context-gauge usage refresh fires in runConsumer on every
        // `result` — including turnless runs like compactContext's /compact —
        // so there's nothing to emit here.)
        // stopReason ALWAYS rides inside the response: the gateway returns only
        // the inner response (discarding the outer field), so the old
        // usage-gated `{}` shape dropped the stop reason whenever the
        // translator had no usage — e.g. a clean cancel resolve persisted as a
        // "completed" turn row instead of "cancelled".
        return {
          stopReason,
          response: {
            stopReason,
            ...(effectiveModel ? { effectiveModel } : {}),
            ...(usage ? { usage } : {}),
          } as PromptResponse,
        };
      } finally {
        if (state.turn === turn) state.turn = null;
        if (state.turnIdle === turnIdle) state.turnIdle = null;
        turnIdle.resolve();
      }
    } finally {
      reservedState.pendingPromptCalls = Math.max(
        0,
        reservedState.pendingPromptCalls - 1,
      );
      this.refreshIdleTeardown(reservedState);
    }
  }

  /** Lazily (re)create the persistent query. resume is set ONLY when we
   *  already know the SDK session id (never on a truly first turn — that
   *  would trigger "No conversation found with session ID").
   *
   *  pendingRestart forces a recreate even when a query is alive: a
   *  restart-only knob (CLAUDE_MAX_TURNS / "max" effort) changed and can't be
   *  applied live, so we rebuild HERE — race-free, because prompt() is
   *  single-flight (its state.turn guard). The bounded idle releaser is safe
   *  for the same reason: prompt() synchronously cancels its timer, and the
   *  callback nulls the old query generation before abort/close. */
  private ensureQuery(state: SdkSession): void {
    if (state.query && !state.input.closed && !state.pendingRestart) return;
    this.clearIdleTeardown(state);
    state.idleSince = null;
    // Wind down an alive query we're replacing for a restart-only change.
    // runConsumer's `catch`/`finally` are generation-guarded (they act only
    // while state.query is still THEIR query), so the old loop can neither
    // clobber the query installed below nor settle a turn that isn't its own.
    if (state.query && !state.input.closed) {
      state.input.end();
      try {
        state.abort.abort();
      } catch {
        /* no-op */
      }
    }
    state.pendingRestart = false;
    state.turnlessRunsPending = 0;
    state.providerRunActive = false;
    state.input = new InputQueue<SDKUserMessage>();
    state.abort = new AbortController();
    try {
      state.query = this.queryFn({
        prompt: state.input,
        options: this.buildOptions(state),
      });
      // Mirrors buildOptions' flag decision: the query just built carries
      // allowDangerouslySkipPermissions iff it was created in bypass.
      state.queryAllowsBypass = state.permissionMode === "bypass";
    } catch (err) {
      state.query = null;
      throw new AgentFailureError({
        kind: "protocol-error",
        message: `claude SDK failed to start: ${err instanceof Error ? err.message : String(err)}`,
        stage: "prompt",
        agentId: this.agentId,
      });
    }
    state.consumer = this.runConsumer(state);
    // A live query now exists → pull the SDK's real model catalog into
    // `_meta.models` (once per process; best-effort, non-blocking).
    void this.discoverModels(state);
  }

  /** Run a real context compaction through Claude. The Agent
   *  SDK exposes no compact() control call — the trigger is the literal
   *  "/compact" slash command, which the CLI intercepts server-side (wire-
   *  verified 2026-07-12). Routed here (AGENT_COMPACT) instead of a normal
   *  prompt so NO user bubble lands in the transcript; the compaction
   *  narrates itself through the status/compact_boundary messages as the
   *  standalone two-state row ("Compacting.." → "Context compacted", or
   *  "Compaction failed" + the CLI's reason).
   *
   *  Deliberately TURNLESS: the message is pushed into the streaming input
   *  without creating a turn deferred, mirroring codex's fire-and-
   *  acknowledge thread/compact/start. The run's `result` lands with
   *  state.turn === null, which runConsumer already ignores — and its
   *  every-result usage refresh makes the gauge drop when the compaction
   *  lands. If a real turn IS in flight, the CLI queues the /compact and
   *  compacts right after the run — same contract as steer. */
  async compactContext(opts: { sessionId: string }): Promise<void> {
    const state = this.mustState(opts.sessionId);
    this.markSessionBusy(state);
    this.ensureQuery(state);
    state.translator.expectManualCompaction();
    state.turnlessRunsPending += 1;
    try {
      state.input.push({
        type: "user",
        message: { role: "user", content: "/compact" },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    } catch (error) {
      state.turnlessRunsPending = Math.max(0, state.turnlessRunsPending - 1);
      this.refreshIdleTeardown(state);
      throw error;
    }
  }

  /** Emit a `usage_update` carrying the SDK's authoritative context-window
   *  fill + per-category breakdown (query.getContextUsage()). This is the
   *  gauge's truth for Claude: the translator's result-time usage_update is
   *  cumulative TURN BILLING (its own comment warns it once rendered >100%
   *  "full"), so this second update — emitted after the turn settles, hence
   *  landing last — overwrites `size`/`used` with actual window numbers and
   *  attaches `categories` for the popover. Cost is deliberately omitted so
   *  the store keeps the billing update's costUsd. Best-effort: feature-
   *  detected (older CLIs lack the control request) and never throws. */
  private async emitContextUsage(state: SdkSession): Promise<void> {
    const q = state.query as unknown as {
      getContextUsage?: () => Promise<{
        totalTokens?: number;
        maxTokens?: number;
        categories?: Array<{
          name?: string;
          tokens?: number;
          isDeferred?: boolean;
        }>;
      }>;
    } | null;
    if (!q || typeof q.getContextUsage !== "function") return;
    try {
      const usage = await q.getContextUsage();
      if (state.disposed) return;
      const size = usage?.maxTokens;
      const used = usage?.totalTokens;
      if (typeof size !== "number" || typeof used !== "number") return;
      const categories = (usage.categories ?? [])
        .filter(
          (c): c is { name: string; tokens: number; isDeferred?: boolean } =>
            typeof c?.name === "string" && typeof c?.tokens === "number",
        )
        // The SDK's list includes its own "Free space" pseudo-category
        // (wire-verified: maxTokens − totalTokens). The gauge popover
        // computes and leads with free space itself, so passing this
        // through renders the row twice.
        .filter((c) => !/^free space$/i.test(c.name.trim()))
        .map((c) => ({
          // The reference design lists deferred pools as their own rows —
          // suffix unless the SDK already did.
          name:
            c.isDeferred && !/deferred/i.test(c.name)
              ? `${c.name} (deferred)`
              : c.name,
          tokens: c.tokens,
        }));
      this.ctx.emit.onSessionUpdate(this.agentId, {
        sessionId: state.zerosSessionId,
        update: {
          sessionUpdate: "usage_update",
          size,
          used,
          ...(categories.length > 0 ? { categories } : {}),
        } as never,
      });
    } catch {
      /* best-effort — the gauge just keeps its previous reading */
    }
  }

  // ── steer ─────────────────────────────────────────────

  /** Inject a user message into the RUNNING turn. The SDK's streaming-input
   *  contract makes this the CLI's native queued-message path: a user message
   *  pushed while a run is active lands in the CLI's async command queue and
   *  is dequeued into the same run loop (the model sees it at its next
   *  inference step). No new turn deferred is created — the in-flight
   *  prompt()'s `result` covers the steered input. If the CLI ever settles
   *  the original run FIRST and re-runs the steered message as a follow-on
   *  (older CLI behavior), the extra `result` lands with state.turn === null,
   *  which runConsumer already ignores — degraded to "queued for next turn",
   *  never a hang or a mis-settled turn. */
  async steer(opts: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<void> {
    const state = this.mustState(opts.sessionId);
    if (!state.turn || !state.query || state.input.closed) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: "no turn is in flight to steer",
        stage: "prompt",
        agentId: this.agentId,
      });
    }
    state.input.push({
      type: "user",
      message: { role: "user", content: this.buildContent(opts.prompt) },
      parent_tool_use_id: null,
    } as SDKUserMessage);
  }

  /** The long-lived loop that drains ONE persistent query across all of a
   *  session's turns. Captures the SDK session id, feeds every message to
   *  the translator (which emits SessionNotifications), and settles each
   *  turn's deferred when its `result` arrives. */
  private async runConsumer(state: SdkSession): Promise<void> {
    const q = state.query;
    if (!q) return;
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (state.disposed) break;
        // Generation guard: if a restart (pendingRestart) installed a fresh
        // query, THIS loop is still draining the wound-down old one — abort()
        // does NOT contractually preclude a buffered message, and processing
        // one here would settle the NEW turn or null the fresh query against
        // re-pointed shared state. Stop the instant we're no longer the active
        // query (the catch/finally below carry the same guard).
        if (state.query !== q) break;
        const m = msg as unknown as {
          type?: string;
          subtype?: string;
          session_id?: string;
          skills?: unknown;
        };

        if (m.type === "system" && m.subtype === "init") {
          if (
            typeof m.session_id === "string" &&
            state.claudeSessionId !== m.session_id
          ) {
            state.claudeSessionId = m.session_id;
            void this.persistClaudeSessionId(
              state.zerosSessionId,
              m.session_id,
            );
          }
          // The init message carries the skill-NAME subset separately from the
          // merged command list (`init.skills: string[]`). Capture it so the
          // emitted commands can be tagged skill vs command — without it the
          // SDK's merged supportedCommands() list is indistinguishable.
          if (Array.isArray(m.skills)) {
            state.skillNames = new Set(
              m.skills.filter((s): s is string => typeof s === "string"),
            );
          }
          // Discover slash commands. supportedCommands() is captured at
          // initialize and returns the COMPLETE list (built-ins + custom
          // commands + skills + plugins), so the composer picker reflects
          // exactly what this Claude session can run. Fire-and-forget — a
          // discovery failure must never block the turn.
          void this.emitSupportedCommands(state);
          // The init message advertises the mode the CLI ACTUALLY honored,
          // which can silently differ from what buildOptions requested
          // ("auto" is model-gated). Reconcile so state/UI never claim a
          // permissiveness the session doesn't have. Fire-and-forget.
          void this.reconcileAdvertisedPermissionMode(
            state,
            q,
            (msg as unknown as { permissionMode?: string }).permissionMode,
          );
        }

        // The SDK fire-and-forget pushes the FULL command list again
        // whenever it changes mid-session (e.g. a skill discovered as the
        // agent cd's into a subdir). REPLACE the cached list with it —
        // refreshing the skill-name set first (commands_changed carries no
        // skills subset) so a newly-discovered skill stays tagged correctly.
        if (m.type === "system" && m.subtype === "commands_changed") {
          const cmds = (msg as unknown as { commands?: SlashCommand[] })
            .commands;
          if (Array.isArray(cmds)) void this.refreshSkillsThenEmit(state, cmds);
        }

        // A provider wake-up/autonomous continuation has no local prompt()
        // deferred. Treat visible provider traffic as active until its result
        // so an already-armed idle timer cannot close the process mid-run.
        if (
          state.turn === null &&
          state.turnlessRunsPending === 0 &&
          (m.type === "assistant" ||
            m.type === "user" ||
            m.type === "stream_event")
        ) {
          state.providerRunActive = true;
          this.markSessionBusy(state);
        }

        // Translate → emit. The SDK shapes match the raw stream-json the
        // translator already understands (system/assistant/user/result).
        const hadActiveWork = state.translator.hasActiveWork;
        try {
          state.translator.feed(msg);
        } catch (err) {
          console.warn(`[agents] claude-sdk translate failed: ${String(err)}`);
        }
        if (hadActiveWork !== state.translator.hasActiveWork) {
          this.refreshIdleTeardown(state);
        }

        if (m.type === "result") {
          // Refresh the real context-window reading for the
          // gauge on EVERY settled run — including turnless ones (the
          // compactContext "/compact", a steered follow-on) where there is
          // no prompt() awaiting to do it. Fire-and-forget: a control-
          // channel call (zero model tokens) that must never delay or fail
          // the turn.
          void this.emitContextUsage(state);
          const turn = state.turn;
          state.turn = null;
          state.providerRunActive = false;
          if (!turn) {
            state.turnlessRunsPending = Math.max(
              0,
              state.turnlessRunsPending - 1,
            );
            this.refreshIdleTeardown(state);
            continue;
          }
          const terminalError = state.translator.terminalError;
          if (terminalError && looksLikeAuthPrompt(terminalError)) {
            // Not signed in — surface as auth-required (Sign-in chip), not
            // a hard error. The session stays usable once the user logs in.
            turn.reject(
              new AgentFailureError({
                kind: "auth-required",
                message:
                  "Claude Code is not signed in — open Settings → Providers to sign in via Terminal.",
                stage: "prompt",
                agentId: this.agentId,
              }),
            );
            continue;
          }
          if (terminalError && SESSION_EXPIRED_KEYWORDS.test(terminalError)) {
            // A stale `resume` was rejected ("No conversation found"). Drop
            // the dead query so the renderer's recovery re-establishes, and
            // surface session-expired (recoverable self-heal).
            state.query = null;
            state.input.end();
            turn.reject(
              new AgentFailureError({
                kind: "session-expired",
                message: terminalError,
                stage: "prompt",
                agentId: this.agentId,
              }),
            );
            continue;
          }
          if (
            terminalError &&
            !state.cancelRequested &&
            TRANSIENT_NETWORK_RX.test(terminalError)
          ) {
            // The CLI exhausted its own api_retry attempts on a network /
            // availability error. Record WHY in the transcript, then reject
            // RECOVERABLE so the shared renderer recovery owns it: nothing
            // streamed → silent rebuild (same Claude session id, full
            // context) + resend; partial answer streamed → keep it + the
            // AGENT STOPPED pill, and a later "continue" resumes in context.
            // (A cancel that races the errored result stays a cancel.)
            // Simple copy by design (UI-indication consolidation
            // 2026-07-10): the raw error is for logs, not the transcript.
            console.warn(
              `[claude-sdk] network failure after CLI retries: ${terminalError}`,
            );
            this.ctx.emit.onSessionUpdate(this.agentId, {
              sessionId: state.zerosSessionId,
              update: {
                sessionUpdate: "error_notice",
                noticeId: `claude-neterr-${randomUUID()}`,
                severity: "error",
                recoverable: true,
                message: "Connection lost — reconnecting…",
              },
            });
            turn.reject(
              new AgentFailureError({
                kind: "transport-closed",
                message: `claude API network failure: ${terminalError}`,
                stage: "prompt",
                agentId: this.agentId,
              }),
            );
            continue;
          }
          const stopReason: StopReason = state.cancelRequested
            ? ("cancelled" as StopReason)
            : (state.translator.stopReason as StopReason);
          // Options.maxBudgetUsd is accounted per query run, and
          // this query persists across turns. After a budget stop, stage a
          // restart (resume keeps full context) so the next turn — the
          // footer's Continue, or any new prompt — starts under a fresh cap
          // instead of being instantly re-stopped by the spent one.
          if (stopReason === "budget_exhausted") state.pendingRestart = true;
          turn.resolve({ stopReason, usage: state.translator.turnUsage });
        }
      }
    } catch (err) {
      // If a restart (pendingRestart) already installed a fresh query, THIS
      // loop is stale — prompt() re-points state.query synchronously before
      // this async catch runs, so a mismatch means the in-flight turn (if any)
      // belongs to the NEW query. Bail without settling it (the `finally` is
      // likewise guarded, so it won't null the new query either).
      if (state.query !== q) return;
      // The query errored or was aborted. A deliberate teardown/cancel is
      // not a failure; anything else settles the in-flight turn so prompt()
      // doesn't hang forever.
      const turn = state.turn;
      state.turn = null;
      if (turn) {
        if (state.cancelRequested || state.disposed) {
          turn.resolve({ stopReason: "cancelled" as StopReason });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          turn.reject(
            new AgentFailureError({
              kind: looksLikeAuthPrompt(msg)
                ? "auth-required"
                : "transport-closed",
              message: looksLikeAuthPrompt(msg)
                ? "Claude Code is not signed in — open Settings → Providers to sign in via Terminal."
                : `claude SDK stream ended: ${msg}`,
              stage: "prompt",
              agentId: this.agentId,
            }),
          );
        }
      }
    } finally {
      // The query is spent (iterator returned/threw); a future prompt
      // recreates it with `resume`. Guard against a restart that already
      // installed a newer query — only clear the slot if it's still OURS, so a
      // stale teardown can't null the fresh query prompt() just created.
      if (state.query === q) {
        this.clearIdleTeardown(state);
        state.idleSince = null;
        state.providerRunActive = false;
        state.turnlessRunsPending = 0;
        state.query = null;
        state.consumer = null;
      }
    }
  }

  // ── slash-command discovery ───────────────────────────

  /** Ask the live query for its supported slash commands and emit them to
   *  the UI. Best-effort: never throws into the consumer loop. */
  private async emitSupportedCommands(state: SdkSession): Promise<void> {
    const q = state.query;
    if (!q) return;
    try {
      const cmds = await q.supportedCommands();
      if (Array.isArray(cmds) && !state.disposed)
        this.emitCommands(state, cmds);
    } catch (err) {
      console.warn(
        `[agents] claude-sdk supportedCommands failed: ${String(err)}`,
      );
    }
  }

  /** Map the SDK's SlashCommand[] → our AvailableCommand[] and emit an
   *  available_commands_update. The renderer unions this with the curated
   *  built-in floor, so emitting the raw SDK list (authoritative) is right. */
  private emitCommands(state: SdkSession, cmds: SlashCommand[]): void {
    this.ctx.emit.onSessionUpdate(this.agentId, {
      sessionId: state.zerosSessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: mapSlashCommands(cmds, state.skillNames),
      } as never,
    });
  }

  /** Refresh the skill-name set via the SDK's `reloadSkills()` (best-effort —
   *  the method is absent on older SDKs), then re-emit the merged command list
   *  so a mid-session skill change (commands_changed, which carries no skills
   *  subset) keeps its skill tag instead of silently degrading to "command". */
  private async refreshSkillsThenEmit(
    state: SdkSession,
    cmds: SlashCommand[],
  ): Promise<void> {
    try {
      const q = state.query as unknown as {
        reloadSkills?: () => Promise<{ skills?: Array<{ name?: unknown }> }>;
      } | null;
      if (q && typeof q.reloadSkills === "function") {
        const res = await q.reloadSkills();
        if (res && Array.isArray(res.skills)) {
          state.skillNames = new Set(
            res.skills
              .map((s) => s?.name)
              .filter((n): n is string => typeof n === "string"),
          );
        }
      }
    } catch {
      /* best-effort — keep the last known skill set */
    }
    if (!state.disposed) this.emitCommands(state, cmds);
  }

  // ── cancel / setMode ──────────────────────────────────

  async cancel(opts: { sessionId: string }): Promise<void> {
    const state = this.sessions.get(opts.sessionId);
    if (!state) return;
    this.markSessionBusy(state);
    state.cancelRequested = true;
    state.cancelSeq += 1;
    // Release any OPEN permission gate so a turn blocked inside canUseTool
    // unwinds immediately. interrupt() alone does NOT reliably cancel an
    // outstanding can_use_tool control request (the per-tool AbortSignal is
    // the SDK's per-request controller, fired only by a CLI-sent
    // control_cancel_request — not by interrupt), so without this the gate
    // (and its renderer permission card) would linger until the response
    // timeout. Mirror teardown()'s release — but unlike teardown we keep the
    // query/process ALIVE for the next turn (no abort()/close()).
    if (state.pendingPermissions.size > 0) {
      const resolvers = [...state.pendingPermissions.values()];
      state.pendingPermissions.clear();
      for (const resolve of resolvers) {
        resolve({
          outcome: { outcome: "cancelled" },
        } as RequestPermissionResponse);
      }
    }
    // Release any parked questions so a blocked turn unwinds.
    for (const questionId of [...state.pendingQuestions.keys()]) {
      this.settleQuestion(state, questionId, { outcome: "dismissed" });
    }
    // interrupt() is the SDK's clean per-turn stop (the process stays alive
    // for the next turn). The turn settles `cancelled` via the consumer.
    try {
      await state.query?.interrupt();
    } catch {
      /* query already gone / between turns — nothing to interrupt */
    } finally {
      this.refreshIdleTeardown(state);
    }
  }

  async stopBackgroundTask(opts: {
    sessionId: string;
    taskId: string;
  }): Promise<void> {
    const state = this.mustState(opts.sessionId);
    if (!state.query) {
      throw new AgentFailureError({
        kind: "transport-closed",
        message: "Claude background task is no longer connected",
        stage: "stopBackgroundTask",
        agentId: this.agentId,
      });
    }
    if (isScheduledWakeupTaskId(opts.taskId)) {
      // ScheduleWakeup's one-shot timers live outside the normal task
      // registry, so stopTask cannot address them. The Claude runtime's idle
      // interrupt path is its documented user-abort seam and cancels pending
      // dynamic-loop wakeups. Stop hooks expose at most one such wakeup (a new
      // one supersedes the old one), and recurring cron jobs never enter this
      // branch because task 008 remains intentionally excluded.
      if (state.scheduledWakeupStop) {
        await state.scheduledWakeupStop;
        return;
      }
      const operation = Promise.resolve().then(async () => {
        const q = state.query;
        if (!q) {
          throw new AgentFailureError({
            kind: "transport-closed",
            message: "Claude scheduled wake-up is no longer connected",
            stage: "stopBackgroundTask",
            agentId: this.agentId,
          });
        }
        const turnIdle = state.turnIdle;
        if (turnIdle) await turnIdle.promise;
        // The prompt gate above prevents a new turn from entering after the
        // awaited prompt teardown. Keep the explicit guard as a fail-safe for
        // any future code path that bypasses prompt().
        if (
          state.query !== q ||
          state.disposed ||
          state.turn !== null ||
          state.turnIdle !== null
        ) {
          throw new AgentFailureError({
            kind: "protocol-error",
            message: "Claude scheduled wake-up is no longer idle",
            stage: "stopBackgroundTask",
            agentId: this.agentId,
          });
        }
        try {
          await q.interrupt();
        } catch (error) {
          throw new AgentFailureError({
            kind: "transport-closed",
            message: `Claude could not stop the scheduled wake-up: ${
              error instanceof Error ? error.message : String(error)
            }`,
            stage: "stopBackgroundTask",
            agentId: this.agentId,
          });
        }
        state.translator.clearScheduledWakeups();
      });
      state.scheduledWakeupStop = operation;
      this.refreshIdleTeardown(state);
      try {
        await operation;
      } finally {
        if (state.scheduledWakeupStop === operation) {
          state.scheduledWakeupStop = null;
        }
        this.refreshIdleTeardown(state);
      }
      return;
    }
    const stopTask = (
      state.query as unknown as {
        stopTask?: (taskId: string) => Promise<void>;
      }
    ).stopTask;
    if (typeof stopTask !== "function") {
      throw new AgentFailureError({
        kind: "protocol-error",
        message:
          "This Claude Agent SDK does not support stopping background tasks; update Claude before retrying.",
        stage: "stopBackgroundTask",
        agentId: this.agentId,
        advice: "Update Claude Code, then retry Stop.",
      });
    }
    try {
      await stopTask.call(state.query, opts.taskId);
    } catch (error) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: `Claude could not stop background task ${opts.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        stage: "stopBackgroundTask",
        agentId: this.agentId,
      });
    }
  }

  async setMode(opts: { sessionId: string; modeId: string }): Promise<void> {
    const state = this.mustState(opts.sessionId);
    const mode = normalizeModeId(opts.modeId);
    // The mode we report back to the renderer — normally the requested id,
    // but a model-gated "auto" degrades to accept-edits (see catch below).
    let appliedId = opts.modeId;
    if (mode) {
      state.permissionMode = mode;
      // Apply live to an alive query (the SDK supports mid-session mode
      // changes — a per-turn-spawn adapter can't do this). This does NOT
      // interrupt the current turn; it changes the gate for subsequent
      // tools.
      try {
        await state.query?.setPermissionMode(toSdkPermissionMode(mode));
      } catch {
        // A LIVE query can reject "auto": the classifier is MODEL-GATED
        // ("Cannot set permission mode to auto: auto mode unavailable for
        // this model" — e.g. Haiku, verified on CLI 2.1.170/2.1.186).
        // Without a fallback the session silently stays in its previous
        // mode while the UI says Auto — the "Auto asks for every Edit/Bash"
        // bug. Degrade to acceptEdits: the closest posture-Auto semantics
        // the model supports (auto-approve edits, still ask for the rest).
        // Any other throw keeps the old contract: mode stored, applied at
        // the next query creation (where reconcileAdvertisedPermissionMode
        // re-checks what the CLI actually honored).
        if (mode === "auto" && state.query) {
          try {
            await state.query.setPermissionMode("acceptEdits");
            state.permissionMode = "accept-edits";
            appliedId = "accept-edits";
          } catch {
            /* between turns / dead query — reconciled at next creation */
          }
        }
      }

      // Both bypass-only Options — allowDangerouslySkipPermissions AND the
      // ABSENCE of canUseTool (see buildOptions) — are creation-only, so a live
      // mode change that crosses the bypass boundary in EITHER direction leaves
      // the running query mis-built: entering bypass on a gated query can't truly
      // skip (the flag is creation-only), and LEAVING bypass on a bypass-built
      // query has no canUseTool to gate with (it was omitted to avoid the SDK's
      // CAN_USE_TOOL_SHADOWED rejection). Schedule a resume-rebuild so the NEXT
      // turn's buildOptions re-derives both — once only (queryAllowsBypass tracks
      // the built-with state), never mid-turn (pendingRestart consumed at the
      // next prompt).
      if (state.query && (mode === "bypass") !== state.queryAllowsBypass) {
        state.pendingRestart = true;
      }

      // KEY FIX: if the user switches to fully-permissive "Full Access"
      // (bypass) while a tool-permission prompt is OPEN, the turn is
      // blocked inside canUseTool waiting on a decision — and setMode alone
      // never releases it, so the agent "stops" mid-turn (the reported
      // bug). "Full Access" means "stop asking, allow it", so auto-approve
      // every pending request for this session; the blocked turn then
      // proceeds instead of hanging until the response timeout.
      if (mode === "bypass" && state.pendingPermissions.size > 0) {
        const resolvers = [...state.pendingPermissions.values()];
        state.pendingPermissions.clear();
        for (const resolve of resolvers) {
          resolve({
            outcome: { outcome: "selected", optionId: "allow_once" },
          } as RequestPermissionResponse);
        }
      }
    }
    this.ctx.emit.onSessionUpdate(this.agentId, {
      sessionId: opts.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: appliedId,
      } as never,
    });
  }

  /** Reconcile our mode state with what the CLI's `system/init` says is
   *  ACTUALLY in effect. The two can diverge because "auto" is MODEL-GATED
   *  (no permission classifier on e.g. Haiku) and the CLI communicates that
   *  in two ways: a mid-session setPermissionMode("auto") throws, but a
   *  creation-time `permissionMode: "auto"` is SILENTLY downgraded to
   *  "default" (both verified on CLI 2.1.170 and 2.1.186). Left alone, that
   *  silent downgrade is the "Auto mode asks for every Edit/Bash" bug: the
   *  pill shows Auto while the session prompts like Default. When we wanted
   *  auto and didn't get it, degrade to acceptEdits — the closest available
   *  posture-Auto semantics (auto-approve edits, still ask for the rest).
   *  For any other mismatch, adopt the CLI's advertised mode. Either way the
   *  renderer gets a truthful current_mode_update (accept-edits still folds
   *  into the "Auto" posture bucket, so the pill stays on Auto). */
  private async reconcileAdvertisedPermissionMode(
    state: SdkSession,
    q: Query,
    advertised: string | undefined,
  ): Promise<void> {
    if (!advertised || state.disposed || state.query !== q) return;
    if (advertised === toSdkPermissionMode(state.permissionMode)) return;
    let applied = defaultModeTokenToClaudeMode(advertised);
    if (state.permissionMode === "auto") {
      try {
        await q.setPermissionMode("acceptEdits");
        applied = "accept-edits";
      } catch {
        /* keep the CLI's own downgrade */
      }
    }
    if (!applied || applied === state.permissionMode) return;
    state.permissionMode = applied;
    this.ctx.emit.onSessionUpdate(this.agentId, {
      sessionId: state.zerosSessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: applied,
      } as never,
    });
  }

  /** Change the model of a live session without rebuilding it. Applies to
   *  the next turn (the SDK can't swap the model mid-turn). Persisted on the
   *  session so buildOptions uses it if the query is later recreated. */
  async setModel(opts: { sessionId: string; model: string }): Promise<void> {
    const state = this.sessions.get(opts.sessionId);
    if (!state || !opts.model.trim()) return;
    state.model = opts.model.trim();
    // The fallback detector compares against the current primary;
    // re-arm so a live model switch isn't misread as an overload fallback.
    const fb = state.env?.CLAUDE_FALLBACK_MODEL?.trim();
    state.translator.armFallbackDetection(
      state.model,
      Boolean(fb && fb !== state.model),
    );
    try {
      await state.query?.setModel(state.model);
    } catch {
      /* between turns / no live query — applied at next query creation */
    }
  }

  /** Live config update: re-derive the composer knobs (effort/fast/ultracode/
   *  add-dirs/allow-deny) from the new env and apply them to the RUNNING query
   *  via applyFlagSettings — no recreation, so an in-flight turn isn't
   *  disturbed. Two knobs the flag-settings layer can't express live —
   *  CLAUDE_MAX_TURNS (a creation-time Options.maxTurns) and the "max" effort
   *  tier (a top-level Options.effort, not a Settings.effortLevel) — instead
   *  need a fresh query; we restart ONLY when idle (never mid-turn) so the
   *  next prompt picks them up via buildOptions, preserving resume. */
  async updateConfig(opts: {
    sessionId: string;
    env: Record<string, string>;
  }): Promise<void> {
    const state = this.sessions.get(opts.sessionId);
    if (!state) return;
    const prevEnv = state.env ?? {};
    // opts.env is the composer's CURRENT snapshot (from envForChat), which emits
    // the Fast/add-dirs knobs BY OMISSION (absent = off / none). A plain merge
    // can't delete a key, so a stale "on" value would survive a toggle-OFF —
    // fastMode/dirs silently stuck (the live-clear contract in buildFlagSettings
    // defeated upstream). Drop those by-omission keys from the prior env first so
    // the incoming snapshot is authoritative, while still preserving the
    // creation-time provider keys (CLAUDE_*/ANTHROPIC_* from deriveProviderEnv)
    // that envForChat does NOT carry.
    const carried = { ...prevEnv };
    delete carried.ZEROS_FAST_MODE;
    delete carried.ZEROS_ADDITIONAL_DIRS;
    // Same by-omission contract: envForChat emits the fallback /
    // budget knobs only when ON, so a stale value must not survive a toggle-OFF.
    delete carried.CLAUDE_FALLBACK_MODEL;
    delete carried.CLAUDE_MAX_BUDGET_USD;
    delete carried[CLAUDE_IDLE_TIMEOUT_ENV_VAR];
    state.env = { ...carried, ...opts.env };
    // Preserve the original idleSince while re-scheduling: shortening a
    // timeout below time already elapsed releases immediately; lengthening it
    // extends the same idle interval rather than restarting the clock.
    this.refreshIdleTeardown(state);
    const maxTurnsChanged =
      prevEnv.CLAUDE_MAX_TURNS !== state.env.CLAUDE_MAX_TURNS;
    const maxEffortToggled =
      (prevEnv.ZEROS_THINKING_EFFORT === "max") !==
      (state.env.ZEROS_THINKING_EFFORT === "max");
    // fallbackModel and maxBudgetUsd are creation-time options
    // (no live setter), so a change stages a restart just like CLAUDE_MAX_TURNS.
    const reliabilityChanged =
      prevEnv.CLAUDE_FALLBACK_MODEL !== state.env.CLAUDE_FALLBACK_MODEL ||
      prevEnv.CLAUDE_MAX_BUDGET_USD !== state.env.CLAUDE_MAX_BUDGET_USD;
    if (!maxTurnsChanged && !maxEffortToggled && !reliabilityChanged) {
      try {
        await state.query?.applyFlagSettings(this.buildFlagSettings(state));
      } catch {
        /* older CLI / between turns — staged for next creation */
      }
      return;
    }
    // CLAUDE_MAX_TURNS / the "max" effort tier can't ride the live flag-settings
    // layer — they need a fresh query. Stage a restart for the NEXT prompt()
    // (which recreates with resume) rather than tearing down here: an immediate
    // config-driven teardown could race a concurrent prompt, and a mid-turn
    // teardown would abort the running turn. The separate idle timer is
    // generation-guarded and rechecks all activity at its boundary.
    state.pendingRestart = true;
  }

  // ── permission round-trip (replaces the PreToolUse HTTP hook) ──

  respondToPermission(opts: {
    permissionId: string;
    response: RequestPermissionResponse;
  }): void {
    for (const state of this.sessions.values()) {
      const resolver = state.pendingPermissions.get(opts.permissionId);
      if (!resolver) continue;
      state.pendingPermissions.delete(opts.permissionId);
      resolver(opts.response);
      return;
    }
  }

  /** The SDK calls this before running any tool that isn't auto-allowed.
   *  We raise the same permission UI the hook path used, await the user's
   *  decision (keyed by permissionId so N concurrent/subagent requests
   *  resolve independently — no deadlock), and map it to allow/deny. */
  private canUseTool(state: SdkSession) {
    return (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        toolUseID?: string;
        /** Newer SDKs provide user-facing request copy/correlation metadata.
         * They enrich the canonical PermissionCard only; helper identity never
         * selects a separate renderer. */
        title?: string;
        requestId?: string;
        agentID?: string;
        /** SDK-proposed permission rules for "always allow". We persist the
         *  scoped `addRules` ones (re-destined to localSettings) as the project
         *  rule; edit tools with no such rule fall back to a family allow (see
         *  the projectRules computation below). */
        suggestions?: PermissionUpdate[];
      },
    ): Promise<PermissionResult> => {
      // AskUserQuestion is a QUESTION, not a permission gate — route it to the
      // blocking question channel instead of a spurious Allow/Deny card. This
      // canUseTool path is the DEMONSTRABLE one (it fires today); onUserDialog
      // is wired defensively (see options block) for SDK versions that route it
      // there instead. Deduped by toolUseID so at most one card appears.
      if (/^AskUserQuestion$/i.test(toolName)) {
        return this.handleAskUserQuestionTool(state, input, options);
      }
      const permissionId = randomUUID();
      const toolCallId = options.toolUseID ?? `${Date.now()}`;
      // "Allow for this project" persists an ALLOW RULE to localSettings
      // (`.claude/settings.local.json`). Two shapes:
      //  • If the SDK proposed its own SCOPED allow rule (e.g. a Bash command),
      //    persist exactly that (re-destined to localSettings) — narrow + honest.
      //    Button: "Allow for this project".
      //  • Else if this is an EDIT tool, offer an explicit project-WIDE edit
      //    allow (rules for the whole edit-tool family — the accept-edits
      //    posture as scoped rules, since the SDK only ever suggests `setMode`
      //    for edits, which we can't persist to an in-repo file). Button:
      //    "Allow all edits in this project" (honest about the breadth).
      // We NEVER synthesize a tool-wide rule for Bash/exec tools — that would be
      // RCE-by-default — so a Bash call with no scoped suggestion gets no project
      // option (chat-scope only). "Allow for this chat" is always offered (a
      // Zeros chat-scoped policy recorded renderer-side; no SDK write).
      const scopedRules = (options.suggestions ?? [])
        .filter((s) => s.type === "addRules" && s.behavior === "allow")
        .map((s) => ({ ...s, destination: "localSettings" as const }));
      let projectRules: PermissionUpdate[] = scopedRules;
      let projectName = "Allow for this project";
      if (scopedRules.length === 0 && EDIT_TOOLS.has(toolName)) {
        projectRules = [
          {
            type: "addRules",
            rules: [...EDIT_TOOLS].map((t) => ({ toolName: t })),
            behavior: "allow",
            destination: "localSettings",
          },
        ];
        projectName = "Allow all edits in this project";
      }
      const offerProject = projectRules.length > 0;
      const request: RequestPermissionRequest = {
        sessionId: state.zerosSessionId,
        ...(typeof options.title === "string" && options.title.trim()
          ? { title: options.title.trim() }
          : {}),
        nativeRequestId:
          typeof options.requestId === "string" && options.requestId
            ? options.requestId
            : (options.toolUseID ?? permissionId),
        toolCall: {
          toolCallId,
          title: toolName,
          kind: "other",
          rawInput: input,
          status: "pending",
        },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          {
            optionId: "allow_always",
            name: "Allow for this chat",
            kind: "allow_always",
          },
          ...(offerProject
            ? [
                {
                  optionId: "allow_project",
                  name: projectName,
                  kind: "allow_always_project",
                },
              ]
            : []),
          { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        ],
      } as never;

      return new Promise<PermissionResult>((resolve) => {
        let settled = false;
        const finish = (result: PermissionResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal.removeEventListener("abort", onAbort);
          this.ctx.emit.onPermissionSettled?.(
            this.agentId,
            permissionId,
            state.zerosSessionId,
          );
          resolve(result);
        };
        const allow = (updatedPermissions?: PermissionUpdate[]) =>
          finish(
            updatedPermissions && updatedPermissions.length > 0
              ? { behavior: "allow", updatedInput: input, updatedPermissions }
              : { behavior: "allow", updatedInput: input },
          );
        // Deny WITHOUT interrupt — the model is told the tool was refused and
        // keeps going (e.g. denying ExitPlanMode must keep the session
        // planning, not kill the turn).
        const deny = () =>
          finish({
            behavior: "deny",
            message: "User denied this tool call.",
          });

        // Map the picked option → SDK result. "Allow for this project" persists
        // `projectRules` to localSettings (`.claude/settings.local.json`) so the
        // rule survives across chats/CLI AND the session stops re-prompting.
        // "Allow once"/"Allow for this chat" just allow. Cancelled / unknown /
        // timeout / abort → deny.
        const settle = (response: RequestPermissionResponse) => {
          const outcome = (
            response as { outcome?: { outcome?: string; optionId?: string } }
          ).outcome;
          const optionId =
            outcome?.outcome === "selected" ? (outcome.optionId ?? "") : "";
          if (optionId === "allow_project") {
            // projectRules is non-empty exactly when the option was offered; on
            // a spurious/forged allow_project (empty) `allow` degrades to a
            // plain once-allow — it never persists a broad rule.
            allow(projectRules);
          } else if (optionId === "allow_once" || optionId === "allow_always") {
            allow();
          } else {
            deny();
          }
        };

        // Auto-deny if the user never answers (window closed / dropped UI)
        // so a tool call can't block the turn forever.
        const timer = setTimeout(() => {
          if (!state.pendingPermissions.has(permissionId)) return;
          state.pendingPermissions.delete(permissionId);
          deny();
        }, PERMISSION_RESPONSE_TIMEOUT_MS);
        timer.unref?.();

        // If the whole query aborts (cancel/dispose) while we're waiting,
        // release the gate so the SDK can unwind.
        const onAbort = () => {
          if (!state.pendingPermissions.has(permissionId)) return;
          state.pendingPermissions.delete(permissionId);
          deny();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });

        state.pendingPermissions.set(permissionId, (response) => {
          settle(response);
        });
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        this.ctx.emit.onPermissionRequest(this.agentId, permissionId, request);
      });
    };
  }

  // ── AskUserQuestion (blocking questions) ──────────────────
  //
  // Two channels can carry a Claude question and we can't know at build time
  // which the installed CLI uses (opaque in the bundled binary), so BOTH are
  // wired and deduped by toolUseID:
  //   • canUseTool special-case (B) — the path that demonstrably fires today.
  //     We deliver the answer SAME-TURN via a deny message (the model reads it
  //     and continues); we cannot `allow` because the tool's native dialog has
  //     no terminal to collect from headlessly.
  //   • onUserDialog (A) — the SDK's real blocking-dialog channel. If the CLI
  //     routes AskUserQuestion here, we `{behavior:'completed', result}` with a
  //     reconstructed AskUserQuestionOutput; the tool is then `allow`ed so it
  //     consumes that result.

  /** canUseTool path (B): park the tool resolver on the question. */
  private handleAskUserQuestionTool(
    state: SdkSession,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID?: string },
  ): Promise<PermissionResult> {
    const pq = this.raiseQuestion(state, options.toolUseID, input);
    return new Promise<PermissionResult>((resolve) => {
      pq.toolResolve = resolve;
      const onAbort = () =>
        this.settleQuestion(state, pq.questionId, { outcome: "dismissed" });
      options.signal.addEventListener("abort", onAbort, { once: true });
      pq.detach.push(() =>
        options.signal.removeEventListener("abort", onAbort),
      );
    });
  }

  /** onUserDialog path (A): the SDK's blocking dialog channel. */
  private onUserDialog(state: SdkSession) {
    return (
      request: UserDialogRequest,
      options?: { signal: AbortSignal },
    ): Promise<UserDialogResult> => {
      const payload = request.payload as Record<string, unknown> | undefined;
      const hasQuestions =
        Array.isArray(payload?.questions) &&
        (payload!.questions as unknown[]).length > 0;
      // Diagnostic: surfaces the real dialogKind in the user's Mac
      // logs so we can confirm whether AskUserQuestion flows through here.
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[zeros] onUserDialog dialogKind=${request.dialogKind} hasQuestions=${hasQuestions}`,
      );
      if (request.dialogKind === "permission_workflow" && payload) {
        return this.raiseWorkflowApproval(
          state,
          request,
          payload,
          options?.signal,
        );
      }
      // The SDK contract requires unrecognized kinds be answered `cancelled`.
      if (!hasQuestions) return Promise.resolve({ behavior: "cancelled" });
      const pq = this.raiseQuestion(state, request.toolUseID, payload!);
      return new Promise<UserDialogResult>((resolve) => {
        pq.dialogResolve = resolve;
      });
    };
  }

  /** Claude's native workflow gate is a blocking dialog, but visually it is
   * still the ONE PermissionCard. Only the title, phase pills, and row copy are
   * data-driven; the renderer/card chrome is shared with every other gate. */
  private raiseWorkflowApproval(
    state: SdkSession,
    dialog: UserDialogRequest,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<UserDialogResult> {
    const permissionId = randomUUID();
    const payloadRequestId =
      typeof payload.requestId === "string" && payload.requestId
        ? payload.requestId
        : undefined;
    const nativeRequestId =
      payloadRequestId ?? dialog.toolUseID ?? permissionId;
    const workflowName =
      typeof payload.workflowName === "string" && payload.workflowName.trim()
        ? payload.workflowName.trim()
        : "Workflow";
    const phases = parseWorkflowApprovalPhases(payload.script);
    // Every pill carries its own unit. Stating it once (first pill only) made
    // the rest read as bare numbers — and a pill is shown on its own, so
    // "Verify · 4" has nothing to inherit the unit from.
    const contextItems = phases.map((phase) =>
      phase.agents === null
        ? phase.title
        : `${phase.title} · ${phase.agents} ${
            phase.agents === 1 ? "agent" : "agents"
          }`,
    );
    const request: RequestPermissionRequest = {
      sessionId: state.zerosSessionId,
      title: "Workflow approval",
      nativeRequestId,
      ...(contextItems.length > 0 ? { contextItems } : {}),
      useOptionNames: true,
      toolCall: {
        toolCallId: dialog.toolUseID ?? nativeRequestId,
        title: "Workflow",
        kind: "other",
        status: "pending",
        rawInput: {
          workflowName,
          ...(typeof payload.description === "string"
            ? { description: payload.description }
            : {}),
        },
      },
      options: [
        { optionId: "allow_once", name: "Run once", kind: "allow_once" },
        {
          optionId: "allow_always",
          name: "Always allow in this chat",
          kind: "allow_always",
        },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
      ],
    };

    return new Promise<UserDialogResult>((resolve) => {
      let settled = false;
      const finish = (result: UserDialogResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.ctx.emit.onPermissionSettled?.(
          this.agentId,
          permissionId,
          state.zerosSessionId,
        );
        resolve(result);
      };
      const timer = setTimeout(() => {
        if (!state.pendingPermissions.has(permissionId)) return;
        state.pendingPermissions.delete(permissionId);
        finish({ behavior: "cancelled" });
      }, PERMISSION_RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => {
        if (!state.pendingPermissions.has(permissionId)) return;
        state.pendingPermissions.delete(permissionId);
        clearTimeout(timer);
        finish({ behavior: "cancelled" });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      state.pendingPermissions.set(permissionId, (response) => {
        clearTimeout(timer);
        const outcome = response.outcome;
        if (outcome.outcome !== "selected") {
          finish({ behavior: "cancelled" });
          return;
        }
        const optionId = outcome.optionId;
        if (optionId === "allow_once" || optionId === "allow_always") {
          finish({
            behavior: "completed",
            result: { behavior: "allow" },
          } as UserDialogResult);
        } else {
          finish({
            behavior: "completed",
            result: {
              behavior: "deny",
              message: "User denied this workflow.",
            },
          } as UserDialogResult);
        }
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.ctx.emit.onPermissionRequest(this.agentId, permissionId, request);
    });
  }

  /** Mint (or adopt, by toolUseID) a pending question and emit it once. */
  private raiseQuestion(
    state: SdkSession,
    toolUseID: string | undefined,
    input: Record<string, unknown>,
  ): PendingQuestion {
    const existingId = toolUseID
      ? state.questionByToolUse.get(toolUseID)
      : undefined;
    const existing = existingId
      ? state.pendingQuestions.get(existingId)
      : undefined;
    if (existing) return existing;

    const questionId = randomUUID();
    const request = buildClaudeQuestionRequest(
      state.zerosSessionId,
      questionId,
      toolUseID,
      input,
    );
    const timer = setTimeout(() => {
      this.settleQuestion(state, questionId, { outcome: "dismissed" });
    }, PERMISSION_RESPONSE_TIMEOUT_MS);
    timer.unref?.();
    const pq: PendingQuestion = {
      questionId,
      toolUseID,
      input,
      request,
      timer,
      detach: [],
    };
    state.pendingQuestions.set(questionId, pq);
    if (toolUseID) state.questionByToolUse.set(toolUseID, questionId);
    this.questionIndex.set(questionId, state);
    this.ctx.emit.onQuestionRequest(this.agentId, questionId, request);
    return pq;
  }

  /** Settle a pending question — resolves whichever channel-resolvers parked. */
  private settleQuestion(
    state: SdkSession,
    questionId: string,
    outcome: QuestionResponse["outcome"],
  ): void {
    const pq = state.pendingQuestions.get(questionId);
    if (!pq) return;
    state.pendingQuestions.delete(questionId);
    if (pq.toolUseID) state.questionByToolUse.delete(pq.toolUseID);
    this.questionIndex.delete(questionId);
    clearTimeout(pq.timer);
    for (const off of pq.detach) off();

    if (outcome.outcome === "answered") {
      // Channel preference (2026-07-04): when the TOOL resolver is parked
      // (canUseTool fired — the demonstrably-working path), ALWAYS deliver
      // via deny+message, even if a dialog is also parked. The old dual-
      // channel path (`dialog completed` + `tool allow`) let the CLI run
      // AskUserQuestion natively after the allow — in a headless stdin-closed
      // process that can hang the turn forever if the CLI doesn't consume
      // the completed dialog result ("answered but still loading"). The
      // deny message is read by the model same-turn either way.
      if (pq.toolResolve) {
        pq.toolResolve({
          behavior: "deny",
          message: formatAnswerForClaude(pq.input, outcome.answers),
        });
        // A dialog parked for the same ask is now moot — release it.
        pq.dialogResolve?.({ behavior: "cancelled" });
      } else {
        // Dialog-only (A): complete it with the reconstructed output.
        pq.dialogResolve?.({
          behavior: "completed",
          result: buildAskUserQuestionOutput(pq.input, outcome.answers),
        });
      }
    } else {
      // Dismissed / timed out / aborted. Same channel preference as above:
      // the tool is ALWAYS denied (never allowed to run its native dialog in
      // a headless process); a parked dialog is cancelled alongside.
      pq.dialogResolve?.({ behavior: "cancelled" });
      pq.toolResolve?.({
        behavior: "deny",
        message:
          "The user dismissed the question without answering; proceed with your best judgment or ask again if essential.",
      });
    }

    // Everything below is best-effort AFTER the SDK resolvers — the resolve
    // above is what un-blocks Claude; a failure here must never strand it.
    try {
      // Durable resolution record: stamp the ENGINE-persisted transcript by
      // emitting a synthetic tool_call_update onto the session stream. The
      // renderer's own optimistic stamp lives only in memory and is wiped by
      // the next engine-window reconcile / reload; this update makes the record
      // authoritative everywhere. Addressed by the translator's MINTED id
      // (tool_call_update matches on toolCallId, not the vendor id).
      const mintedId = pq.toolUseID
        ? state.translator.toolCallIdFor(pq.toolUseID)
        : undefined;
      if (mintedId) {
        this.ctx.emit.onSessionUpdate(this.agentId, {
          sessionId: state.zerosSessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: mintedId,
            rawOutput: {
              zerosQuestion: buildQuestionStamp(pq.request, outcome),
            },
          },
        } as never);
      }

      // Tell the renderer the question is settled. Covers the settles the UI
      // did NOT initiate (response timeout, turn abort, another client); for
      // a UI-initiated answer it's a harmless echo (that client already
      // dequeued the card).
      this.ctx.emit.onQuestionSettled?.(
        this.agentId,
        questionId,
        state.zerosSessionId,
        outcome,
      );
    } catch (err) {
      this.ctx.emit.onAgentStderr(
        this.agentId,
        `[zeros] question settle emit failed for ${questionId}: ${String(err)}`,
      );
    }
  }

  respondToQuestion(opts: {
    questionId: string;
    response: QuestionResponse;
    nativeRequestId?: string;
  }): boolean {
    // 1) Adapter-level index — survives a session rebuild that orphaned the
    //    state object out of `sessions` (the parked resolver is still live).
    const indexed = this.questionIndex.get(opts.questionId);
    if (indexed?.pendingQuestions.has(opts.questionId)) {
      this.settleQuestion(indexed, opts.questionId, opts.response.outcome);
      return true;
    }
    // 2) Live-session scan by questionId.
    for (const state of this.sessions.values()) {
      if (state.pendingQuestions.has(opts.questionId)) {
        this.settleQuestion(state, opts.questionId, opts.response.outcome);
        return true;
      }
    }
    // 3) Vendor-id fallback: an SDK replay / session rebuild re-raised the
    //    SAME underlying ask under a fresh questionId, while the renderer
    //    deduped on nativeRequestId and kept the ORIGINAL id. The answer is
    //    for the same question — settle it by the vendor correlation id.
    if (opts.nativeRequestId) {
      const states = new Set([
        ...this.questionIndex.values(),
        ...this.sessions.values(),
      ]);
      for (const state of states) {
        for (const pq of state.pendingQuestions.values()) {
          if (pq.request.nativeRequestId === opts.nativeRequestId) {
            this.settleQuestion(state, pq.questionId, opts.response.outcome);
            return true;
          }
        }
      }
    }
    // No resolver anywhere — the question already settled (timeout / abort /
    // another client). The answer is dropped by design, but NEVER silently:
    // this is the "user answered and the agent kept loading" signature, and
    // the stderr line is how we find it in the field.
    this.ctx.emit.onAgentStderr(
      this.agentId,
      `[zeros] respondToQuestion: no pending question ${opts.questionId} (native ${opts.nativeRequestId ?? "-"}) — answer dropped (already settled or session rebuilt)`,
    );
    return false;
  }

  // ── account ───────────────────────────────────────────

  /** Read the signed-in Claude account via the SDK's `query.accountInfo()`.
   *  Prefers an already-live session's query (no extra process); falls back
   *  to a short-lived throwaway query when no chat is open. Best-effort — any
   *  failure (or an API-key / 3P backend, which carries no account identity)
   *  returns null so the panel shows "—". */
  async getAccountInfo(): Promise<AccountDetails | null> {
    // Fast path: reuse a live session's query — no extra process.
    for (const state of this.sessions.values()) {
      if (!state.query) continue;
      try {
        return this.mapAccount(await state.query.accountInfo());
      } catch {
        /* fall through to a throwaway query */
      }
      break;
    }
    // No live query → spin a throwaway one. accountInfo() is a control
    // request, so we keep an empty (never-fed) input open so no turn runs,
    // then close it. NOTE: that accountInfo() resolves on a pre-turn query is
    // verified only on a Mac with the claude CLI signed in — not in the
    // cloud sandbox; on failure this degrades to null (panel shows "—").
    const input = new InputQueue<SDKUserMessage>();
    let q: Query | null = null;
    try {
      q = this.queryFn({
        prompt: input,
        options: { cwd: this.ctx.projectRoot },
      });
      const info = await Promise.race([
        q.accountInfo(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("accountInfo timeout")), 8_000),
        ),
      ]);
      return this.mapAccount(info);
    } catch {
      return null;
    } finally {
      input.end();
      try {
        q?.close();
      } catch {
        /* already closed */
      }
    }
  }

  /** Map the SDK's AccountInfo onto the panel's AccountDetails. Null when
   *  there's nothing identifying. `subscriptionType` is sent raw — the
   *  renderer title-cases it ("max" → "Max"). */
  private mapAccount(info: AccountInfo): AccountDetails | null {
    const email = info.email || undefined;
    const org = info.organization || undefined;
    const plan = info.subscriptionType || undefined;
    if (!email && !org && !plan) return null;
    return { provider: "Anthropic", plan, org, email };
  }

  // ── dispose ───────────────────────────────────────────

  async disposeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    await this.teardown(state);
  }

  async dispose(): Promise<void> {
    const states = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(states.map((s) => this.teardown(s)));
    // teardown → settleQuestion already removed each entry; clear catches any
    // orphaned-state stragglers so a disposed adapter pins no session objects.
    this.questionIndex.clear();
  }

  private async teardown(state: SdkSession): Promise<void> {
    state.disposed = true;
    state.cancelRequested = true;
    // Same reason as cancel(): a prompt() parked on a teardown seam must not
    // clear a stop that was recorded after it started.
    state.cancelSeq += 1;
    this.clearIdleTeardown(state);
    state.idleSince = null;
    // Release any open permission gates so canUseTool unwinds.
    for (const resolver of state.pendingPermissions.values()) {
      resolver({
        outcome: { outcome: "cancelled" },
      } as RequestPermissionResponse);
    }
    state.pendingPermissions.clear();
    // Release any parked questions so onUserDialog / canUseTool unwind.
    for (const questionId of [...state.pendingQuestions.keys()]) {
      this.settleQuestion(state, questionId, { outcome: "dismissed" });
    }
    try {
      state.abort.abort();
    } catch {
      /* no-op */
    }
    state.input.end();
    try {
      state.query?.close();
    } catch {
      /* already closed */
    }
    state.query = null;
    if (state.consumer) {
      await state.consumer.catch(() => {});
    }
    await removeSessionDir(state.zerosSessionId).catch((err) => {
      console.warn(
        `[agents] claude-sdk session-dir cleanup failed for ${state.zerosSessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // ── internals ─────────────────────────────────────────

  private mustState(sessionId: string): SdkSession {
    const state = this.sessions.get(sessionId);
    if (!state) {
      // Recoverable: the engine restarted and the renderer is prompting a
      // sessionId from the previous process. session-expired → the renderer
      // re-establishes (loadSession) and retries.
      throw new AgentFailureError({
        kind: "session-expired",
        message: `unknown session: ${sessionId}`,
        stage: "prompt",
        agentId: this.agentId,
      });
    }
    return state;
  }

  /** Derive the live-mutable knobs (effort ≤ xhigh, fast, ultracode, and the
   *  COMPLETE permissions set) from state.env into a flag-settings object.
   *  This is the single source of truth shared by buildOptions (creation-time,
   *  via Options.settings) and updateConfig (mid-session, via
   *  query.applyFlagSettings) — so a knob is wired identically whether the
   *  query is being created or live-updated.
   *
   *  CRITICAL: applyFlagSettings shallow-merges top-level keys and REPLACES the
   *  whole `permissions` object on each call. So we ALWAYS send the COMPLETE
   *  permissions (additionalDirectories + allow + deny TOGETHER) and represent
   *  a removed value as an EMPTY ARRAY (not by omission) — otherwise clearing a
   *  rule mid-session would silently leave the prior value in place.
   *
   *  Note: Settings.effortLevel is low|medium|high|xhigh — it has NO "max".
   *  The "max" tier rides top-level Options.effort instead (see buildOptions),
   *  so it is NOT represented here. */
  private buildFlagSettings(state: SdkSession): Partial<Settings> {
    const env = state.env;
    const effortEnv = env?.ZEROS_THINKING_EFFORT?.trim();
    const fast = env?.ZEROS_FAST_MODE === "1";
    const ultracode = effortEnv === "ultracode";
    // ultracode ⇒ xhigh effort + the standing dynamic-workflow permission.
    // Plain low/medium/high/xhigh map 1:1; "max" is excluded (top-level Option).
    const SETTINGS_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
    const effortLevel: Settings["effortLevel"] | undefined = ultracode
      ? "xhigh"
      : effortEnv && SETTINGS_EFFORTS.has(effortEnv)
        ? (effortEnv as Settings["effortLevel"])
        : undefined;
    // Extra working dirs (the `/add-dir` command) + the tool allow/deny rules.
    // All three live together inside permissions (the whole-object replacement
    // contract above), each defaulting to [] so a removal actually clears.
    const additionalDirectories = parseAdditionalDirs(
      env?.ZEROS_ADDITIONAL_DIRS,
    );
    const allow = parseToolList(env?.CLAUDE_ALLOWED_TOOLS);
    const deny = parseToolList(env?.CLAUDE_DISALLOWED_TOOLS);
    return {
      // effortLevel is omitted only for the "max"/invalid tier, which never
      // reaches the live applyFlagSettings path (it forces a restart instead);
      // for every live tier it's present, so shallow-merge updates it.
      ...(effortLevel ? { effortLevel } : {}),
      // fastMode/ultracode are EXPLICIT booleans (never omitted): applyFlagSettings
      // shallow-merges top-level keys, so omitting them when off would leave a
      // prior `true` in place and the toggle-OFF would silently no-op. Sending
      // `false` is what actually clears them on the live query.
      fastMode: fast,
      ultracode,
      permissions: { additionalDirectories, allow, deny },
    };
  }

  private buildOptions(state: SdkSession): Options {
    const env = state.env;
    // A live setModel() override wins over the creation-time env model.
    const model = state.model ?? env?.ANTHROPIC_MODEL?.trim();
    // The live-mutable knobs (effort ≤ xhigh, fast, ultracode, permissions)
    // ride the flag-settings layer so updateConfig can mutate them mid-session
    // via applyFlagSettings — buildFlagSettings is the shared derivation.
    const settings = this.buildFlagSettings(state);
    // "max" is NOT a Settings.effortLevel — it's only a top-level Options.effort
    // tier. So the top-level `effort` is set ONLY for "max"; every other tier
    // (low/medium/high/xhigh/ultracode⇒xhigh) is carried inside `settings`.
    const effortEnv = env?.ZEROS_THINKING_EFFORT?.trim();
    const fast = env?.ZEROS_FAST_MODE === "1";
    const ultracode = effortEnv === "ultracode";
    const maxEffort: EffortLevel | undefined =
      effortEnv === "max" ? "max" : undefined;
    const maxTurns = Number.parseInt(env?.CLAUDE_MAX_TURNS ?? "", 10);
    const appendSys = env?.CLAUDE_APPEND_SYSTEM_PROMPT?.trim();
    // Overload/unavailable fallback. Never fall back to the model
    // that's already primary (a self-fallback would mask real outages). The
    // SDK re-tries the primary at the start of each user turn, so a blip
    // doesn't permanently demote the session.
    const fallbackRaw = env?.CLAUDE_FALLBACK_MODEL?.trim();
    const fallbackModel =
      fallbackRaw && fallbackRaw !== model ? fallbackRaw : undefined;
    // The per-turn USD cap (Settings → Models → Budget). The SDK
    // ends the run with an `error_max_budget_usd` result when it's hit; a
    // budget stop then stages a query restart (see runConsumer) so Continue
    // starts under a fresh cap.
    const budgetUsd = Number.parseFloat(env?.CLAUDE_MAX_BUDGET_USD ?? "");
    const maxBudgetUsd =
      Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : undefined;
    // Arm the translator's fallback detection + budget context for this
    // query generation (the translator lives for the whole session; these
    // reflect the CURRENT query's options).
    state.translator.armFallbackDetection(
      model ?? null,
      Boolean(fallbackModel),
    );
    state.translator.budgetCapUsd = maxBudgetUsd ?? null;

    // Per-session registry (gateway-resolved for this cwd: user + repo +
    // workspace layers, RCE-gated) wins; fall back to the global view.
    const sessionMcp = state.mcpServers ?? this.ctx.mcpServers;
    const mcpServers =
      sessionMcp.length > 0
        ? Object.fromEntries(
            sessionMcp.map((s) => [
              s.name,
              s.transport === "stdio"
                ? {
                    type: "stdio",
                    command: s.command,
                    ...(s.args ? { args: s.args } : {}),
                    ...(s.env ? { env: s.env } : {}),
                  }
                : {
                    type: "http",
                    url: s.url,
                    ...(s.headers ? { headers: s.headers } : {}),
                  },
            ]),
          )
        : undefined;

    // Resolve the `claude` executable OURSELVES rather than letting the SDK do
    // it. See binary-resolver.ts — the SDK's lookup can only work where a real
    // node_modules sits next to sdk.mjs, which is true in dev and false in every
    // packaged build. Failing HERE (before query()) turns an opaque
    // "AGENT RESPONSE FAILURE" into a message that names the fix.
    const cli = resolveClaudeCli({ override: state.cliBinary });
    if (!cli.path) {
      throw new AgentFailureError({
        kind: "auth-required",
        message: claudeCliMissingMessage(),
        stage: "prompt",
        agentId: this.agentId,
      });
    }
    const cliPath = cli.path;
    // One line per engine boot recording WHICH tier answered. A "well-known" or
    // "path" hit inside a packaged app means the staged runtime is missing and
    // packaging regressed — that is the signal a field log needs to show it.
    if (loggedCliSource !== cli.source) {
      loggedCliSource = cli.source;
      console.info(
        `[claude-sdk] claude CLI: ${cliPath} (source=${cli.source}${
          isPinnedClaudeRuntime(cli.source)
            ? ""
            : ", NOT the app's pinned runtime"
        })`,
      );
    }

    const options: Options = {
      cwd: state.cwd,
      // The SDK REPLACES the subprocess env entirely when `env` is set, so
      // we MUST spread process.env (PATH/HOME/keychain access depend on it).
      ...(env && Object.keys(env).length > 0
        ? {
            env: preserveAmbientConfigRoots({
              ...(process.env as Record<string, string>),
              ...env,
            }),
          }
        : {}),
      permissionMode: toSdkPermissionMode(state.permissionMode),
      // `bypassPermissions` is INERT without this companion flag — the SDK
      // "requires allowDangerouslySkipPermissions" and keeps calling canUseTool
      // (so "Full Access" kept prompting per action). Scope it to
      // bypass ONLY: in every other mode permissionMode remains the sole gate,
      // so a wrong assumption here can never silently skip a non-bypass chat.
      //
      // canUseTool and bypass are MUTUALLY EXCLUSIVE by SDK contract. Building
      // a query with BOTH `canUseTool` and `bypassPermissions` throws
      // `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` ("canUseTool will not be invoked:
      // permissionMode 'bypassPermissions' auto-approves every tool call … use a
      // PreToolUse hook instead") inside `query()`, which rejects at ensureQuery
      // → the prompt fails as a protocol-error and the user sees "AGENT RESPONSE
      // FAILURE" on EVERY send while in Full Access. In bypass the SDK
      // auto-approves and never
      // consults canUseTool anyway, so omitting it loses NOTHING — AskUserQuestion
      // still rides the onUserDialog channel below. A live mode switch that
      // crosses the bypass boundary rebuilds the query (see setPermissionMode's
      // pendingRestart), so gated modes get canUseTool back before the next turn.
      ...(state.permissionMode === "bypass"
        ? { allowDangerouslySkipPermissions: true }
        : { canUseTool: this.canUseTool(state) }),
      // (A) Blocking-dialog channel. Wired defensively: if this CLI routes
      // AskUserQuestion through onUserDialog we handle it here; otherwise the
      // canUseTool special-case (B) covers it. `supportedDialogKinds` is a
      // best-effort candidate list (the real kind is opaque in the bundled
      // binary — the onUserDialog diagnostic log reveals it at runtime).
      // Deliberately excludes 'refusal_fallback_prompt' so refusal behavior is
      // unchanged.
      onUserDialog: this.onUserDialog(state),
      // Passive lifecycle taps. `background_tasks_changed` does not include
      // session-scoped one-shot wakeups; StopHookInput.session_crons is the
      // SDK's authoritative snapshot for those. Recurring crons are filtered
      // by the translator so the explicitly deferred schedules feature (008)
      // remains untouched. A loop wake clears its now-fired timer before the
      // new turn starts.
      hooks: {
        Stop: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === "Stop") {
                  state.translator.setScheduledWakeups(
                    input.session_crons ?? [],
                  );
                  this.refreshIdleTeardown(state);
                }
                return {};
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              async (input) => {
                if (
                  input.hook_event_name === "UserPromptSubmit" &&
                  (input.source === "loop_wakeup" ||
                    input.source === "schedule_wakeup")
                ) {
                  state.translator.clearScheduledWakeups();
                  state.providerRunActive = true;
                  this.markSessionBusy(state);
                }
                return {};
              },
            ],
          },
        ],
      },
      supportedDialogKinds: [
        "ask_user_question",
        "user_question",
        "tool_use_question",
        "permission_workflow",
      ],
      // Emit token-by-token `stream_event` deltas → the translator renders
      // a live typing animation (streamPartials) and de-dupes against the
      // final full message.
      includePartialMessages: true,
      // Load the user's own settings (model/MCP/project config) like the
      // CLI does — auth comes from the keychain regardless.
      settingSources: ["user", "project", "local"],
      abortController: state.abort,
      stderr: (data: string) => {
        const line = data.trimEnd();
        if (line) this.ctx.emit.onAgentStderr(this.agentId, line);
      },
      ...(state.claudeSessionId ? { resume: state.claudeSessionId } : {}),
      ...(model ? { model } : {}),
      // effort/fast/ultracode + permissions (additionalDirectories, allow,
      // deny) all ride the flag-settings layer now (live-mutable via
      // applyFlagSettings). Only the "max" tier — which Settings.effortLevel
      // can't express — stays top-level.
      ...(maxEffort ? { effort: maxEffort } : {}),
      settings,
      ...(Number.isFinite(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
      // Reliability and budget knobs (see derivations above).
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
      // ALWAYS attach the `claude_code` preset. The Agent SDK ships NO system
      // prompt by default, and the preset is what injects the dynamic `<env>`
      // block — Working directory / Is directory a git repo / Platform / git
      // status / date. Omitting it (the old `appendSys ? … : {}` made the whole
      // preset ride on a rarely-set custom append) left the model BLIND to its
      // own cwd: on its first write it would guess an absolute path like
      // `/changes.md`, hit macOS's read-only root volume (EROFS), then recover
      // by running `pwd`. Only the user's optional append text is conditional.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(appendSys ? { append: appendSys } : {}),
      },
      ...(mcpServers
        ? { mcpServers: mcpServers as Options["mcpServers"] }
        : {}),
      // ALWAYS pass an explicit executable. The SDK's own fallback — resolving
      // its platform package relative to sdk.mjs — is IMPOSSIBLE in the packaged
      // app (bun-compiled single-file engine: sdk.mjs lives in $bunfs and there
      // is no node_modules on disk), so leaving this unset made `query()` throw
      // "Native CLI binary for darwin-arm64 not found" and every send fail with
      // "AGENT RESPONSE FAILURE" — in Beta/Production only, since dev runs `bun
      // apps/desktop/src/cli.ts` where that lookup works. See binary-resolver.ts for the tier
      // order (user override → staged Contents/Resources/claude → bundled
      // package → the user's own install).
      pathToClaudeCodeExecutable: cliPath,
    };
    // Verification breadcrumb: one line per query (re)creation echoing the
    // composer knobs actually sent to the SDK. Tail the engine log (main.log /
    // `pnpm serve:engine` stderr) and confirm it flips as you toggle the
    // composer — the concrete "is it wired?" signal for model/effort/fast/
    // ultracode/plan. Dev-only — silent in a release build (gate it behind
    // ZEROS_DEV so the prod engine log isn't a per-turn firehose).
    if (isDevRuntime()) {
      // effort here is the EFFECTIVE tier: the flag-settings effortLevel
      // (low/medium/high/xhigh, incl. ultracode⇒xhigh) or the top-level "max".
      const effortLog = maxEffort ?? settings.effortLevel ?? "(default)";
      const addDirs = settings.permissions?.additionalDirectories?.length ?? 0;
      console.info(
        `[claude-sdk] turn options: model=${model ?? "(default)"} ` +
          `effort=${effortLog} fastMode=${fast} ultracode=${ultracode} ` +
          `permissionMode=${toSdkPermissionMode(state.permissionMode)} ` +
          `addDirs=${addDirs}`,
      );
    }
    return options;
  }

  /** Build the SDK message content from Zeros ContentBlocks. Images go
   *  inline as base64 image blocks (the SDK sends them over stdin, so the
   *  ARG_MAX/temp-file dance the per-turn CLI adapter needed is gone). */
  private buildContent(
    blocks: ContentBlock[],
  ): string | Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const b of blocks) {
      const block = b as unknown as {
        type?: string;
        text?: string;
        source?: { media_type?: string; data?: string; url?: string };
        mimeType?: string;
        data?: string;
        uri?: string;
      };
      if (block.type === "text" && typeof block.text === "string") {
        out.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const dataB64 = block.source?.data ?? block.data;
        const media = block.source?.media_type ?? block.mimeType;
        if (dataB64 && media) {
          out.push({
            type: "image",
            source: { type: "base64", media_type: media, data: dataB64 },
          });
        } else if (block.source?.url) {
          out.push({ type: "text", text: `![image](${block.source.url})` });
        }
      } else if (
        block.type === "resource_link" &&
        typeof block.uri === "string"
      ) {
        out.push({
          type: "text",
          text: `@${block.uri.replace(/^file:\/\//, "")}`,
        });
      }
    }
    // A single text block can collapse to a plain string (most turns).
    if (out.length === 1 && out[0].type === "text") {
      return out[0].text as string;
    }
    return out.length > 0 ? out : "";
  }

  // ── claudeSessionId persistence (cross-restart resume) ──

  private async persistClaudeSessionId(
    zerosSessionId: string,
    claudeSessionId: string,
  ): Promise<void> {
    try {
      await fsp.writeFile(
        path.join(sessionDir(zerosSessionId), SDK_SESSION_FILE),
        JSON.stringify({ claudeSessionId }),
      );
    } catch {
      /* best-effort — without it, a post-restart resume starts cold */
    }
  }

  private async readClaudeSessionId(
    zerosSessionId: string,
  ): Promise<string | null> {
    try {
      const raw = await fsp.readFile(
        path.join(sessionDir(zerosSessionId), SDK_SESSION_FILE),
        "utf-8",
      );
      const parsed = JSON.parse(raw) as { claudeSessionId?: unknown };
      return typeof parsed.claudeSessionId === "string"
        ? parsed.claudeSessionId
        : null;
    } catch {
      return null;
    }
  }
}

const MODES = [
  { id: "default", name: "Default", description: "Ask before edits." },
  { id: "plan", name: "Plan", description: "Design without executing." },
  {
    id: "accept-edits",
    name: "Accept Edits",
    description: "Auto-approve file edits.",
  },
  {
    id: "auto",
    name: "Auto",
    description:
      "A model classifier approves or denies each permission prompt. Models without the classifier (e.g. Haiku) fall back to Accept Edits.",
  },
  {
    id: "bypass",
    name: "Bypass",
    description: "Auto-approve EVERYTHING. Disables all permission checks.",
  },
] as const;

/** A LoadSessionResponse that re-advertises the mode list, so a resumed
 *  chat's permission pill uses the agent modes (and routes "Full Access"
 *  to bypass) instead of falling back to the generic local pill. */
function loadResponseWithModes(
  currentModeId: ClaudeMode,
  resumedFresh = false,
): LoadSessionResponse {
  return {
    modes: { currentModeId, availableModes: MODES },
    ...(resumedFresh ? { resumedFresh: true } : {}),
  } as never as LoadSessionResponse;
}

/** SDK SlashCommand → Zeros AvailableCommand. `argumentHint` (always a
 *  string, often "") becomes input.hint only when non-empty, which drives
 *  the picker's "takes input" tag. Aliases are dropped — the user picks the
 *  canonical name. */
function mapSlashCommands(
  cmds: SlashCommand[],
  skillNames?: ReadonlySet<string>,
): AvailableCommand[] {
  const out: AvailableCommand[] = [];
  for (const c of cmds) {
    if (!c || typeof c.name !== "string" || !c.name) continue;
    const cmd: AvailableCommand = {
      name: c.name,
      description: typeof c.description === "string" ? c.description : "",
      // The SDK merges skills + commands into one list; `init.skills` is the
      // only signal of which names are skills (see SdkSession.skillNames).
      kind: skillNames?.has(c.name) ? "skill" : "command",
    };
    const hint =
      typeof c.argumentHint === "string" ? c.argumentHint.trim() : "";
    if (hint) cmd.input = { hint };
    out.push(cmd);
  }
  return out;
}

/** Parse the ZEROS_ADDITIONAL_DIRS env value (a JSON array of absolute paths
 *  from the `/add-dir` command) into a clean string[]. Tolerant — an unset or
 *  malformed value yields [] (no extra dirs), never throws into buildOptions. */
function parseAdditionalDirs(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v !== "string") continue;
      const p = v.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}

/** Parse a comma-separated tool-rule env (CLAUDE_ALLOWED_TOOLS /
 *  CLAUDE_DISALLOWED_TOOLS) into a trimmed, non-empty string[]. An unset or
 *  whitespace-only value yields [] — which, sent through buildFlagSettings'
 *  permissions, EXPLICITLY clears the prior rule (the whole-object replacement
 *  applyFlagSettings does means an empty array, not omission, clears it). */
function parseToolList(raw: string | undefined): string[] {
  const value = raw?.trim();
  if (!value) return [];
  return value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
