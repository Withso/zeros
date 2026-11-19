// The Local CLI and in-process zeros_local tool share the engine's call contract.

import { z } from "zod";

/** Bumped when a request, result or error shape changes incompatibly. */
export const LOCAL_ORCHESTRATION_PROTOCOL = 1 as const;

/** These execution-scoped values are injected at admission; never disclose or forward the bearer. */
export const LOCAL_ORCHESTRATION_ENV = {
  url: "ZEROS_LOCAL_URL",
  token: "ZEROS_LOCAL_TOKEN",
  cli: "ZEROS_LOCAL_CLI",
  waitMs: "ZEROS_LOCAL_WAIT_MS",
  skill: "ZEROS_LOCAL_SKILL",
  /** Bearer for the `zeros_local` provider tool (MCP header from env). */
  toolsCapability: "ZEROS_LOCAL_TOOLS_CAPABILITY",
  /** Private per-execution folder under the engine's $TMPDIR. The CLI uses it
   * only when its loopback connection is denied (a sandboxed shell). */
  dropbox: "ZEROS_LOCAL_DROPBOX",
} as const;

/** Strip reserved names before minting a new grant so nested Zeros cannot inherit its parent's grant. */
export const LOCAL_ORCHESTRATION_ENV_NAMES: readonly string[] = Object.values(
  LOCAL_ORCHESTRATION_ENV,
);

export const LOCAL_ORCHESTRATION_CALL_PATH = "/local/v1/call" as const;

export const LOCAL_ORCHESTRATION_TOOL_SERVER = "zeros_local" as const;

/** Hard service caps for one wait (the CLI is clamped below its shell). */
export const LOCAL_WAIT_MAX_CLI_MS = 120_000;
export const LOCAL_WAIT_MAX_TOOL_MS = 600_000;
export const LOCAL_WAIT_DEFAULT_MS = 5_000;

/** Bounds that keep one request from exhausting the engine. Not product caps. */
export const LOCAL_MAX_REQUEST_BYTES = 1024 * 1024;
export const LOCAL_MAX_MESSAGE_CHARS = 120_000;
export const LOCAL_MAX_TITLE_CHARS = 200;
export const LOCAL_MAX_PAGE = 100;
export const LOCAL_MAX_REQUEST_ID_CHARS = 128;


export const LOCAL_COMMANDS = [
  "whoami",
  "models",
  "repo.list",
  "workspace.list",
  "workspace.status",
  "workspace.create",
  "chat.list",
  "chat.create",
  "chat.status",
  "chat.wait",
  "chat.messages",
  "chat.cancel",
  "chat.follow",
  "chat.unfollow",
  "message.send",
  "card.list",
  "card.answer",
  "link",
] as const;
export type LocalCommand = (typeof LOCAL_COMMANDS)[number];

/** Commands that change state. Plan/read-only callers may run only the reads,
 * plus `card.answer` for questions and denials (the engine checks the rest). */
export const LOCAL_MUTATING_COMMANDS: ReadonlySet<LocalCommand> = new Set([
  "workspace.create",
  "chat.create",
  "chat.cancel",
  "chat.follow",
  "chat.unfollow",
  "message.send",
  "card.answer",
]);

/** Commands whose duplicate must never repeat an effect. */
export const LOCAL_REQUEST_ID_COMMANDS: ReadonlySet<LocalCommand> = new Set([
  "workspace.create",
  "chat.create",
  "message.send",
]);


export const LOCAL_ERROR_CODES = [
  "USAGE",
  "NOT_FOUND",
  "NOT_LOCAL",
  "NO_CAPABILITY",
  "ENGINE_RESTARTED",
  "TIMEOUT",
  "BUSY",
  "NOT_READY",
  "STOPPED_BY_USER",
  "STALE",
  "REQUEST_CONFLICT",
  "ALREADY_SETTLED",
  "UNAVAILABLE",
  "AUTH_REQUIRED",
  "PROTOCOL_MISMATCH",
  "MODE_FORBIDS",
  "APPROVAL_GUARD",
  "OUTCOME_UNKNOWN",
  "INTERNAL",
] as const;
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

/** A wait succeeds even if the child failed: the child's outcome is data, not a CLI error. */
export const LOCAL_EXIT_CODES: Readonly<Record<LocalErrorCode, number>> = {
  INTERNAL: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  NOT_LOCAL: 3,
  NO_CAPABILITY: 4,
  ENGINE_RESTARTED: 4,
  TIMEOUT: 5,
  BUSY: 6,
  NOT_READY: 6,
  STOPPED_BY_USER: 6,
  STALE: 6,
  REQUEST_CONFLICT: 6,
  ALREADY_SETTLED: 6,
  UNAVAILABLE: 7,
  AUTH_REQUIRED: 7,
  PROTOCOL_MISMATCH: 7,
  MODE_FORBIDS: 7,
  APPROVAL_GUARD: 7,
  OUTCOME_UNKNOWN: 8,
};

export interface LocalError {
  code: LocalErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface LocalMeta {
  /** Engine boot identity; changes when Zeros restarts. */
  engine: string;
}

export type LocalEnvelope<T = unknown> =
  | { ok: true; protocol: typeof LOCAL_ORCHESTRATION_PROTOCOL; result: T; meta: LocalMeta }
  | {
      ok: false;
      protocol: typeof LOCAL_ORCHESTRATION_PROTOCOL;
      error: LocalError;
      meta?: LocalMeta;
    };

export function localOk<T>(result: T, meta: LocalMeta): LocalEnvelope<T> {
  return { ok: true, protocol: LOCAL_ORCHESTRATION_PROTOCOL, result, meta };
}

export function localFail(
  code: LocalErrorCode,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown>; meta?: LocalMeta } = {},
): LocalEnvelope<never> {
  return {
    ok: false,
    protocol: LOCAL_ORCHESTRATION_PROTOCOL,
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.details ? { details: options.details } : {}),
    },
    ...(options.meta ? { meta: options.meta } : {}),
  };
}

export function localExitCode(envelope: LocalEnvelope): number {
  return envelope.ok ? 0 : (LOCAL_EXIT_CODES[envelope.error.code] ?? 1);
}

export class LocalOrchestrationError extends Error {
  constructor(
    readonly code: LocalErrorCode,
    message: string,
    readonly options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "LocalOrchestrationError";
  }
}


export const LOCAL_LINK_KINDS = ["chat", "workspace"] as const;
export type LocalLinkKind = (typeof LOCAL_LINK_KINDS)[number];

/** One URL scheme per release channel (mirrors DeepLinkScheme in the engine
 * runtime; kept literal so this package has no engine import). */
export const LOCAL_LINK_SCHEMES = ["zeros", "zeros-alpha", "zeros-dev"] as const;
export type LocalLinkScheme = (typeof LOCAL_LINK_SCHEMES)[number];

/** Workspace numbers are permanent and never reused within an owner: local or an organization slug. */
export interface WorkspaceAddress {
  owner: string;
  number: number;
}

/** New desktop Local workspaces use this owner; organization links refer to cloud workspaces. */
export const LOCAL_WORKSPACE_LINK_OWNER = "local" as const;

export interface LocalLink {
  scheme: LocalLinkScheme;
  kind: LocalLinkKind;
  /** A chat id, a legacy workspace id (`ws_…`, `folder:<project>`), or for a
   * numbered workspace link its `<owner>/w/<n>` address, which no stored id
   * can equal because ids never contain `/`. */
  id: string;
  /** Present only on a numbered link (`<owner>/w/<n>`, `?session=` names the chat). */
  address?: WorkspaceAddress;
}

const LOCAL_LINK_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const WORKSPACE_LINK_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** Both stores keep numbers in a signed 32-bit integer column. */
const MAX_WORKSPACE_NUMBER = 2_147_483_647;
const NUMBERED_LINK =
  /^(zeros(?:-alpha|-dev)?):\/\/([A-Za-z0-9-]{1,100})\/w\/([1-9][0-9]{0,9})(?:\?session=([^&#\s]+))?$/;

export function isWorkspaceNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_WORKSPACE_NUMBER;
}

export function isWorkspaceLinkOwner(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_LINK_OWNER.test(value);
}

export function isWorkspaceLinkSession(value: unknown): value is string {
  return typeof value === "string" && LOCAL_LINK_ID.test(value);
}

export function workspaceNumberLabel(number: number): string {
  if (!isWorkspaceNumber(number)) throw new Error("Invalid workspace number.");
  return `w-${number}`;
}

export function formatWorkspaceAddress(address: WorkspaceAddress): string {
  if (!isWorkspaceLinkOwner(address.owner) || !isWorkspaceNumber(address.number))
    throw new Error("Invalid workspace for a link.");
  return `${address.owner}/w/${address.number}`;
}

/** `<scheme>://<owner>/w/<n>`, or a chat in it with `?session=<chat id>`. */
export function formatWorkspaceLink(
  scheme: LocalLinkScheme,
  address: WorkspaceAddress,
  session?: string | null,
): string {
  if (!LOCAL_LINK_SCHEMES.includes(scheme)) throw new Error("Unknown Zeros link scheme.");
  const base = `${scheme}://${formatWorkspaceAddress(address)}`;
  if (session == null) return base;
  if (!LOCAL_LINK_ID.test(session)) throw new Error("Invalid chat id for a link.");
  return `${base}?session=${encodeURIComponent(session)}`;
}

export function formatLocalLink(scheme: LocalLinkScheme, kind: LocalLinkKind, id: string): string {
  if (!LOCAL_LINK_SCHEMES.includes(scheme)) throw new Error("Unknown Zeros link scheme.");
  if (!LOCAL_LINK_ID.test(id)) throw new Error(`Invalid ${kind} id for a link.`);
  return `${scheme}://${kind}/${encodeURIComponent(id)}`;
}

/** Canonicalize accepted links before forwarding them to navigation. */
export function formatParsedLocalLink(link: LocalLink): string {
  return link.address
    ? formatWorkspaceLink(link.scheme, link.address, link.kind === "chat" ? link.id : null)
    : formatLocalLink(link.scheme, link.kind, link.id);
}

function parseNumberedLink(text: string): LocalLink | null {
  const match = NUMBERED_LINK.exec(text);
  if (!match) return null;
  const owner = match[2]!.toLowerCase();
  const number = Number(match[3]);
  if (!isWorkspaceLinkOwner(owner) || !isWorkspaceNumber(number)) return null;
  const address = { owner, number };
  if (match[4] === undefined) {
    return { scheme: match[1] as LocalLinkScheme, kind: "workspace", id: formatWorkspaceAddress(address), address };
  }
  let session: string;
  try {
    session = decodeURIComponent(match[4]);
  } catch {
    return null;
  }
  if (!LOCAL_LINK_ID.test(session)) return null;
  return { scheme: match[1] as LocalLinkScheme, kind: "chat", id: session, address };
}

/** Accept numbered and legacy workspace or chat links; reject URL options outside the contract. */
export function parseLocalLink(text: string): LocalLink | null {
  const trimmed = text.trim();
  const numbered = parseNumberedLink(trimmed);
  if (numbered) return numbered;
  const match = /^(zeros(?:-alpha|-dev)?):\/\/(chat|workspace)\/([^/?#\s]+)$/.exec(trimmed);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[3]!);
  } catch {
    return null;
  }
  if (!LOCAL_LINK_ID.test(id)) return null;
  return { scheme: match[1] as LocalLinkScheme, kind: match[2] as LocalLinkKind, id };
}

const RETIRED_SCHEME_PREFIX = "zeros-beta://";

/** A well-formed link of a retired channel (`zeros-beta://`). It is never
 * navigable; importers keep it as plain text instead of rejecting what holds it. */
export function isRetiredLocalLink(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(RETIRED_SCHEME_PREFIX) && parseLocalLink(`zeros://${trimmed.slice(RETIRED_SCHEME_PREFIX.length)}`) !== null;
}

/** Ignore sentence punctuation after generated IDs; the caller filters links to its own release channel. */
export function extractLocalLinks(text: string, limit = 64): LocalLink[] {
  const out: LocalLink[] = [];
  const seen = new Set<string>();
  // Distinct retired links still count toward `limit`, exactly as they did when
  // they were returned, so scanning stops no later than before the retirement.
  let retired = 0;
  // Numbered first: `chat/w/3` is the organization `chat`'s workspace 3, not
  // a legacy chat whose id is `w`.
  // A number runs to its end (`w/31a` names no workspace, not w-31).
  const pattern =
    /zeros(?:-alpha|-beta|-dev)?:\/\/(?:[A-Za-z0-9-]{1,100}\/w\/[0-9]{1,10}(?:\?session=[A-Za-z0-9_.:%-]+|(?![A-Za-z0-9_%]))|(?:chat|workspace)\/[A-Za-z0-9_.:%-]+)/g;
  for (const match of text.matchAll(pattern)) {
    // Scan the suffix directly to avoid retrying a regexp at each punctuation character.
    const candidate = match[0];
    let end = candidate.length;
    while (
      end > 0 &&
      (candidate[end - 1] === "." || candidate[end - 1] === ":" || candidate[end - 1] === "-")
    ) end--;
    const trimmed = candidate.slice(0, end);
    const isRetired = trimmed.startsWith(RETIRED_SCHEME_PREFIX);
    const link = parseLocalLink(isRetired ? `zeros://${trimmed.slice(RETIRED_SCHEME_PREFIX.length)}` : trimmed);
    if (!link) continue;
    const key = `${isRetired ? "zeros-beta" : link.scheme}:${link.kind}:${link.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isRetired) retired += 1;
    else out.push(link);
    if (out.length + retired >= limit) break;
  }
  return out;
}


/** Product levels used to compare and translate permission modes across
 * providers. Same provider keeps the exact native mode id. */
export const LOCAL_MODE_LEVELS = ["plan", "ask", "auto", "full"] as const;
export type LocalModeLevel = (typeof LOCAL_MODE_LEVELS)[number];

export function localModeRank(level: LocalModeLevel): number {
  return LOCAL_MODE_LEVELS.indexOf(level);
}

/** Native picker mode id → level, per agent family (model-catalog.ts
 * PERMISSION_MODE_ORDER; Codex `read-only` is its Plan toggle). */
export const LOCAL_MODE_LEVEL_BY_FAMILY: Readonly<Record<string, Readonly<Record<string, LocalModeLevel>>>> = {
  claude: { plan: "plan", default: "ask", "accept-edits": "auto", auto: "auto", bypass: "full" },
  codex: { "read-only": "plan", ask: "ask", "auto-edit": "auto", "full-access": "full" },
  cursor: { plan: "plan", auto: "auto", agent: "full" },
};

/** The mode a child of another family gets for a level: the broadest native
 * mode of that family that is not above the level. */
export const LOCAL_MODE_FOR_LEVEL_BY_FAMILY: Readonly<Record<string, Readonly<Record<LocalModeLevel, string>>>> = {
  claude: { plan: "plan", ask: "default", auto: "accept-edits", full: "bypass" },
  codex: { plan: "read-only", ask: "ask", auto: "auto-edit", full: "full-access" },
  cursor: { plan: "plan", ask: "plan", auto: "auto", full: "agent" },
};

export function localAgentFamily(agentId: string | null | undefined): string | null {
  const id = (agentId ?? "").toLowerCase();
  if (id.startsWith("claude")) return "claude";
  if (id.startsWith("codex")) return "codex";
  if (id.startsWith("cursor")) return "cursor";
  return null;
}

export function localModeLevel(agentId: string | null | undefined, modeId: string | null | undefined): LocalModeLevel | null {
  const family = localAgentFamily(agentId);
  if (!family || !modeId) return null;
  const modes = LOCAL_MODE_LEVEL_BY_FAMILY[family];
  return modes && Object.hasOwn(modes, modeId) ? modes[modeId] : null;
}

export function localModeForLevel(agentId: string | null | undefined, level: LocalModeLevel): string | null {
  const family = localAgentFamily(agentId);
  if (!family || !LOCAL_MODE_LEVELS.includes(level)) return null;
  return LOCAL_MODE_FOR_LEVEL_BY_FAMILY[family]?.[level] ?? null;
}


const requestId = z.string().min(1).max(LOCAL_MAX_REQUEST_ID_CHARS).regex(/^[A-Za-z0-9_.:-]+$/);
const ref = z.string().min(1).max(512);
const message = z.string().min(1).max(LOCAL_MAX_MESSAGE_CHARS);

export const localChatSettingsSchema = z
  .object({
    agent: z.string().min(1).max(64).optional(),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(32).optional(),
    fast: z.boolean().optional(),
    mode: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(LOCAL_MAX_TITLE_CHARS).optional(),
    notify: z.boolean().optional(),
  })
  .strict();

export const localQuestionAnswerSchema = z
  .object({
    questionId: z.string().min(1).max(256),
    selectedOptionIds: z.array(z.string().min(1).max(256)).max(64),
    freeText: z.string().max(20_000).optional(),
  })
  .strict();

export const LOCAL_FOLLOW_EVENTS = ["done", "question", "permission"] as const;
export type LocalFollowEvent = (typeof LOCAL_FOLLOW_EVENTS)[number];

export const localArgsSchemas = {
  whoami: z.object({}).strict(),
  models: z.object({ agent: z.string().min(1).max(64).optional() }).strict(),
  "repo.list": z.object({}).strict(),
  "workspace.list": z.object({ repo: ref.optional() }).strict(),
  "workspace.status": z.object({ workspace: ref }).strict(),
  "workspace.create": z
    .object({
      repo: ref,
      base: z.string().min(1).max(256).optional(),
      name: z.string().min(1).max(80).optional(),
      chat: localChatSettingsSchema.extend({ message: message.optional() }).strict().optional(),
    })
    .strict(),
  "chat.list": z.object({ workspace: ref.optional(), tree: z.boolean().optional() }).strict(),
  "chat.create": localChatSettingsSchema.extend({ workspace: ref.optional(), message }).strict(),
  "chat.status": z.object({ chat: ref }).strict(),
  "chat.wait": z
    .object({
      targets: z.array(z.object({ chat: ref, turn: z.string().min(1).max(256).optional() }).strict()).min(1).max(LOCAL_MAX_PAGE),
      any: z.boolean().optional(),
      until: z.enum(["attention", "done"]).optional(),
      timeoutMs: z.number().int().min(0).max(LOCAL_WAIT_MAX_TOOL_MS).optional(),
    })
    .strict(),
  "chat.messages": z
    .object({
      chat: ref,
      view: z.enum(["full", "summary", "last"]).optional(),
      after: z.string().min(1).max(512).optional(),
      includeTools: z.boolean().optional(),
      turn: z.string().min(1).max(256).optional(),
      limit: z.number().int().min(1).max(LOCAL_MAX_PAGE).optional(),
    })
    .strict(),
  "chat.cancel": z.object({ chat: ref }).strict(),
  "chat.follow": z
    .object({ chat: ref, events: z.array(z.enum(LOCAL_FOLLOW_EVENTS)).min(1).max(3).optional() })
    .strict(),
  "chat.unfollow": z.object({ chat: ref }).strict(),
  "message.send": z
    .object({
      chat: ref,
      message,
      delivery: z.enum(["auto", "steer", "new-turn"]).optional(),
      notify: z.boolean().optional(),
    })
    .strict(),
  "card.list": z.object({ chat: ref.optional() }).strict(),
  "card.answer": z
    .object({
      card: ref,
      option: z.string().min(1).max(256).optional(),
      answers: z.array(localQuestionAnswerSchema).min(1).max(32).optional(),
      text: z.string().min(1).max(20_000).optional(),
      deny: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      const given = [value.option !== undefined, value.answers !== undefined, value.text !== undefined, value.deny === true].filter(Boolean).length;
      if (given !== 1) {
        ctx.addIssue({ code: "custom", message: "Answer with exactly one of --option, --answers, --text or --deny." });
      }
    }),
  link: z.object({ target: ref }).strict(),
} satisfies Record<LocalCommand, z.ZodType>;

export type LocalArgs<C extends LocalCommand> = z.infer<(typeof localArgsSchemas)[C]>;

export const localCallRequestSchema = z
  .object({
    protocol: z.literal(LOCAL_ORCHESTRATION_PROTOCOL).optional(),
    command: z.enum(LOCAL_COMMANDS),
    args: z.record(z.string(), z.unknown()).default({}),
    requestId: requestId.optional(),
  })
  .strict();
export type LocalCallRequest = z.infer<typeof localCallRequestSchema>;

export function parseLocalCall(
  raw: unknown,
):
  | { ok: true; command: LocalCommand; args: Record<string, unknown>; requestId?: string }
  | { ok: false; error: LocalError } {
  const request = localCallRequestSchema.safeParse(raw);
  if (!request.success) {
    return { ok: false, error: { code: "USAGE", message: zodMessage(request.error), retryable: false } };
  }
  const args = localArgsSchemas[request.data.command].safeParse(request.data.args);
  if (!args.success) {
    return { ok: false, error: { code: "USAGE", message: zodMessage(args.error), retryable: false } };
  }
  return {
    ok: true,
    command: request.data.command,
    args: args.data as Record<string, unknown>,
    ...(request.data.requestId ? { requestId: request.data.requestId } : {}),
  };
}

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request.";
  const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}


export type LocalChatState =
  | "idle"
  | "starting"
  | "working"
  | "needs_answer"
  | "provisioning"
  | "setup_failed"
  | "archived";

export interface LocalTurnSummary {
  turnId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
}

export interface LocalChatSummary {
  chatId: string;
  link: string;
  title: string;
  workspaceId: string | null;
  workspaceLink: string | null;
  folder: string;
  agent: string | null;
  model: string | null;
  effort: string | null;
  fast: boolean;
  mode: string | null;
  modeLevel: LocalModeLevel | null;
  state: LocalChatState;
  lastTurn: LocalTurnSummary | null;
  createdBy: string | null;
  visibleAs: "self" | "workspace" | "family" | "shared";
  pendingCards: number;
}

export interface LocalWorkspaceSummary {
  workspaceId: string;
  link: string;
  name: string;
  /** Null for a repository folder; older engines may omit the permanent Local number. */
  number?: number | null;
  repoRoot: string;
  path: string;
  branch: string | null;
  kind: "worktree" | "main" | "folder";
  state: "creating" | "setting_up" | "ready" | "setup_failed" | "archived" | "missing";
  visibleAs: "self" | "family" | "shared";
}

export interface LocalRepoSummary {
  repoId: string;
  name: string;
  repoRoot: string;
  originUrl: string | null;
}

export interface LocalModelRow {
  agent: string;
  model: string;
  label: string;
  effortLevels: string[];
  defaultEffort: string | null;
  supportsFast: boolean;
  /** `available` = confirmed for this account; `unknown` = not yet checked. */
  availability: "available" | "unavailable" | "unknown";
  /** False when the agent's selected account is signed out or expired: no
   * chat can start with it until the user signs in (`AUTH_REQUIRED`). */
  signedIn: boolean;
}

export type LocalCardKind = "permission" | "approval" | "question" | "plan_approval" | "external";

export interface LocalCard {
  cardId: string;
  kind: LocalCardKind;
  chatId: string;
  chatLink: string;
  title: string;
  /** Tool call, questions and options — everything the human card shows. */
  detail: Record<string, unknown>;
  options: Array<{ id: string; label: string; effect: "allow" | "allow_always" | "deny" | "answer" }>;
  blocking: boolean;
  expiresAt: number | null;
  answerCommand: string;
}

export interface LocalMessageRow {
  messageId: string;
  turnId: string | null;
  role: "user" | "agent" | "tool" | "notice";
  from: { kind: "human" } | { kind: "agent"; chatId: string; chatLink: string } | { kind: "zeros" } | null;
  phase: string | null;
  text: string;
  truncated: boolean;
  createdAt: number;
  tool?: { name: string; status: string; input?: string; output?: string };
}

export interface LocalWhoami {
  chat: LocalChatSummary;
  workspace: LocalWorkspaceSummary | null;
  parentChatId: string | null;
  rootChatId: string;
  protocol: typeof LOCAL_ORCHESTRATION_PROTOCOL;
  skill: string | null;
  canMutate: boolean;
}
