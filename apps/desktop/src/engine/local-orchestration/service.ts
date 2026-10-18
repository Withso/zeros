// ──────────────────────────────────────────────────────────
// Local orchestration — the service behind `zeros local …`
// ──────────────────────────────────────────────────────────
//
// One implementation for both front doors (CLI over loopback HTTP, and the
// `zeros_local` provider tool). Every call:
//   1. checks the feature gate and the caller's Local ownership;
//   2. computes what the caller can see (visibility.ts) — invisible targets are
//      reported as not found;
//   3. for mutations, requires a mode that may act (Plan/read-only callers can
//      read, answer questions and deny permissions only);
//   4. replays or claims a request receipt when the command has effects.
// The engine calls the `on…` hooks so follows, notifications, shares, the
// user's Stop and waits stay current without polling providers.
// ──────────────────────────────────────────────────────────

import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { QuestionAnswer } from "@zeros/protocol/agent-events";
import type { LocalMessageChatRef, LocalMessageNote } from "@zeros/protocol/agent-messages";
import type { CardAnsweredBy } from "@zeros/protocol/messages";
import { agentControlUnavailableReason } from "@zeros/protocol/agent-control-rollout";
import {
  LOCAL_ERROR_CODES,
  LOCAL_MUTATING_COMMANDS,
  LOCAL_ORCHESTRATION_PROTOCOL,
  LOCAL_REQUEST_ID_COMMANDS,
  LOCAL_WAIT_DEFAULT_MS,
  LOCAL_WAIT_MAX_CLI_MS,
  LOCAL_WAIT_MAX_TOOL_MS,
  LocalOrchestrationError,
  extractLocalLinks,
  formatLocalLink,
  localAgentFamily,
  localFail,
  localModeLevel,
  localOk,
  parseLocalCall,
  parseLocalLink,
  type LocalArgs,
  type LocalCard,
  type LocalChatState,
  type LocalChatSummary,
  type LocalCommand,
  type LocalEnvelope,
  type LocalErrorCode,
  type LocalLink,
  type LocalFollowEvent,
  type LocalModeLevel,
  type LocalRepoSummary,
  type LocalTurnSummary,
  type LocalWorkspaceSummary,
} from "@zeros/protocol/local-orchestration";
import type { ChatRow } from "../db/chats";
import {
  claimLocalRequest,
  claimLocalNotification,
  settleLocalNotification,
  clearHumanStop,
  localCardAnswersFor,
  recordLocalCardAnswer,
  deleteLocalFollows,
  deleteLocalTurnFollow,
  forgetLocalChat,
  getLocalLink,
  getLocalRequest,
  insertLocalLink,
  insertLocalNotification,
  insertLocalShare,
  isHumanStopped,
  lastAcceptedTurn,
  localFollowersOf,
  localMessageOrigin,
  localPayloadHash,
  localRequestForTurn,
  localRootOf,
  pendingLocalNotifications,
  recordFamilyWorkspace,
  recordHumanStop,
  recordLocalMessageOrigin,
  retireLocalNotifications,
  setLocalNotificationState,
  updateLocalRequest,
  upsertLocalFollow,
  type LocalNotificationRow,
} from "../db/local-orchestration";
import { listTurnsForChat } from "../db/turns";
import { assertAnswerAllowed, cardKind, parseCardId, projectCard } from "./cards";
import { FOLDER_WORKSPACE_PREFIX, isWithinPath, LocalOwnerIndex, requireLocalOwner } from "./owners";
import { chatModeOf, modelChoicesFor, resolveChildSettings } from "./spawn-settings";
import { parseCursor, readTranscript } from "./transcript";
import {
  LOCAL_NOTE_PREFIX,
  type LocalCallerScope,
  type LocalMessagePresentation,
  type LocalOrchestrationPorts,
  type LocalPendingCardRecord,
  type LocalStartTurnOutcome,
  type LocalSteerOutcome,
  type LocalWorkspaceOwner,
} from "./types";
import { chatVisibleAs, computeVisibility, workspaceVisibleAs, type LocalVisibility } from "./visibility";

const PROVISIONING_STATES = new Set(["accepted", "provisioning", "ready", "dispatching"]);
const CURSOR_TOOL_WAIT_MAX_MS = 50_000;
const WAIT_RECHECK_MS = 1_000;

/** Same shape as the renderer's local chat ids (state/chat-id.ts). */
export function newLocalChatId(now = Date.now()): string {
  return `chat-${now.toString(36)}-${randomBytes(4).toString("hex")}`;
}

function newTurnId(): string {
  return `user-${randomUUID()}`;
}

interface CallContext {
  scope: LocalCallerScope;
  caller: ChatRow;
  index: LocalOwnerIndex;
  owner: LocalWorkspaceOwner;
  visibility: LocalVisibility;
  callerLevel: LocalModeLevel | null;
}

export interface LocalOrchestrationServiceOptions {
  skillFile?: () => string | null;
  /** Agent ids the registry can start (claude, codex, cursor, …). */
  isKnownAgent?: (agentId: string) => boolean;
}

export class LocalOrchestrationService {
  private readonly events = new EventEmitter();
  /** Notification rows being delivered right now. */
  private readonly delivering = new Set<string>();
  /** Turns started only to deliver a Zeros note: their end never notifies. */
  private readonly noteTurns = new Set<string>();

  constructor(
    private readonly ports: LocalOrchestrationPorts,
    private readonly options: LocalOrchestrationServiceOptions = {},
  ) {
    this.events.setMaxListeners(0);
  }

  private meta() {
    return { engine: this.ports.engineId() };
  }

  /** Validate and run one call. Never throws. */
  async call(scope: LocalCallerScope, raw: unknown, signal?: AbortSignal): Promise<LocalEnvelope> {
    const parsed = parseLocalCall(raw);
    if (!parsed.ok) return { ok: false, protocol: LOCAL_ORCHESTRATION_PROTOCOL, error: parsed.error, meta: this.meta() };
    try {
      const result = await this.run(scope, parsed.command, parsed.args, parsed.requestId, signal);
      return localOk(result, this.meta());
    } catch (error) {
      if (error instanceof LocalOrchestrationError) {
        return localFail(error.code, error.message, { ...error.options, meta: this.meta() });
      }
      return localFail("INTERNAL", error instanceof Error ? error.message : "Zeros could not complete the command.", {
        meta: this.meta(),
      });
    }
  }

  private context(scope: LocalCallerScope): CallContext {
    if (!this.ports.featureOpen()) {
      throw new LocalOrchestrationError("UNAVAILABLE", agentControlUnavailableReason("localOrchestration"));
    }
    const caller = this.ports.getChat(scope.chatId);
    if (!caller) throw new LocalOrchestrationError("NO_CAPABILITY", "This agent's chat no longer exists.");
    const index = new LocalOwnerIndex(this.ports);
    const owner = requireLocalOwner(index, caller.folder);
    const visibility = computeVisibility(scope.chatId, index, (id) => this.ports.getChat(id));
    const live = this.ports.liveChat(scope.chatId);
    const callerLevel = chatModeOf(caller, live.modeId).level;
    return { scope, caller, index, owner, visibility, callerLevel };
  }

  private async run(
    scope: LocalCallerScope,
    command: LocalCommand,
    args: Record<string, unknown>,
    requestId: string | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ctx = this.context(scope);
    if (LOCAL_MUTATING_COMMANDS.has(command)) {
      if (command === "card.answer") this.assertActiveTurn(ctx);
      else this.assertCanMutate(ctx);
    }
    switch (command) {
      case "whoami":
        return this.whoami(ctx);
      case "models":
        return await this.models(args as LocalArgs<"models">);
      case "repo.list":
        return this.repoList(ctx);
      case "workspace.list":
        return this.workspaceList(ctx, args as LocalArgs<"workspace.list">);
      case "workspace.status":
        return this.workspaceStatus(ctx, args as LocalArgs<"workspace.status">);
      case "workspace.create":
        return this.withReceipt(ctx, command, args, requestId, (rid) =>
          this.workspaceCreate(ctx, args as LocalArgs<"workspace.create">, rid),
        );
      case "chat.list":
        return this.chatList(ctx, args as LocalArgs<"chat.list">);
      case "chat.create":
        return this.withReceipt(ctx, command, args, requestId, (rid) =>
          this.chatCreate(ctx, args as LocalArgs<"chat.create">, rid),
        );
      case "chat.status":
        return this.chatStatus(ctx, args as LocalArgs<"chat.status">);
      case "chat.wait":
        return this.chatWait(ctx, args as LocalArgs<"chat.wait">, signal);
      case "chat.messages":
        return this.chatMessages(ctx, args as LocalArgs<"chat.messages">);
      case "chat.cancel":
        return this.chatCancel(ctx, args as LocalArgs<"chat.cancel">);
      case "chat.follow":
        return this.chatFollow(ctx, args as LocalArgs<"chat.follow">);
      case "chat.unfollow":
        return this.chatUnfollow(ctx, args as LocalArgs<"chat.unfollow">);
      case "message.send":
        return this.withReceipt(ctx, command, args, requestId, (rid) =>
          this.messageSend(ctx, args as LocalArgs<"message.send">, rid),
        );
      case "card.list":
        return this.cardList(ctx, args as LocalArgs<"card.list">);
      case "card.answer":
        return this.cardAnswer(ctx, args as LocalArgs<"card.answer">);
      case "link":
        return this.link(ctx, args as LocalArgs<"link">);
    }
  }

  private assertCanMutate(ctx: CallContext): void {
    if (ctx.callerLevel === "plan") {
      throw new LocalOrchestrationError(
        "MODE_FORBIDS",
        "Agents in Plan (read-only) mode can read chats and answer questions, but not start or message agents.",
      );
    }
    this.assertActiveTurn(ctx);
  }

  /** Effects come only from the caller's own running turn — never from a
   * background process left behind after the turn ended or was stopped. */
  private assertActiveTurn(ctx: CallContext): void {
    const live = this.ports.liveChat(ctx.scope.chatId);
    if (!live.activeTurn || live.activeTurn.cancelled || live.executionId !== ctx.scope.executionId) {
      throw new LocalOrchestrationError(
        "NO_CAPABILITY",
        "Start, message and answer other chats only while your own turn is running.",
      );
    }
  }

  /** Replay a receipt for the same request id, refuse a reused id with other
   * content, or run the effect once. */
  private async withReceipt<T>(
    ctx: CallContext,
    command: LocalCommand,
    args: Record<string, unknown>,
    requestId: string | undefined,
    run: (requestId: string) => Promise<T>,
  ): Promise<T> {
    if (!LOCAL_REQUEST_ID_COMMANDS.has(command)) return run(requestId ?? `auto-${randomUUID()}`);
    const rid = requestId ?? `auto-${randomUUID()}`;
    const claim = claimLocalRequest({
      requesterChatId: ctx.scope.chatId,
      requestId: rid,
      command,
      payloadHash: localPayloadHash(command, args),
    });
    if ("conflict" in claim) {
      throw new LocalOrchestrationError("REQUEST_CONFLICT", `Request id "${rid}" was already used for different content.`);
    }
    if (!claim.fresh) {
      const existing = claim.existing;
      // A result can hold the tab's metadata before its first turn starts.
      // The durable outcome, not the presence of that metadata, decides replay.
      const failure = existing.error as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown; reason?: unknown } | null;
      if (existing.state === "unknown") {
        throw new LocalOrchestrationError("OUTCOME_UNKNOWN", typeof failure?.message === "string" ? failure.message : "This request may already have run. Check the chat before sending new work.", {
          details: { requestId: rid, chatId: existing.targetChatId, replayed: true },
        });
      }
      // A refused request answers its retry with the same failure.
      if (existing.state === "refused") {
        const code = typeof failure?.code === "string" && (LOCAL_ERROR_CODES as readonly string[]).includes(failure.code)
          ? failure.code as LocalErrorCode
          : failure?.reason === "busy" ? "BUSY" : "UNAVAILABLE";
        throw new LocalOrchestrationError(code, typeof failure?.message === "string" ? failure.message : `Request "${rid}" was refused.`, {
          retryable: typeof failure?.retryable === "boolean" ? failure.retryable : failure?.reason === "busy",
          details: {
            ...(failure?.details && typeof failure.details === "object" && !Array.isArray(failure.details) ? failure.details : {}),
            requestId: rid,
            replayed: true,
          },
        });
      }
      if (existing.result != null && existing.state !== "interrupted") {
        return { ...(existing.result as object), replayed: true, requestState: existing.state } as T;
      }
      throw new LocalOrchestrationError("STALE", `Request "${rid}" is ${existing.state}.`, {
        retryable: PROVISIONING_STATES.has(existing.state),
        details: { requestId: rid, state: existing.state, chatId: existing.targetChatId },
      });
    }
    try {
      return await run(rid);
    } catch (error) {
      const current = getLocalRequest(ctx.scope.chatId, rid);
      if (current && (current.state === "accepted" || current.state === "provisioning")) {
        updateLocalRequest(ctx.scope.chatId, rid, {
          state: "refused",
          error: error instanceof LocalOrchestrationError ? { code: error.code, message: error.message, ...error.options } : { code: "INTERNAL" },
        });
      }
      throw error;
    }
  }

  // ── Summaries ──────────────────────────────────────────

  private chatLink(chatId: string): string {
    return formatLocalLink(this.ports.linkScheme(), "chat", chatId);
  }

  private workspaceLink(workspaceId: string): string {
    return formatLocalLink(this.ports.linkScheme(), "workspace", workspaceId);
  }

  private lastTurn(chatId: string): LocalTurnSummary | null {
    const turn = listTurnsForChat(chatId).at(-1);
    return turn
      ? { turnId: turn.turnId, status: turn.status, startedAt: turn.startedAt, endedAt: turn.endedAt, stopReason: turn.stopReason }
      : null;
  }

  private cardsFor(chatId: string): LocalPendingCardRecord[] {
    return this.ports.pendingCards().filter((c) => c.chatId === chatId);
  }

  private chatState(chat: ChatRow, requesterChatId: string | null): LocalChatState {
    if (chat.archived) return "archived";
    const live = this.ports.liveChat(chat.id);
    if (live.activeTurn && !live.activeTurn.cancelled) {
      return this.cardsFor(chat.id).some((c) => c.type === "permission" || c.question?.blocking !== false)
        ? "needs_answer"
        : "working";
    }
    if (requesterChatId) {
      const pending = this.pendingRequestFor(requesterChatId, chat.id);
      if (pending === "setup_failed") return "setup_failed";
      if (pending) return "provisioning";
    }
    return "idle";
  }

  /** A receipt that still owes this chat its first turn. */
  private pendingRequestFor(requesterChatId: string, chatId: string): string | null {
    const link = getLocalLink(chatId);
    if (!link?.createdRequestId) return null;
    const request = getLocalRequest(link.parentChatId, link.createdRequestId);
    if (!request) return null;
    if (request.state === "setup_failed") return "setup_failed";
    return PROVISIONING_STATES.has(request.state) ? request.state : null;
  }

  private summarizeChat(ctx: CallContext, chat: ChatRow, visibleAs: LocalChatSummary["visibleAs"]): LocalChatSummary {
    const owner = ctx.index.ownerOfFolder(chat.folder);
    const live = this.ports.liveChat(chat.id);
    const mode = chatModeOf(chat, live.modeId);
    const link = getLocalLink(chat.id);
    const workspaceId = owner && owner !== "foreign" ? owner.id : null;
    return {
      chatId: chat.id,
      link: this.chatLink(chat.id),
      title: chat.title || "Untitled",
      workspaceId,
      workspaceLink: workspaceId ? this.workspaceLink(workspaceId) : null,
      folder: chat.folder,
      agent: chat.agentId,
      model: chat.model,
      effort: chat.effort || null,
      fast: chat.fast === true,
      mode: mode.modeId,
      modeLevel: mode.level,
      state: this.chatState(chat, ctx.scope.chatId),
      lastTurn: this.lastTurn(chat.id),
      createdBy: link?.parentChatId ?? null,
      visibleAs,
      pendingCards: this.cardsFor(chat.id).length,
    };
  }

  private summarizeWorkspace(owner: LocalWorkspaceOwner, visibleAs: LocalWorkspaceSummary["visibleAs"]): LocalWorkspaceSummary {
    const state: LocalWorkspaceSummary["state"] = owner.archived
      ? "archived"
      : !owner.present
        ? "missing"
        : owner.setupState === "running"
          ? "setting_up"
          : owner.setupState === "failed" || owner.setupState === "stopped"
            ? "setup_failed"
            : "ready";
    return {
      workspaceId: owner.id,
      link: this.workspaceLink(owner.id),
      name: owner.name,
      repoRoot: owner.repoRoot,
      path: owner.path,
      branch: owner.branch,
      kind: owner.kind === "worktree" ? "worktree" : owner.path === owner.repoRoot && owner.projectId ? "main" : "folder",
      state,
      visibleAs,
    };
  }

  /** A link of this copy of Zeros. A link from another channel (a Beta link
   * pasted into Alpha) names a chat in a different database. */
  private ownLink(ref: string): LocalLink | null {
    const link = parseLocalLink(ref);
    if (link && link.scheme !== this.ports.linkScheme()) {
      throw new LocalOrchestrationError(
        "NOT_FOUND",
        `That link belongs to another copy of Zeros (${link.scheme}://); this one uses ${this.ports.linkScheme()}://.`,
      );
    }
    return link;
  }

  /** Resolve a chat id or link the caller can see. */
  private visibleChat(ctx: CallContext, ref: string): { chat: ChatRow; visibleAs: LocalChatSummary["visibleAs"] } {
    const link = this.ownLink(ref);
    if (link && link.kind !== "chat") throw new LocalOrchestrationError("USAGE", "That is a workspace link, not a chat link.");
    const chatId = link ? link.id : ref;
    const chat = this.ports.getChat(chatId);
    const notFound = () =>
      new LocalOrchestrationError(
        "NOT_FOUND",
        `Chat "${chatId}" was not found or is not visible to you. A chat outside your family is shared when the user writes its link in your chat; ask them to paste it rather than searching for it.`,
      );
    if (!chat || this.ports.wasChatDeleted(chatId)) throw notFound();
    const owner = ctx.index.ownerOfFolder(chat.folder);
    if (owner === "foreign") throw notFound();
    const visibleAs = chatVisibleAs(ctx.visibility, chat.id, owner);
    if (!visibleAs) throw notFound();
    // A terminal tab runs a CLI in a PTY; it has no conversation to drive.
    if (chat.kind === "terminal") throw new LocalOrchestrationError("USAGE", "That tab is a terminal, not an agent chat.");
    return { chat, visibleAs };
  }

  private visibleWorkspace(ctx: CallContext, ref: string): { owner: LocalWorkspaceOwner; visibleAs: LocalWorkspaceSummary["visibleAs"] } {
    const link = this.ownLink(ref);
    if (link && link.kind !== "workspace") throw new LocalOrchestrationError("USAGE", "That is a chat link, not a workspace link.");
    const id = link ? link.id : ref === "current" ? ctx.owner.id : ref;
    const owner = ctx.index.ownerById(id);
    const notFound = () =>
      new LocalOrchestrationError(
        "NOT_FOUND",
        `Workspace "${id}" was not found or is not visible to you. A workspace outside your family is shared when the user writes its link in your chat; ask them to paste it rather than searching for it.`,
      );
    if (!owner || owner === "foreign") throw notFound();
    const visibleAs = workspaceVisibleAs(ctx.visibility, owner.id, ctx.owner.id);
    if (!visibleAs) throw notFound();
    return { owner, visibleAs };
  }

  // ── Reads ──────────────────────────────────────────────

  private whoami(ctx: CallContext) {
    const link = getLocalLink(ctx.scope.chatId);
    return {
      chat: this.summarizeChat(ctx, ctx.caller, "self"),
      workspace: this.summarizeWorkspace(ctx.owner, "self"),
      parentChatId: link?.parentChatId ?? null,
      parentLink: link ? this.chatLink(link.parentChatId) : null,
      rootChatId: ctx.visibility.rootChatId,
      protocol: LOCAL_ORCHESTRATION_PROTOCOL,
      skill: this.options.skillFile?.() ?? null,
      canMutate: ctx.callerLevel !== "plan",
    };
  }

  private async models(args: LocalArgs<"models">) {
    const agents = (args.agent ? [args.agent] : ["claude", "codex", "cursor"]).filter(
      (agent) => !this.options.isKnownAgent || this.options.isKnownAgent(agent),
    );
    // The current catalog: a model the account refused since the first read
    // must show as unavailable before an agent picks it.
    const catalogs = await Promise.all(agents.map((agent) => this.ports.currentInitialize(agent)));
    const rows = agents.flatMap((agent, index) => {
      const signedIn = this.ports.agentConnection(agent).connected;
      return modelChoicesFor(agent, catalogs[index] ?? null).map((row) => ({ ...row, signedIn }));
    });
    if (args.agent && rows.length === 0) {
      throw new LocalOrchestrationError("NOT_FOUND", `No models are known for agent "${args.agent}".`);
    }
    return { models: rows };
  }

  private repoList(ctx: CallContext): { repos: LocalRepoSummary[] } {
    return {
      repos: ctx.index.projectsList().map((p) => ({
        repoId: p.id,
        name: p.name,
        repoRoot: p.repoRoot,
        originUrl: p.originUrl,
      })),
    };
  }

  private workspaceList(ctx: CallContext, args: LocalArgs<"workspace.list">) {
    const ids = new Set<string>([ctx.owner.id, ...ctx.visibility.workspaceIds]);
    const repoFilter = args.repo ? this.resolveRepoRoot(ctx, args.repo) : null;
    const out: LocalWorkspaceSummary[] = [];
    for (const id of ids) {
      const owner = ctx.index.ownerById(id);
      if (!owner || owner === "foreign") continue;
      if (repoFilter && path.resolve(owner.repoRoot) !== path.resolve(repoFilter)) continue;
      const visibleAs = workspaceVisibleAs(ctx.visibility, owner.id, ctx.owner.id);
      if (visibleAs) out.push(this.summarizeWorkspace(owner, visibleAs));
    }
    return { workspaces: out };
  }

  private workspaceStatus(ctx: CallContext, args: LocalArgs<"workspace.status">) {
    const { owner, visibleAs } = this.visibleWorkspace(ctx, args.workspace);
    return { workspace: this.summarizeWorkspace(owner, visibleAs) };
  }

  private chatList(ctx: CallContext, args: LocalArgs<"chat.list">) {
    const filter = args.workspace ? this.visibleWorkspace(ctx, args.workspace).owner.id : null;
    const out: LocalChatSummary[] = [];
    for (const chat of this.ports.listChats()) {
      if (chat.archived && !ctx.visibility.family.has(chat.id)) continue;
      if (chat.kind === "terminal") continue;
      const owner = ctx.index.ownerOfFolder(chat.folder);
      if (owner === "foreign") continue;
      if (filter && (!owner || owner.id !== filter)) continue;
      const visibleAs = chatVisibleAs(ctx.visibility, chat.id, owner);
      if (visibleAs) out.push(this.summarizeChat(ctx, chat, visibleAs));
    }
    out.sort((a, b) => (a.chatId === ctx.scope.chatId ? -1 : b.chatId === ctx.scope.chatId ? 1 : 0));
    if (!args.tree) return { chats: out };
    const children = new Map<string, string[]>();
    for (const chat of out) {
      if (!chat.createdBy) continue;
      children.set(chat.createdBy, [...(children.get(chat.createdBy) ?? []), chat.chatId]);
    }
    return { chats: out, tree: { root: ctx.visibility.rootChatId, children: Object.fromEntries(children) } };
  }

  private chatStatus(ctx: CallContext, args: LocalArgs<"chat.status">) {
    const { chat, visibleAs } = this.visibleChat(ctx, args.chat);
    return {
      chat: this.summarizeChat(ctx, chat, visibleAs),
      cards: this.cardsFor(chat.id).map((c) => projectCard(c, this.chatLink(chat.id))),
      // Cards other agents answered in this chat, newest first.
      answeredCards: localCardAnswersFor(chat.id).map((a) => ({
        cardId: a.cardId,
        kind: a.kind,
        answer: a.answer,
        answeredBy: this.chatLink(a.answeredByChatId),
        answeredAt: a.answeredAt,
      })),
    };
  }

  /** Engine-derived answerer for settle events: the calling chat itself. */
  private answeredBy(ctx: CallContext): CardAnsweredBy {
    return {
      kind: "agent",
      chatId: ctx.scope.chatId,
      title: (ctx.caller.title || "Untitled").slice(0, 200),
      link: this.chatLink(ctx.scope.chatId),
    };
  }

  private chatMessages(ctx: CallContext, args: LocalArgs<"chat.messages">) {
    const { chat } = this.visibleChat(ctx, args.chat);
    const page = readTranscript(chat.id, {
      view: args.view ?? "full",
      afterOrd: parseCursor(args.after),
      limit: args.limit ?? 50,
      includeTools: args.includeTools === true,
      turnId: args.turn,
      linkForChat: (id) => this.chatLink(id),
    });
    return {
      chatId: chat.id,
      link: this.chatLink(chat.id),
      view: args.view ?? "full",
      untrusted: chat.id !== ctx.scope.chatId,
      ...page,
    };
  }

  private link(ctx: CallContext, args: LocalArgs<"link">) {
    const parsed = this.ownLink(args.target);
    if (parsed?.kind === "workspace" || args.target === "current" || args.target.startsWith("ws_") || args.target.startsWith(FOLDER_WORKSPACE_PREFIX)) {
      const { owner } = this.visibleWorkspace(ctx, args.target);
      return { kind: "workspace", id: owner.id, link: this.workspaceLink(owner.id) };
    }
    const { chat } = this.visibleChat(ctx, args.target);
    return { kind: "chat", id: chat.id, link: this.chatLink(chat.id) };
  }

  // ── Waiting ────────────────────────────────────────────

  private targetCondition(ctx: CallContext, chatId: string, turnId: string | null) {
    const chat = this.ports.getChat(chatId);
    if (!chat) return { done: true, attention: false, reason: "deleted" as const, turn: null };
    const pending = this.pendingRequestFor(ctx.scope.chatId, chatId);
    const live = this.ports.liveChat(chatId);
    const cards = this.cardsFor(chatId);
    const attention = cards.length > 0;
    const turns = listTurnsForChat(chatId);
    const turn = turnId ? turns.find((t) => t.turnId === turnId) ?? null : turns.at(-1) ?? null;
    if (pending === "setup_failed") return { done: true, attention: false, reason: "setup_failed" as const, turn: null };
    if (pending) return { done: false, attention, reason: "provisioning" as const, turn: null };
    if (turnId && !turn) {
      // The turn row appears just after acceptance; until then the live turn
      // and the receipt say where the turn is.
      if (live.activeTurn && !live.activeTurn.cancelled && live.activeTurn.turnId === turnId) {
        return { done: false, attention, reason: "running" as const, turn: null };
      }
      const request = localRequestForTurn(ctx.scope.chatId, chatId, turnId);
      if (request && (request.state === "interrupted" || request.state === "unknown" || request.state === "refused")) {
        return { done: true, attention: false, reason: request.state as "interrupted" | "unknown" | "refused", turn: null };
      }
      if (request && PROVISIONING_STATES.has(request.state)) {
        return { done: false, attention, reason: "starting" as const, turn: null };
      }
      // Accepted and no longer running without a recorded row, or a turn id
      // this chat never started: nothing more will happen to wait for.
      return { done: true, attention, reason: request ? ("terminal" as const) : ("unknown_turn" as const), turn: null };
    }
    const running =
      (live.activeTurn && !live.activeTurn.cancelled && (!turnId || live.activeTurn.turnId === turnId)) ||
      turn?.status === "running";
    return {
      done: !running,
      attention,
      reason: running ? ("running" as const) : ("terminal" as const),
      turn,
    };
  }

  private async chatWait(ctx: CallContext, args: LocalArgs<"chat.wait">, signal?: AbortSignal) {
    if (args.targets.length > 1 && args.targets.some((t) => t.turn)) {
      throw new LocalOrchestrationError("USAGE", "--turn can be used only when waiting for one chat.");
    }
    const until = args.until ?? "attention";
    // Cursor's MCP client has no configurable per-call deadline, so its tool
    // waits stay well under a minute; the other tools get the full cap.
    const cap = ctx.scope.surface !== "tool"
      ? LOCAL_WAIT_MAX_CLI_MS
      : localAgentFamily(ctx.scope.agentId) === "cursor" ? CURSOR_TOOL_WAIT_MAX_MS : LOCAL_WAIT_MAX_TOOL_MS;
    const timeoutMs = Math.min(args.timeoutMs ?? LOCAL_WAIT_DEFAULT_MS, cap);
    const targets = args.targets.map((t) => {
      const { chat } = this.visibleChat(ctx, t.chat);
      if (chat.id === ctx.scope.chatId) {
        throw new LocalOrchestrationError("USAGE", "A chat cannot wait for itself.");
      }
      return { chatId: chat.id, turnId: t.turn ?? lastAcceptedTurn(ctx.scope.chatId, chat.id) };
    });
    // Authority is rechecked on every evaluation and before any result: a
    // chat that moved out of view, an owner change or a closed gate while
    // waiting ends the wait with the normal typed error, never its content.
    const revalidate = (): CallContext => {
      const fresh = this.context(ctx.scope);
      for (const t of targets) this.visibleChat(fresh, t.chatId);
      return fresh;
    };
    const evaluate = (c: CallContext) =>
      targets.map((t) => {
        const condition = this.targetCondition(c, t.chatId, t.turnId);
        const met = until === "done" ? condition.done : condition.done || condition.attention;
        return { ...t, ...condition, met };
      });
    const finish = (c: CallContext, states: ReturnType<typeof evaluate>, timedOut: boolean) => ({
      reason: timedOut ? "timeout" : states.some((s) => s.met && s.attention && !s.done) ? "attention" : "terminal",
      timedOut,
      results: states.map((s) => {
        const chat = this.ports.getChat(s.chatId);
        return {
          chatId: s.chatId,
          link: this.chatLink(s.chatId),
          turnId: s.turnId,
          met: s.met,
          condition: s.reason,
          state: chat ? this.chatState(chat, c.scope.chatId) : "archived",
          turn: s.turn
            ? { turnId: s.turn.turnId, status: s.turn.status, startedAt: s.turn.startedAt, endedAt: s.turn.endedAt, stopReason: s.turn.stopReason }
            : null,
          cards: this.cardsFor(s.chatId).map((card) => projectCard(card, this.chatLink(s.chatId))),
          final:
            s.done && s.turn
              ? (readTranscript(s.chatId, { view: "last", afterOrd: 0, limit: 1, includeTools: false, turnId: s.turn.turnId, linkForChat: (id) => this.chatLink(id) }).messages[0] ?? null)
              : null,
        };
      }),
    });
    const satisfied = (states: ReturnType<typeof evaluate>) =>
      args.any ? states.some((s) => s.met) : states.every((s) => s.met);

    // Subscribe before the first read so a change in between is never missed.
    return await new Promise<ReturnType<typeof finish>>((resolve, reject) => {
      const watched = new Set(targets.map((t) => t.chatId));
      let settled = false;
      const stop = () => {
        settled = true;
        this.events.off("changed", onChange);
        clearInterval(recheck);
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
      };
      const done = (timedOut: boolean) => {
        if (settled) return;
        stop();
        try {
          const fresh = revalidate();
          resolve(finish(fresh, evaluate(fresh), timedOut));
        } catch (error) {
          reject(error);
        }
      };
      const check = () => {
        if (settled) return;
        try {
          const fresh = revalidate();
          if (satisfied(evaluate(fresh))) done(false);
        } catch (error) {
          stop();
          reject(error);
        }
      };
      const onChange = (chatId: string) => {
        if (watched.has(chatId)) check();
      };
      const onAbort = () => done(true);
      this.events.on("changed", onChange);
      const recheck = setInterval(check, WAIT_RECHECK_MS);
      recheck.unref?.();
      const deadline = setTimeout(() => done(true), timeoutMs);
      deadline.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  // ── Mutations ──────────────────────────────────────────

  private resolveRepoRoot(ctx: CallContext, repo: string): string {
    if (repo === "current") return ctx.owner.repoRoot;
    const link = this.ownLink(repo);
    if (link?.kind === "workspace") return this.visibleWorkspace(ctx, repo).owner.repoRoot;
    if (link) throw new LocalOrchestrationError("USAGE", "--repo takes a repository path, a workspace link or `current`.");
    const byId = ctx.index.projectsList().find((p) => p.id === repo);
    if (byId) return byId.repoRoot;
    if (!path.isAbsolute(repo)) {
      throw new LocalOrchestrationError("USAGE", "--repo must be an absolute path, a repo id, a workspace link or `current`.");
    }
    // Same folder, lexically or through a symlink; always the registered spelling.
    const project = ctx.index.projectsList().find((p) => isWithinPath(repo, p.repoRoot) && isWithinPath(p.repoRoot, repo));
    if (!project) {
      throw new LocalOrchestrationError("NOT_FOUND", "That repository is not added to Zeros. Add it in Zeros first.");
    }
    return project.repoRoot;
  }

  private assertNotStopped(chatId: string): void {
    if (isHumanStopped(chatId)) {
      throw new LocalOrchestrationError(
        "STOPPED_BY_USER",
        "The user stopped that chat. Agents cannot restart it until the user sends a message there.",
      );
    }
  }

  private settingsFor(ctx: CallContext, parent: ChatRow, requested: LocalArgs<"chat.create">, sameFolder: boolean) {
    const live = this.ports.liveChat(parent.id);
    return resolveChildSettings({
      parent,
      parentLiveModeId: live.modeId,
      requested: {
        ...(requested.agent ? { agent: requested.agent } : {}),
        ...(requested.model ? { model: requested.model } : {}),
        ...(requested.effort ? { effort: requested.effort } : {}),
        ...(requested.fast !== undefined ? { fast: requested.fast } : {}),
        ...(requested.mode ? { mode: requested.mode } : {}),
      },
      sameFolder,
      initialize: (agentId) => this.ports.initializeSnapshot(agentId),
      isKnownAgent: (agentId) => (this.options.isKnownAgent ? this.options.isKnownAgent(agentId) : true),
      userSettings: this.ports.userSettings(parent.folder),
    });
  }

  private async chatCreate(ctx: CallContext, args: LocalArgs<"chat.create">, requestId: string) {
    const target = args.workspace ? this.visibleWorkspace(ctx, args.workspace).owner : ctx.owner;
    if (target.archived) throw new LocalOrchestrationError("NOT_READY", "That workspace is archived.");
    if (!target.present) throw new LocalOrchestrationError("NOT_READY", "That workspace's folder is missing on this Mac.");
    const folder = target.id === ctx.owner.id ? ctx.caller.folder : target.path;
    return this.createChatIn(ctx, {
      settings: args,
      message: args.message,
      folder,
      workspaceId: target.kind === "worktree" ? target.id : undefined,
      owner: target,
      requestId,
      readiness: null,
    });
  }

  private async createChatIn(
    ctx: CallContext,
    input: {
      settings: LocalArgs<"chat.create">;
      message: string | undefined;
      folder: string;
      workspaceId: string | undefined;
      owner: LocalWorkspaceOwner;
      requestId: string;
      /** Wait for this before dispatching the first turn (new workspaces). */
      readiness: Promise<"ready" | "setup_failed" | "missing"> | null;
    },
  ) {
    const resolved = this.settingsFor(ctx, ctx.caller, input.settings, input.folder === ctx.caller.folder);
    // An agent that cannot connect never gets a tab.
    this.assertAgentConnected(resolved.agentId);
    const now = Date.now();
    const chatId = newLocalChatId(now);
    const turnId = input.message ? newTurnId() : null;
    // Without --title the chat starts as "New chat" and Zeros names it from
    // its first message once the agent answers, like a chat the user starts.
    const title = (input.settings.title ?? "New chat").slice(0, 200);
    const row: ChatRow = {
      id: chatId,
      folder: input.folder,
      agentId: resolved.agentId,
      agentName: this.ports.agentDisplayName(resolved.agentId),
      model: resolved.model,
      effort: resolved.effort,
      permissionMode: resolved.permissionMode,
      lastModeId: resolved.modeId,
      prePlanModeId: resolved.prePlanModeId,
      fast: resolved.fast,
      additionalDirectories: resolved.additionalDirectories,
      title,
      createdAt: now,
      updatedAt: now,
      sessionId: null,
      providerBinding: null,
      providerMetadata: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: null,
    };
    insertLocalLink({ chatId, parentChatId: ctx.scope.chatId, requestId: input.requestId, now });
    this.ports.upsertChat(row);
    // A tab is announced once its agent has started (or failed after
    // starting); one that never connects is removed unseen. A new
    // workspace's tab shows during setup, like one the user creates.
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      this.ports.chatsChanged([chatId]);
    };
    if (input.readiness || !turnId) announce();
    if (input.settings.notify && turnId) {
      upsertLocalFollow({ followerChatId: ctx.scope.chatId, targetChatId: chatId, events: ["done", "question", "permission"], turnId });
    }
    const base = {
      chatId,
      link: this.chatLink(chatId),
      title,
      workspaceId: input.owner.id,
      workspaceLink: this.workspaceLink(input.owner.id),
      folder: input.folder,
      agent: resolved.agentId,
      model: resolved.model,
      effort: resolved.effort,
      fast: resolved.fast,
      mode: resolved.modeId,
      modeLevel: resolved.level,
      turnId,
      requestId: input.requestId,
    };
    if (!turnId || !input.message) {
      updateLocalRequest(ctx.scope.chatId, input.requestId, { state: "settled", targetChatId: chatId, result: { ...base, state: "idle" } });
      return { ...base, state: "idle" };
    }
    recordLocalMessageOrigin({ chatId, messageId: turnId, kind: "agent", senderChatId: ctx.scope.chatId });
    this.grantFromAgentMessage(ctx.scope.chatId, chatId, input.message);
    updateLocalRequest(ctx.scope.chatId, input.requestId, {
      state: input.readiness ? "provisioning" : "accepted",
      targetChatId: chatId,
      turnId,
      result: { ...base, state: input.readiness ? "provisioning" : "starting" },
    });
    const dispatch = async () => {
      if (input.readiness) {
        const ready = await input.readiness;
        if (ready !== "ready") {
          updateLocalRequest(ctx.scope.chatId, input.requestId, {
            state: ready === "setup_failed" ? "setup_failed" : "interrupted",
            result: { ...base, state: ready === "setup_failed" ? "setup_failed" : "idle" },
          });
          this.changed(chatId);
          return;
        }
        // The user may have stopped the new tab while its workspace was set up.
        if (isHumanStopped(chatId)) {
          updateLocalRequest(ctx.scope.chatId, input.requestId, {
            state: "refused",
            result: { ...base, state: "idle" },
            error: { code: "STOPPED_BY_USER", message: "The user stopped that chat before its first message was sent." },
          });
          this.changed(chatId);
          return;
        }
      }
      updateLocalRequest(ctx.scope.chatId, input.requestId, { state: "dispatching" });
      const outcome = await this.ports.startTurn({
        chatId,
        agentId: resolved.agentId,
        folder: input.folder,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        env: resolved.env,
        text: this.fromAgent(ctx.scope.chatId, input.message!),
        turnId,
        presentation: this.fromAgentPresentation(ctx.scope.chatId, input.message!),
      });
      if (outcome.kind === "accepted") {
        updateLocalRequest(ctx.scope.chatId, input.requestId, { state: "dispatched", result: { ...base, state: "working" } });
        announce();
      } else if (outcome.kind === "failed" && neverConnected(outcome)) {
        // The agent never started (signed out, not installed, could not
        // launch): remove the tab instead of leaving an empty one behind.
        await this.ports.removeChat(chatId);
        forgetLocalChat(chatId);
        const authRequired = outcome.failureKind === "auth-required" || outcome.failureKind === "verification-required";
        // No result: a retry answers with this failure, never a removed tab.
        updateLocalRequest(ctx.scope.chatId, input.requestId, {
          state: "refused",
          targetChatId: null,
          result: null,
          error: { code: authRequired ? "AUTH_REQUIRED" : "UNAVAILABLE", message: outcome.message, removed: true },
        });
      } else {
        updateLocalRequest(ctx.scope.chatId, input.requestId, {
          state: outcome.kind === "failed" && outcome.code === "OUTCOME_UNKNOWN" ? "unknown" : "refused",
          result: { ...base, state: "idle" },
          error: outcome.kind === "failed" ? { code: outcome.code ?? "UNAVAILABLE", message: outcome.message } : { code: "BUSY", message: "busy" },
        });
        announce();
      }
      this.changed(chatId);
    };
    const dispatching = dispatch().catch(() => {
      updateLocalRequest(ctx.scope.chatId, input.requestId, { state: "unknown" });
      announce();
      this.changed(chatId);
    });
    if (input.readiness) return { ...base, state: "provisioning" };
    // A cold provider can take a while to start; the chat exists either way.
    if (!(await settlesWithin(dispatching, LOCAL_ACCEPT_WAIT_MS))) return { ...base, state: "starting" };
    const request = getLocalRequest(ctx.scope.chatId, input.requestId);
    if (request?.state === "refused" || request?.state === "unknown") {
      const error = request.error as { code?: string; message?: string; removed?: boolean } | null;
      const message = error?.message ?? "The agent could not start.";
      const refusedCode =
        error?.code && (LOCAL_ERROR_CODES as readonly string[]).includes(error.code)
          ? error.code as LocalErrorCode
          : "UNAVAILABLE";
      throw new LocalOrchestrationError(request.state === "unknown" ? "OUTCOME_UNKNOWN" : refusedCode, message, {
        // A removed tab has no link to hand out.
        ...(error?.removed ? {} : { details: { chatId, link: this.chatLink(chatId) } }),
      });
    }
    return { ...base, state: "working" };
  }

  /** Refuse before anything exists when the agent's selected account is
   * signed out or expired. */
  private assertAgentConnected(agentId: string): void {
    const connection = this.ports.agentConnection(agentId);
    if (!connection.connected) throw new LocalOrchestrationError("AUTH_REQUIRED", connection.message);
  }

  private async workspaceCreate(ctx: CallContext, args: LocalArgs<"workspace.create">, rid: string) {
    const repoRoot = this.resolveRepoRoot(ctx, args.repo);
    // In the caller's own repository a new workspace stacks on the caller's
    // committed work (its branch, or its commit when detached); another
    // repository starts from its default base like a user-created workspace.
    // `--base` overrides both and is resolved where the caller would read it.
    const sameRepo = path.resolve(repoRoot) === path.resolve(ctx.owner.repoRoot);
    const cwdForBase = sameRepo ? ctx.owner.path : repoRoot;
    let base: { ref: string; commit: string; cwd: string } | undefined;
    if (args.base) {
      const commit = await this.ports.resolveCommit(cwdForBase, args.base);
      if (!commit) throw new LocalOrchestrationError("USAGE", `Base "${args.base}" was not found in that repository.`);
      base = { ref: args.base, commit, cwd: cwdForBase };
    } else if (sameRepo) {
      const commit = await this.ports.resolveCommit(cwdForBase, "HEAD");
      if (commit) base = { ref: "HEAD", commit, cwd: cwdForBase };
    }
    if (args.chat?.message) {
      // Its first chat's agent must be able to connect before a worktree exists.
      this.assertAgentConnected(this.settingsFor(ctx, ctx.caller, { ...args.chat, message: args.chat.message }, false).agentId);
    }
    updateLocalRequest(ctx.scope.chatId, rid, { state: "provisioning" });
    const created = await this.ports.createWorkspace({
      repoRoot,
      ...(base ? { base } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.chat?.agent ? { agentId: args.chat.agent } : {}),
    });
    recordFamilyWorkspace({ rootChatId: localRootOf(ctx.scope.chatId), workspaceId: created.workspaceId, createdByChatId: ctx.scope.chatId });
    const workspace = {
      workspaceId: created.workspaceId,
      link: this.workspaceLink(created.workspaceId),
      path: created.path,
      branch: created.branch,
      repoRoot: created.repoRoot,
      baseBranch: created.baseBranch,
      baseCommit: base?.commit ?? null,
    };
    if (!args.chat?.message) {
      updateLocalRequest(ctx.scope.chatId, rid, { state: "settled", result: { workspace, chat: null, requestId: rid } });
      return { workspace, chat: null, requestId: rid };
    }
    const index = new LocalOwnerIndex(this.ports);
    const owner = index.ownerById(created.workspaceId);
    if (!owner || owner === "foreign") throw new LocalOrchestrationError("INTERNAL", "The new workspace could not be resolved.");
    const { message, ...chatSettings } = args.chat;
    // An internal step id no public request id can name ('#' is outside the
    // request-id alphabet), so a caller's own ids never collide with it.
    const chatRequestId = `${rid}#chat`;
    const childClaim = claimLocalRequest({
      requesterChatId: ctx.scope.chatId,
      requestId: chatRequestId,
      command: "chat.create",
      payloadHash: localPayloadHash("chat.create", args.chat),
    });
    if (!("fresh" in childClaim) || !childClaim.fresh) {
      throw new LocalOrchestrationError("STALE", "The new workspace's first chat was already started for this request.", {
        details: { requestId: rid },
      });
    }
    const chat = await this.createChatIn(
      { ...ctx, index },
      {
        settings: { ...chatSettings, message: message! },
        message,
        folder: created.path,
        workspaceId: created.workspaceId,
        owner,
        requestId: chatRequestId,
        readiness: this.ports.workspaceReadiness(created.workspaceId),
      },
    );
    // The first chat's step id is internal; callers retry with the outer id.
    const publicChat = { ...chat, requestId: rid };
    updateLocalRequest(ctx.scope.chatId, rid, { state: "settled", result: { workspace, chat: publicChat, requestId: rid } });
    return { workspace, chat: publicChat, requestId: rid };
  }

  private async messageSend(ctx: CallContext, args: LocalArgs<"message.send">, requestId: string) {
    const { chat } = this.visibleChat(ctx, args.chat);
    if (chat.id === ctx.scope.chatId) throw new LocalOrchestrationError("USAGE", "A chat cannot message itself.");
    if (chat.archived) throw new LocalOrchestrationError("NOT_READY", "That chat is archived.");
    this.assertNotStopped(chat.id);
    if (this.pendingRequestFor(ctx.scope.chatId, chat.id)) {
      throw new LocalOrchestrationError("NOT_READY", "That chat is still being set up. Wait for it, then send again.");
    }
    const delivery = args.delivery ?? "auto";
    const live = this.ports.liveChat(chat.id);
    const messageId = newTurnId();
    const result = (extra: Record<string, unknown>) => ({
      chatId: chat.id,
      link: this.chatLink(chat.id),
      messageId,
      requestId,
      ...extra,
    });
    if (live.activeTurn && !live.activeTurn.cancelled && live.executionId) {
      if (delivery === "new-turn") {
        throw new LocalOrchestrationError("BUSY", "That chat is working. Wait for it or send with --steer.", {
          retryable: true,
          details: { turnId: live.activeTurn.turnId },
        });
      }
      recordLocalMessageOrigin({ chatId: chat.id, messageId, kind: "agent", senderChatId: ctx.scope.chatId });
      this.grantFromAgentMessage(ctx.scope.chatId, chat.id, args.message);
      const turnId = live.activeTurn.turnId;
      updateLocalRequest(ctx.scope.chatId, requestId, { state: "dispatching", targetChatId: chat.id, turnId });
      const follow = () => {
        if (args.notify) {
          upsertLocalFollow({ followerChatId: ctx.scope.chatId, targetChatId: chat.id, events: ["done", "question", "permission"], turnId });
        }
      };
      // A provider confirms a steer only when the running turn consumes it,
      // which a tool or a card can hold for minutes. The receipt settles in
      // the background; the caller hears `pending` after the bound.
      const steering = this.ports
        .steer({
          chatId: chat.id,
          executionId: live.executionId,
          agentId: chat.agentId ?? live.agentId ?? "",
          text: this.fromAgent(ctx.scope.chatId, args.message),
          messageId,
          presentation: this.fromAgentPresentation(ctx.scope.chatId, args.message),
        })
        .then((steered): LocalSteerOutcome => {
          if (steered.kind === "not_delivered") {
            updateLocalRequest(ctx.scope.chatId, requestId, {
              state: "refused",
              error: {
                code: "BUSY",
                message: `The message could not be added to the running turn (${steered.reason}). Wait, then send again.`,
                retryable: true,
                details: { turnId, reason: steered.reason },
              },
            });
          } else {
            updateLocalRequest(ctx.scope.chatId, requestId, {
              state: steered.kind === "delivered" ? "dispatched" : "unknown",
              result: result({ delivery: steered.kind === "delivered" ? "delivered" : "unknown", turnId, steered: true }),
            });
            follow();
          }
          this.changed(chat.id);
          return steered;
        })
        .catch((): LocalSteerOutcome => {
          updateLocalRequest(ctx.scope.chatId, requestId, { state: "unknown" });
          follow();
          return { kind: "unknown", reason: "no confirmation" };
        });
      const steered = await withinOrNull(steering, LOCAL_ACCEPT_WAIT_MS);
      if (!steered) {
        follow();
        return result({ delivery: "pending", turnId, steered: true });
      }
      if (steered.kind === "not_delivered") {
        throw new LocalOrchestrationError("BUSY", `The message could not be added to the running turn (${steered.reason}). Wait, then send again.`, {
          retryable: true,
          details: { turnId, reason: steered.reason },
        });
      }
      return result({ delivery: steered.kind === "delivered" ? "delivered" : "unknown", turnId, steered: true });
    }
    if (delivery === "steer") {
      throw new LocalOrchestrationError("STALE", "That chat has no running turn to steer. Send without --steer to start one.");
    }
    const settings = this.settingsFor(ctx, chat, { message: args.message }, true);
    recordLocalMessageOrigin({ chatId: chat.id, messageId, kind: "agent", senderChatId: ctx.scope.chatId });
    this.grantFromAgentMessage(ctx.scope.chatId, chat.id, args.message);
    updateLocalRequest(ctx.scope.chatId, requestId, { state: "dispatching", targetChatId: chat.id, turnId: messageId });
    if (args.notify) {
      upsertLocalFollow({ followerChatId: ctx.scope.chatId, targetChatId: chat.id, events: ["done", "question", "permission"], turnId: messageId });
    }
    const workspaceId = this.workspaceIdOf(ctx, chat);
    const starting = this.ports
      .startTurn({
        chatId: chat.id,
        agentId: chat.agentId ?? settings.agentId,
        folder: chat.folder,
        ...(workspaceId ? { workspaceId } : {}),
        env: settings.env,
        text: this.fromAgent(ctx.scope.chatId, args.message),
        turnId: messageId,
        presentation: this.fromAgentPresentation(ctx.scope.chatId, args.message),
      })
      .then((outcome) => {
        // Recorded whether or not the caller is still waiting, so a replay
        // with the same request id reports what happened.
        if (outcome.kind === "busy") {
          updateLocalRequest(ctx.scope.chatId, requestId, {
            state: "refused",
            error: {
              code: "BUSY",
              message: "That chat started working. Wait for it, then send again.",
              retryable: true,
              details: { turnId: outcome.activeTurnId },
            },
          });
        } else if (outcome.kind === "failed") {
          updateLocalRequest(ctx.scope.chatId, requestId, {
            state: outcome.code === "OUTCOME_UNKNOWN" ? "unknown" : "refused",
            error: { code: outcome.code ?? "UNAVAILABLE", message: outcome.message },
          });
        } else {
          updateLocalRequest(ctx.scope.chatId, requestId, {
            state: "dispatched",
            result: result({ delivery: "new_turn", turnId: outcome.turnId, steered: false }),
          });
        }
        this.changed(chat.id);
        return outcome;
      })
      .catch((): LocalStartTurnOutcome => {
        updateLocalRequest(ctx.scope.chatId, requestId, { state: "unknown" });
        this.changed(chat.id);
        return { kind: "failed", message: "Zeros could not confirm the start.", code: "OUTCOME_UNKNOWN" };
      });
    const outcome = await withinOrNull(starting, LOCAL_ACCEPT_WAIT_MS);
    if (!outcome) return result({ delivery: "starting", turnId: messageId, steered: false });
    if (outcome.kind === "busy") {
      throw new LocalOrchestrationError("BUSY", "That chat started working. Wait for it, then send again.", {
        retryable: true,
        details: { turnId: outcome.activeTurnId },
      });
    }
    if (outcome.kind === "failed") {
      throw new LocalOrchestrationError(outcome.code === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : (outcome.code ?? "UNAVAILABLE"), outcome.message);
    }
    return result({ delivery: "new_turn", turnId: outcome.turnId, steered: false });
  }

  private workspaceIdOf(ctx: CallContext, chat: ChatRow): string | null {
    const owner = ctx.index.ownerOfFolder(chat.folder);
    return owner && owner !== "foreign" && owner.kind === "worktree" ? owner.id : null;
  }

  private async chatCancel(ctx: CallContext, args: LocalArgs<"chat.cancel">) {
    const { chat } = this.visibleChat(ctx, args.chat);
    if (chat.id === ctx.scope.chatId) throw new LocalOrchestrationError("USAGE", "Use your own Stop; a chat cannot cancel itself.");
    const outcome = await this.ports.cancelTurn(chat.id);
    this.changed(chat.id);
    return { chatId: chat.id, link: this.chatLink(chat.id), outcome };
  }

  private chatFollow(ctx: CallContext, args: LocalArgs<"chat.follow">) {
    const { chat } = this.visibleChat(ctx, args.chat);
    if (chat.id === ctx.scope.chatId) throw new LocalOrchestrationError("USAGE", "A chat cannot follow itself.");
    const events: LocalFollowEvent[] = args.events ?? ["done", "question", "permission"];
    upsertLocalFollow({ followerChatId: ctx.scope.chatId, targetChatId: chat.id, events });
    return { chatId: chat.id, link: this.chatLink(chat.id), events };
  }

  private chatUnfollow(ctx: CallContext, args: LocalArgs<"chat.unfollow">) {
    const { chat } = this.visibleChat(ctx, args.chat);
    return { chatId: chat.id, removed: deleteLocalFollows(ctx.scope.chatId, chat.id) };
  }

  // ── Cards ──────────────────────────────────────────────

  private cardList(ctx: CallContext, args: LocalArgs<"card.list">) {
    const only = args.chat ? this.visibleChat(ctx, args.chat).chat.id : null;
    const cards: LocalCard[] = [];
    for (const record of this.ports.pendingCards()) {
      if (!record.chatId || (only && record.chatId !== only)) continue;
      const chat = this.ports.getChat(record.chatId);
      if (!chat) continue;
      const owner = ctx.index.ownerOfFolder(chat.folder);
      if (owner === "foreign" || !chatVisibleAs(ctx.visibility, chat.id, owner)) continue;
      cards.push(projectCard(record, this.chatLink(chat.id)));
    }
    return { cards };
  }

  private async cardAnswer(ctx: CallContext, args: LocalArgs<"card.answer">) {
    const parsed = parseCardId(args.card);
    if (!parsed) throw new LocalOrchestrationError("USAGE", "Card ids look like perm:<id> or q:<id>. Run `zeros local card list`.");
    const record = this.ports.pendingCards().find((c) => c.type === parsed.type && c.id === parsed.id);
    if (!record?.chatId) throw new LocalOrchestrationError("ALREADY_SETTLED", "That card was already answered or has expired.");
    const { chat } = this.visibleChat(ctx, record.chatId);
    if (chat.id === ctx.scope.chatId) throw new LocalOrchestrationError("USAGE", "Agents cannot answer their own cards.");
    const kind = cardKind(record);
    const card = projectCard(record, this.chatLink(chat.id));
    const targetLevel = chatModeOf(chat, this.ports.liveChat(chat.id).modeId).level;

    if (record.type === "permission" && record.permission) {
      const optionId = args.deny
        ? (record.permission.options.find((o) => o.kind === "reject_once") ?? record.permission.options.find((o) => o.kind.startsWith("reject")))?.optionId
        : args.option;
      if (!optionId && !args.deny) throw new LocalOrchestrationError("USAGE", "Answer a permission with --option <id> or --deny.");
      const option = record.permission.options.find((o) => o.optionId === optionId);
      if (optionId && !option) throw new LocalOrchestrationError("USAGE", `Option "${optionId}" is not on that card.`, { details: { options: card.options } });
      const approving = option ? option.kind.startsWith("allow") : false;
      const restoredModeId = kind === "plan_approval" ? (chat.prePlanModeId ?? null) : null;
      assertAnswerAllowed({
        kind,
        approving,
        callerLevel: ctx.callerLevel,
        targetLevel,
        restoredLevel: restoredModeId ? localModeLevel(chat.agentId, restoredModeId) : kind === "plan_approval" ? "auto" : null,
      });
      const handled = this.ports.answerPermission(
        record,
        option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } },
        this.answeredBy(ctx),
      );
      if (!handled) throw new LocalOrchestrationError("ALREADY_SETTLED", "That card was already answered or has expired.");
      recordLocalCardAnswer({ cardId: args.card, chatId: chat.id, kind, answeredByChatId: ctx.scope.chatId, answer: option && !args.deny ? option.optionId : "denied" });
      if (kind === "plan_approval" && approving) {
        const back = restoredModeId ?? localModeForAuto(chat.agentId);
        if (back) {
          await this.ports.setMode(chat.id, back).catch(() => {});
          this.ports.updateChatMode(chat.id, { lastModeId: back, prePlanModeId: null, permissionMode: postureOf(chat.agentId, back) });
          this.ports.chatsChanged([chat.id]);
        }
      }
      this.changed(chat.id);
      return {
        cardId: args.card,
        kind,
        chatId: chat.id,
        answered: args.deny || !option ? "denied" : option.optionId,
        ...(option ? { option: option.optionId } : {}),
        answeredBy: this.chatLink(ctx.scope.chatId),
      };
    }

    const question = record.question!;
    let answers: QuestionAnswer[] | null = null;
    let declined = false;
    if (args.deny) {
      declined = true;
    } else if (args.answers) {
      answers = args.answers;
    } else if (args.option || args.text) {
      const spec = question.questions[0];
      if (!spec || question.questions.length !== 1) {
        throw new LocalOrchestrationError("USAGE", "This card has several questions; answer with --answers JSON.");
      }
      if (args.option && !spec.options.some((o) => o.id === args.option)) {
        throw new LocalOrchestrationError("USAGE", `Option "${args.option}" is not on that card.`, { details: { options: card.options } });
      }
      answers = [{ questionId: spec.id, selectedOptionIds: args.option ? [args.option] : [], ...(args.text ? { freeText: args.text } : {}) }];
    } else {
      throw new LocalOrchestrationError("USAGE", "Answer with --option <id>, --answers JSON, --text or --deny.");
    }
    // Free text cannot be judged by the guard, so an approval takes an option.
    if (kind === "approval" && !declined && (answers ?? []).some((a) => a.freeText || a.selectedOptionIds.length === 0)) {
      throw new LocalOrchestrationError("USAGE", "Answer an approval card with --option <id> or --deny.", { details: { options: card.options } });
    }
    const approving =
      kind === "approval" &&
      !declined &&
      (answers ?? []).some((a) => a.selectedOptionIds.some((id) => card.options.find((o) => o.id === id)?.effect !== "deny"));
    assertAnswerAllowed({ kind, approving, callerLevel: ctx.callerLevel, targetLevel });
    const handled = this.ports.answerQuestion(
      record,
      declined ? { outcome: question.allowDecline ? { outcome: "declined" } : { outcome: "dismissed" } } : { outcome: { outcome: "answered", answers: answers! } },
      this.answeredBy(ctx),
    );
    if (!handled) throw new LocalOrchestrationError("ALREADY_SETTLED", "That card was already answered or has expired.");
    recordLocalCardAnswer({ cardId: args.card, chatId: chat.id, kind, answeredByChatId: ctx.scope.chatId, answer: declined ? "declined" : JSON.stringify(answers) });
    // A non-blocking question's answer reaches the provider as a message, as
    // the composer does.
    if (!question.blocking && answers) {
      const text = answers
        .map((a) => {
          const spec = question.questions.find((q) => q.id === a.questionId);
          const labels = a.selectedOptionIds.map((id) => spec?.options.find((o) => o.id === id)?.label ?? id);
          return `${spec?.prompt ?? a.questionId}: ${[...labels, ...(a.freeText ? [a.freeText] : [])].join(", ")}`;
        })
        .join("\n");
      await this.deliverText(
        ctx.scope.chatId,
        chat.id,
        this.fromAgent(ctx.scope.chatId, text),
        "agent",
        this.fromAgentPresentation(ctx.scope.chatId, text),
      ).catch(() => {});
    }
    this.changed(chat.id);
    return { cardId: args.card, kind, chatId: chat.id, answered: declined ? "declined" : answers, answeredBy: this.chatLink(ctx.scope.chatId) };
  }

  /** What the receiving agent (and the user, in that tab) reads: the sender
   * named before the message, so another agent's words are never mistaken
   * for the user's. Provenance is also recorded for transcripts. */
  private fromAgent(senderChatId: string, text: string): string {
    const sender = this.ports.getChat(senderChatId);
    const title = (sender?.title || "Untitled").replace(/\s+/g, " ").slice(0, 80);
    return `${LOCAL_NOTE_PREFIX} From agent "${title}" (${this.chatLink(senderChatId)}):\n\n${text}`;
  }

  /** The recipient's transcript shows the sender's own text under a "Sent
   * from" header instead of the label the provider reads. */
  private fromAgentPresentation(senderChatId: string, text: string): LocalMessagePresentation {
    return { displayText: text, localFrom: this.chatRef(senderChatId) };
  }

  private chatRef(chatId: string): LocalMessageChatRef {
    const chat = this.ports.getChat(chatId);
    return {
      chatId,
      title: (chat?.title || "Untitled").replace(/\s+/g, " ").slice(0, 200),
      agentId: chat?.agentId ?? null,
      link: this.chatLink(chatId),
    };
  }

  /** A follow is a standing read: each note is checked like a fresh call —
   * the gate is open, both chats are in Local owners and the follower can
   * still see the source. A note that fails is retired, not delivered. */
  private noteAllowed(followerChatId: string, sourceChatId: string): boolean {
    if (!this.ports.featureOpen() || this.ports.isCloudWorker()) return false;
    try {
      const follower = this.ports.getChat(followerChatId);
      const source = this.ports.getChat(sourceChatId);
      if (!follower || !source || follower.archived || this.ports.wasChatDeleted(followerChatId)) return false;
      const index = new LocalOwnerIndex(this.ports);
      const followerOwner = index.ownerOfFolder(follower.folder);
      const sourceOwner = index.ownerOfFolder(source.folder);
      if (!followerOwner || followerOwner === "foreign" || !sourceOwner || sourceOwner === "foreign") return false;
      const visibility = computeVisibility(followerChatId, index, (id) => this.ports.getChat(id));
      return chatVisibleAs(visibility, sourceChatId, sourceOwner) !== null;
    } catch {
      return false;
    }
  }

  // ── Shares ─────────────────────────────────────────────

  /** An agent message shares only links its sender can already see — and
   * always the sender itself, so the recipient can reply. */
  private grantFromAgentMessage(senderChatId: string, recipientChatId: string, text: string): void {
    if (senderChatId !== recipientChatId) {
      insertLocalShare({ holderChatId: recipientChatId, kind: "chat", targetId: senderChatId, grantedBy: `agent:${senderChatId}` });
    }
    const links = extractLocalLinks(text).filter((link) => link.scheme === this.ports.linkScheme());
    if (links.length === 0) return;
    let index: LocalOwnerIndex;
    try {
      index = new LocalOwnerIndex(this.ports);
    } catch {
      return;
    }
    const senderVisibility = computeVisibility(senderChatId, index, (id) => this.ports.getChat(id));
    for (const link of links) {
      if (link.kind === "chat") {
        const target = this.ports.getChat(link.id);
        if (!target) continue;
        const owner = index.ownerOfFolder(target.folder);
        if (owner === "foreign" || !chatVisibleAs(senderVisibility, target.id, owner)) continue;
        insertLocalShare({ holderChatId: recipientChatId, kind: "chat", targetId: target.id, grantedBy: `agent:${senderChatId}` });
      } else {
        const owner = index.ownerById(link.id);
        if (!owner || owner === "foreign") continue;
        if (!senderVisibility.workspaceIds.has(owner.id) && !this.isOwnWorkspace(senderChatId, owner.id, index)) continue;
        insertLocalShare({ holderChatId: recipientChatId, kind: "workspace", targetId: owner.id, grantedBy: `agent:${senderChatId}` });
      }
    }
  }

  private isOwnWorkspace(chatId: string, workspaceId: string, index: LocalOwnerIndex): boolean {
    const chat = this.ports.getChat(chatId);
    const owner = chat ? index.ownerOfFolder(chat.folder) : null;
    return owner != null && owner !== "foreign" && owner.id === workspaceId;
  }

  // ── Engine hooks ───────────────────────────────────────

  private changed(chatId: string): void {
    this.events.emit("changed", chatId);
  }

  /** A user-role message was persisted in a chat. Human messages share every
   * Local link in them and lift the user's Stop. */
  onUserMessagePersisted(input: { chatId: string; messageId: string; text: string; human: boolean }): void {
    try {
      if (!input.human) return;
      clearHumanStop(input.chatId);
      const links = extractLocalLinks(input.text).filter((link) => link.scheme === this.ports.linkScheme());
      if (links.length === 0) return;
      const index = new LocalOwnerIndex(this.ports);
      for (const link of links) {
        if (link.kind === "chat") {
          const target = this.ports.getChat(link.id);
          const owner = target ? index.ownerOfFolder(target.folder) : null;
          if (!target || !owner || owner === "foreign") continue;
          insertLocalShare({ holderChatId: input.chatId, kind: "chat", targetId: target.id, grantedBy: "human" });
        } else {
          const owner = index.ownerById(link.id);
          if (!owner || owner === "foreign") continue;
          insertLocalShare({ holderChatId: input.chatId, kind: "workspace", targetId: owner.id, grantedBy: "human" });
        }
      }
    } catch {
      // Sharing is best-effort; it must never break a send.
    }
  }

  /** The user pressed Stop in a chat. */
  onHumanStop(chatId: string): void {
    try {
      recordHumanStop(chatId);
      retireLocalNotifications(chatId);
    } catch {
      /* never break Stop */
    }
    this.changed(chatId);
  }

  /** Something about a chat changed (turn started/ended, card opened/closed). */
  onChatChanged(chatId: string): void {
    this.changed(chatId);
  }

  /** A turn reached a terminal state. Followers get one note per event, and a
   * turn that only delivered a Zeros note never notifies anyone. */
  onTurnTerminal(input: { chatId: string; turnId: string; status: string }): void {
    this.changed(input.chatId);
    void this.flushPending(input.chatId);
    if (this.noteTurns.delete(`${input.chatId}:${input.turnId}`)) return;
    try {
      if (localMessageOrigin(input.chatId, input.turnId)?.kind === "zeros") return;
      const chat = this.ports.getChat(input.chatId);
      for (const follow of localFollowersOf(input.chatId)) {
        if (!follow.events.includes("done")) continue;
        if (follow.turnId && follow.turnId !== input.turnId) continue;
        if (!this.noteAllowed(follow.followerChatId, input.chatId)) continue;
        const text =
          `${LOCAL_NOTE_PREFIX} Chat "${chat?.title ?? input.chatId}" (${this.chatLink(input.chatId)}) finished its turn: ${input.status}.\n` +
          `Read it with: zeros local chat messages ${this.chatLink(input.chatId)} --last --json`;
        const row = insertLocalNotification({
          followerChatId: follow.followerChatId,
          sourceChatId: input.chatId,
          event: "done",
          eventKey: input.turnId,
          text,
          note: { ...this.chatRef(input.chatId), event: "done", status: input.status },
        });
        if (follow.turnId) deleteLocalTurnFollow(follow.followerChatId, input.chatId, follow.turnId);
        if (row) void this.deliverNotification(row);
      }
    } catch {
      /* notifications are best-effort */
    }
  }

  /** A card opened in a chat: notify its followers with the full content. */
  onCardOpened(record: LocalPendingCardRecord): void {
    if (!record.chatId) return;
    this.changed(record.chatId);
    try {
      const event = record.type === "permission" ? "permission" : "question";
      const chat = this.ports.getChat(record.chatId);
      const card = projectCard(record, this.chatLink(record.chatId));
      for (const follow of localFollowersOf(record.chatId)) {
        const wants = follow.events.includes(event) || (event === "question" && cardKind(record) === "approval" && follow.events.includes("permission"));
        if (!wants) continue;
        if (!this.noteAllowed(follow.followerChatId, record.chatId)) continue;
        const text =
          `${LOCAL_NOTE_PREFIX} Chat "${chat?.title ?? record.chatId}" (${this.chatLink(record.chatId)}) is waiting on ${withArticle(card.kind.replace("_", " "))} card:\n` +
          `${JSON.stringify({ cardId: card.cardId, kind: card.kind, title: card.title, detail: card.detail, options: card.options })}\n` +
          `Answer with: ${card.answerCommand}`;
        const row = insertLocalNotification({
          followerChatId: follow.followerChatId,
          sourceChatId: record.chatId,
          event,
          eventKey: record.id,
          text,
          note: { ...this.chatRef(record.chatId), event, cardId: card.cardId, cardKind: card.kind, cardTitle: card.title },
        });
        if (row) void this.deliverNotification(row);
      }
    } catch {
      /* best-effort */
    }
  }

  private async flushPending(followerChatId: string): Promise<void> {
    try {
      for (const row of pendingLocalNotifications(followerChatId)) await this.deliverNotification(row);
    } catch {
      /* retried on the next state change */
    }
  }

  private async deliverNotification(row: LocalNotificationRow): Promise<void> {
    // A follower going idle flushes its pending notes while a fresh note may
    // still be on its way: deliver each row once.
    if (this.delivering.has(row.id)) return;
    this.delivering.add(row.id);
    try {
      await this.deliverNotificationOnce(row);
    } finally {
      this.delivering.delete(row.id);
    }
  }

  private async deliverNotificationOnce(row: LocalNotificationRow): Promise<void> {
    if (!this.ports.featureOpen()) return; // stays pending until the gate opens again
    if (isHumanStopped(row.followerChatId) || !this.noteAllowed(row.followerChatId, row.sourceChatId)) {
      setLocalNotificationState(row.id, "retired");
      return;
    }
    if (!claimLocalNotification(row.id)) return;
    try {
      const outcome = await this.deliverText(
        null,
        row.followerChatId,
        row.text,
        "zeros",
        row.note ? { displayText: noteSummary(row.note), localNote: row.note } : undefined,
      );
      // Settled only from the claim: a Stop that retired the note meanwhile wins.
      if (outcome === "delivered") settleLocalNotification(row.id, "delivered");
      // Known not delivered: pending again, retried when the follower's turn
      // ends. Unknown stays claimed: never sent a second time.
      else if (outcome === "not_delivered") settleLocalNotification(row.id, "pending");
    } catch {
      /* the claim stays unknown: at most once */
    }
  }

  /** Put text into a chat: steer when it is working, start a turn when idle. */
  private async deliverText(
    senderChatId: string | null,
    chatId: string,
    text: string,
    origin: "agent" | "zeros",
    presentation?: LocalMessagePresentation,
  ): Promise<"delivered" | "not_delivered" | "unknown"> {
    const chat = this.ports.getChat(chatId);
    if (!chat || !chat.agentId) return "not_delivered";
    const live = this.ports.liveChat(chatId);
    const messageId = newTurnId();
    recordLocalMessageOrigin({ chatId, messageId, kind: origin, senderChatId });
    if (live.activeTurn && !live.activeTurn.cancelled && live.executionId) {
      const steered = await this.ports.steer({
        chatId,
        executionId: live.executionId,
        agentId: chat.agentId,
        text,
        messageId,
        ...(presentation ? { presentation } : {}),
      });
      return steered.kind === "delivered" ? "delivered" : steered.kind === "unknown" ? "unknown" : "not_delivered";
    }
    let index: LocalOwnerIndex;
    try {
      index = new LocalOwnerIndex(this.ports);
    } catch {
      return "not_delivered";
    }
    const owner = index.ownerOfFolder(chat.folder);
    if (!owner || owner === "foreign" || owner.archived) return "not_delivered";
    const settings = resolveChildSettings({
      parent: chat,
      parentLiveModeId: live.modeId,
      requested: {},
      sameFolder: true,
      initialize: (agentId) => this.ports.initializeSnapshot(agentId),
      isKnownAgent: () => true,
      userSettings: this.ports.userSettings(chat.folder),
    });
    if (origin === "zeros") this.noteTurns.add(`${chatId}:${messageId}`);
    const outcome = await this.ports.startTurn({
      chatId,
      agentId: chat.agentId,
      folder: chat.folder,
      ...(owner.kind === "worktree" ? { workspaceId: owner.id } : {}),
      env: settings.env,
      text,
      turnId: messageId,
      ...(presentation ? { presentation } : {}),
    });
    if (outcome.kind !== "accepted") this.noteTurns.delete(`${chatId}:${messageId}`);
    this.changed(chatId);
    return outcome.kind === "accepted" ? "delivered" : outcome.kind === "failed" && outcome.code === "OUTCOME_UNKNOWN" ? "unknown" : "not_delivered";
  }
}

/** A first turn that failed before the provider ever ran: the agent could not
 * sign in, launch or open a session. A rate limit means it connected. */
function neverConnected(outcome: Extract<LocalStartTurnOutcome, { kind: "failed" }>): boolean {
  return outcome.code === "UNAVAILABLE" && outcome.failureKind !== "rate-limited";
}

/** The plain summary a follower's transcript keeps for a note. */
export function noteSummary(note: LocalMessageNote): string {
  if (note.event === "done") return `Chat "${note.title}" finished its turn: ${note.status ?? "ended"}.`;
  const kind = (note.cardKind ?? note.event).replace("_", " ");
  return `Chat "${note.title}" is waiting on ${withArticle(kind)} card${note.cardTitle ? `: ${note.cardTitle}` : "."}`;
}

function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

function localModeForAuto(agentId: string | null): string | null {
  const family = (agentId ?? "").toLowerCase();
  if (family.startsWith("claude")) return "auto";
  if (family.startsWith("codex")) return "auto-edit";
  if (family.startsWith("cursor")) return "auto";
  return null;
}

function postureOf(agentId: string | null, modeId: string): string {
  const level = localModeLevel(agentId, modeId);
  return level === "plan" ? "plan" : level === "ask" ? "tool-approval" : level === "full" ? "danger" : "auto";
}

/** How long create/send wait for a provider to accept the turn before
 * answering `starting`. Short enough for a Codex shell's ~10 s limit. */
const LOCAL_ACCEPT_WAIT_MS = 5_000;

async function withinOrNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return (await withinOrNull(promise.then(() => true as const), ms)) === true;
}
