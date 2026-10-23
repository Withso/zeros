// ──────────────────────────────────────────────────────────
// Local orchestration — ports over the desktop's own paths
// ──────────────────────────────────────────────────────────
//
// The service never writes provider state itself. Starting, steering and
// stopping a turn, changing a mode and creating a workspace go through the
// exact handlers a renderer reaches (AGENT_NEW_SESSION / AGENT_LOAD_SESSION /
// AGENT_PROMPT / AGENT_STEER / AGENT_CANCEL / AGENT_SET_MODE and
// workspace.prepareCreate → workspace.create), dispatched to a private
// in-process receiver. Admission, persistence, turn rows, routing and
// lifecycle gates therefore stay single-sourced in zeros-engine.ts. A
// receiver is never registered with the router: it hears only the replies
// addressed to it, never broadcasts.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  InitializeResponse,
  QuestionRequest,
  QuestionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@zeros/protocol/agent-events";
import { LocalOrchestrationError, type LocalLinkScheme } from "@zeros/protocol/local-orchestration";
import { getChat, listChats, updateChatPermissionMode, upsertChat, wasChatDeleted } from "../db/chats";
import { isHumanStopped } from "../db/local-orchestration";
import { listProjects } from "../db/projects";
import { runGitRead } from "../git/git-exec";
import { getWorkspaceById } from "../git/state";
import { listWorkspaces, whenSeedingSettled } from "../git/worktree";
import { opSettingsResolve } from "../settings/ops";
import type { TransportClient } from "../transport/types";
import { createMessage, type CardAnsweredBy, type EngineMessage } from "../types";
import type { LocalMessagePresentation, LocalOrchestrationPorts, LocalPendingCardRecord, LocalStartTurnOutcome } from "./types";

/** What the engine lends the ports. Everything here is a read of engine
 * state or a call into an existing handler — no new lifecycle. */
export interface LocalEngineHost {
  linkScheme(): LocalLinkScheme;
  featureOpen(): boolean;
  /** The live execution bound to a chat, if any. */
  executionForChat(chatId: string): { executionId: string; agentId: string } | null;
  /** The accepted turn on an execution. `ended` once its terminal state was
   * published, even before the engine releases the record. */
  activePrompt(executionId: string): { turnId: string; startedAt: number; cancelled: boolean; ended: boolean } | null;
  currentModeId(executionId: string): string | null;
  chatForExecution(executionId: string): string | null;
  pendingPermissions(): Iterable<[string, { agentId: string; request: RequestPermissionRequest }]>;
  pendingQuestions(): Iterable<[string, { agentId: string; request: QuestionRequest }]>;
  answerPermission(permissionId: string, executionId: string, response: RequestPermissionResponse, answeredBy: CardAnsweredBy): boolean;
  answerQuestion(questionId: string, executionId: string, response: QuestionResponse, answeredBy: CardAnsweredBy, nativeRequestId?: string): boolean;
  initializeSnapshot(agentId: string): InitializeResponse | null;
  /** The adapter's current metadata, re-read (not the cached first read). */
  currentInitialize(agentId: string): Promise<InitializeResponse | null>;
  /** Start a cheap metadata read so the next snapshot has live models. */
  warmInitialize(agentId: string): void;
  agentDisplayName(agentId: string): string | null;
  dispatchAgent(message: EngineMessage, client: TransportClient): Promise<void>;
  dispatchWorkspace(message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>, client: TransportClient): Promise<void>;
  chatsChanged(chatIds: string[]): void;
  /** A workspace the Local CLI is creating: it gets setup but no run-on-create actions. */
  markOrchestrationWorkspace(workspaceId: string, created: boolean): void;
  /** How the recipient's transcript shows the input dispatched next under
   * this message id (an agent's message or a Zeros note). */
  stagePresentation(messageId: string, presentation: LocalMessagePresentation): void;
  /** The provider's own gate: a signed-out or expired selected account. */
  agentAccountConnected(agentId: string): boolean;
  /** Delete a chat row and tell renderers (tombstoned like a user delete). */
  removeChat(chatId: string): void;
}

const RECEIVER_PREFIX = "local-orchestration:";
const RECEIVER_INBOX = 64;
const SETUP_POLL_MS = 1_000;
/** Setup normally starts within a second of seeding; if it never starts the
 * workspace is usable, as it is in the UI. */
const SETUP_START_GRACE_MS = 120_000;
const SETUP_MAX_WAIT_MS = 2 * 60 * 60_000;
const SAFE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/@{}^~+-]{1,250}$/;
/** A catalog read is cheap metadata; never let `models` hang on one. */
const CURRENT_INITIALIZE_MS = 2_000;

/** A private reply channel for one facade operation. */
class Receiver {
  readonly client: TransportClient;
  private readonly inbox: EngineMessage[] = [];

  constructor() {
    this.client = {
      id: `${RECEIVER_PREFIX}${randomUUID()}`,
      kind: "local",
      send: (message) => {
        this.inbox.push(message);
        if (this.inbox.length > RECEIVER_INBOX) this.inbox.shift();
      },
      close: () => {},
    };
  }

  reply(requestId: string): EngineMessage | null {
    const index = this.inbox.findIndex((m) => (m as { requestId?: unknown }).requestId === requestId);
    if (index < 0) return null;
    return this.inbox.splice(index, 1)[0] ?? null;
  }
}

/** Is this transport client one of the Local CLI's own receivers? Messages it
 * sends are agents', never the user's. */
export function isLocalOrchestrationReceiver(client: { id: string } | null | undefined): boolean {
  return !!client && client.id.startsWith(RECEIVER_PREFIX);
}

function failureKind(message: EngineMessage | null): string | undefined {
  const kind = (message as { failure?: { kind?: unknown } } | null)?.failure?.kind;
  return typeof kind === "string" ? kind : undefined;
}

function failureText(message: EngineMessage | null): string {
  if (!message) return "Zeros did not confirm the start.";
  const m = message as { message?: unknown; error?: unknown };
  const text = typeof m.message === "string" ? m.message : typeof m.error === "string" ? m.error : "";
  return text.slice(0, 500) || "The agent could not start.";
}

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runGitRead(cwd, args);
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface LocalEnginePorts extends LocalOrchestrationPorts {
  /** For tests and diagnostics: workspaces whose setup state is still awaited. */
  readonly awaitingSetup: ReadonlyMap<string, boolean>;
}

export function createLocalEnginePorts(host: LocalEngineHost): LocalEnginePorts {
  const engineId = randomUUID();
  /** Workspace id → whether create resolved a setup command. */
  const setupExpected = new Map<string, boolean>();

  const workspaceOp = async (op: string, params: Record<string, unknown>): Promise<unknown> => {
    const receiver = new Receiver();
    const message = createMessage({ type: "WORKSPACE_REQUEST", source: "engine", op, params });
    await host.dispatchWorkspace(message, receiver.client);
    const reply = receiver.reply(message.id);
    if (reply?.type === "WORKSPACE_RESPONSE") return reply.result;
    throw new LocalOrchestrationError("UNAVAILABLE", failureText(reply));
  };

  /** Bind a live execution to the chat, resuming its provider conversation
   * when it has one, exactly as opening the tab would. */
  const ensureExecution = async (input: {
    chatId: string;
    agentId: string;
    folder: string;
    workspaceId?: string;
    env: Record<string, string>;
  }): Promise<{ executionId: string } | { superseded: true } | { failed: string; code?: "UNAVAILABLE" | "STALE" | "OUTCOME_UNKNOWN"; failureKind?: string }> => {
    const live = host.executionForChat(input.chatId);
    if (live) {
      if (live.agentId !== input.agentId) return { failed: "That chat's live session belongs to a different agent.", code: "STALE" };
      return { executionId: live.executionId };
    }
    const chat = getChat(input.chatId);
    if (!chat) return { failed: "That chat no longer exists.", code: "STALE" };
    const binding = chat.providerBinding?.providerId === input.agentId ? chat.providerBinding : null;
    const resumable = binding !== null || (chat.agentId === input.agentId && !!chat.sessionId);
    const receiver = new Receiver();
    const common = {
      source: "engine" as const,
      agentId: input.agentId,
      chatId: input.chatId,
      cwd: input.folder,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      env: input.env,
    };
    const message = resumable
      ? createMessage({ type: "AGENT_LOAD_SESSION", ...common, ...(binding ? { providerBinding: binding } : {}) })
      : createMessage({ type: "AGENT_NEW_SESSION", ...common });
    await host.dispatchAgent(message, receiver.client);
    const reply = receiver.reply(message.id);
    if (reply?.type === "AGENT_SESSION_CREATED") return { executionId: reply.session.executionId };
    if (reply?.type === "AGENT_SESSION_LOADED") return { executionId: reply.executionId };
    // The user opened the tab at the same moment and its bind won: use it.
    if (failureKind(reply) === "lifecycle-superseded") return { superseded: true };
    const kind = failureKind(reply);
    return { failed: failureText(reply), code: reply ? "UNAVAILABLE" : "OUTCOME_UNKNOWN", ...(kind ? { failureKind: kind } : {}) };
  };

  /** Dispatch a prompt and report acceptance without awaiting the turn. The
   * prompt handler runs synchronously until the accepted turn is recorded, so
   * acceptance is observable the moment dispatch returns its promise. */
  const promptOnce = (input: { executionId: string; agentId: string; text: string; turnId: string; presentation?: LocalMessagePresentation }): LocalStartTurnOutcome | "expired" | Promise<LocalStartTurnOutcome | "expired"> => {
    const receiver = new Receiver();
    if (input.presentation) host.stagePresentation(input.turnId, input.presentation);
    const message = createMessage({
      type: "AGENT_PROMPT",
      source: "engine",
      agentId: input.agentId,
      sessionId: input.executionId,
      executionId: input.executionId,
      prompt: [{ type: "text", text: input.text }],
      userMessageId: input.turnId,
      promptId: input.turnId,
      startedAt: Date.now(),
    });
    const flight = host.dispatchAgent(message, receiver.client).catch(() => {});
    const accepted = host.activePrompt(input.executionId);
    if (accepted && accepted.turnId === input.turnId) {
      return { kind: "accepted", executionId: input.executionId, turnId: input.turnId };
    }
    return flight.then((): LocalStartTurnOutcome | "expired" => {
      const reply = receiver.reply(message.id);
      const kind = failureKind(reply);
      if (kind === "session-expired") return "expired";
      const text = failureText(reply);
      if (/already responding/i.test(text)) {
        const active = host.activePrompt(input.executionId);
        return { kind: "busy", executionId: input.executionId, activeTurnId: active?.turnId ?? null };
      }
      return { kind: "failed", message: text, code: reply ? "UNAVAILABLE" : "OUTCOME_UNKNOWN", ...(kind ? { failureKind: kind } : {}) };
    });
  };

  const ports: LocalEnginePorts = {
    awaitingSetup: setupExpected,
    engineId: () => engineId,
    linkScheme: () => host.linkScheme(),
    featureOpen: () => host.featureOpen(),

    listManagedWorkspaces: () => listWorkspaces({}),
    getManagedWorkspace: (id) => {
      const ws = getWorkspaceById(id);
      return ws ? { ...ws, present: !!ws.path && existsSync(ws.path) } : null;
    },
    // No seed list: a read, not the workspace→repo seeding transaction.
    listProjects: () => listProjects([]),

    getChat: (id) => getChat(id),
    listChats: () => listChats(),
    wasChatDeleted: (id) => wasChatDeleted(id),
    upsertChat: (row) => upsertChat(row),
    updateChatMode: (chatId, mode) => {
      updateChatPermissionMode(chatId, mode);
    },
    agentDisplayName: (agentId) => host.agentDisplayName(agentId),

    liveChat: (chatId) => {
      const live = host.executionForChat(chatId);
      if (!live) return { executionId: null, agentId: null, activeTurn: null, modeId: null };
      const prompt = host.activePrompt(live.executionId);
      return {
        executionId: live.executionId,
        agentId: live.agentId,
        activeTurn: prompt && !prompt.ended ? { turnId: prompt.turnId, cancelled: prompt.cancelled, startedAt: prompt.startedAt } : null,
        modeId: host.currentModeId(live.executionId),
      };
    },
    pendingCards: () => {
      const cards: LocalPendingCardRecord[] = [];
      for (const [id, pending] of host.pendingPermissions()) {
        const executionId = pending.request.sessionId;
        cards.push({ id, type: "permission", chatId: host.chatForExecution(executionId), executionId, agentId: pending.agentId, permission: pending.request });
      }
      for (const [id, pending] of host.pendingQuestions()) {
        const executionId = pending.request.sessionId;
        cards.push({ id, type: "question", chatId: host.chatForExecution(executionId), executionId, agentId: pending.agentId, question: pending.request });
      }
      return cards;
    },
    initializeSnapshot: (agentId) => {
      const snapshot = host.initializeSnapshot(agentId);
      if (!snapshot) host.warmInitialize(agentId);
      return snapshot;
    },
    currentInitialize: async (agentId) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const current = await Promise.race([
          host.currentInitialize(agentId),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), CURRENT_INITIALIZE_MS);
            timer.unref?.();
          }),
        ]);
        return current ?? host.initializeSnapshot(agentId);
      } catch {
        return host.initializeSnapshot(agentId);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    userSettings: (cwd) => {
      try {
        return opSettingsResolve(cwd).effective as Record<string, unknown>;
      } catch {
        return {};
      }
    },

    startTurn: async (input) => {
      // The user's Stop or a closed tab wins over anything an agent started
      // before it: checked before every bind and again before the prompt.
      const fenced = (): LocalStartTurnOutcome | null => {
        if (isHumanStopped(input.chatId)) {
          return { kind: "failed", message: "The user stopped that chat. It starts again only when the user writes there.", code: "STOPPED_BY_USER" };
        }
        if (getChat(input.chatId)?.archived !== false) {
          return { kind: "failed", message: "That chat was closed or deleted.", code: "STALE" };
        }
        return null;
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = fenced();
        if (before) return before;
        const execution = await ensureExecution(input);
        if ("superseded" in execution) continue;
        if ("failed" in execution) {
          return {
            kind: "failed",
            message: execution.failed,
            ...(execution.code ? { code: execution.code } : {}),
            ...(execution.failureKind ? { failureKind: execution.failureKind } : {}),
          };
        }
        const bound = fenced();
        if (bound) return bound;
        const outcome = await promptOnce({
          executionId: execution.executionId,
          agentId: input.agentId,
          text: input.text,
          turnId: input.turnId,
          ...(input.presentation ? { presentation: input.presentation } : {}),
        });
        // A route retired between bind and prompt: bind once more.
        if (outcome !== "expired") return outcome;
      }
      return { kind: "failed", message: "The chat's agent session ended while starting. Try again.", code: "STALE" };
    },

    steer: async (input) => {
      const receiver = new Receiver();
      if (input.presentation) host.stagePresentation(input.messageId, input.presentation);
      const message = createMessage({
        type: "AGENT_STEER",
        source: "engine",
        agentId: input.agentId,
        sessionId: input.executionId,
        executionId: input.executionId,
        prompt: [{ type: "text", text: input.text }],
        userMessageId: input.messageId,
        attemptId: input.messageId,
      });
      await host.dispatchAgent(message, receiver.client);
      const reply = receiver.reply(message.id);
      if (reply?.type === "AGENT_STEERED") {
        const outcome = reply.outcome ?? "delivered";
        if (outcome === "delivered") return { kind: "delivered" };
        if (outcome === "queued") return { kind: "not_delivered", reason: "the running turn did not take it" };
        return { kind: "unknown", reason: "delivery was not confirmed before the turn ended" };
      }
      return reply ? { kind: "not_delivered", reason: failureText(reply) } : { kind: "unknown", reason: "no reply" };
    },

    cancelTurn: async (chatId) => {
      const live = host.executionForChat(chatId);
      const prompt = live ? host.activePrompt(live.executionId) : null;
      if (!live || !prompt || prompt.ended) return "not_running";
      const receiver = new Receiver();
      await host.dispatchAgent(
        createMessage({ type: "AGENT_CANCEL", source: "engine", agentId: live.agentId, sessionId: live.executionId, executionId: live.executionId }),
        receiver.client,
      );
      return "stopped";
    },

    answerPermission: (card, response, answeredBy) => host.answerPermission(card.id, card.executionId, response, answeredBy),
    answerQuestion: (card, response, answeredBy) =>
      host.answerQuestion(card.id, card.executionId, response, answeredBy, card.question?.nativeRequestId),

    setMode: async (chatId, modeId) => {
      const live = host.executionForChat(chatId);
      if (!live) return;
      const receiver = new Receiver();
      await host.dispatchAgent(
        createMessage({ type: "AGENT_SET_MODE", source: "engine", agentId: live.agentId, sessionId: live.executionId, modeId }),
        receiver.client,
      );
    },

    createWorkspace: async (input) => {
      const prepared = (await workspaceOp("workspace.prepareCreate", {
        repoRoot: input.repoRoot,
        ...(input.name ? { prompt: input.name } : {}),
      })) as { workspaceId?: unknown; branch?: unknown } | null;
      if (typeof prepared?.workspaceId !== "string" || typeof prepared.branch !== "string") {
        throw new LocalOrchestrationError("UNAVAILABLE", "Zeros could not reserve the new workspace.");
      }
      host.markOrchestrationWorkspace(prepared.workspaceId, true);
      let baseBranch: string | undefined;
      if (input.base) baseBranch = await baseForCreate(input.repoRoot, input.base);
      let created: { workspaceId?: unknown; path?: unknown; branch?: unknown; setupCommand?: unknown } | null;
      try {
        created = (await workspaceOp("workspace.create", {
          repoRoot: input.repoRoot,
          preparedId: prepared.workspaceId,
          preparedBranch: prepared.branch,
          ...(baseBranch ? { baseBranch } : {}),
          ...(input.name ? { prompt: input.name } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
        })) as typeof created;
      } catch (error) {
        host.markOrchestrationWorkspace(prepared.workspaceId, false);
        throw error;
      }
      if (typeof created?.workspaceId !== "string" || typeof created.path !== "string" || typeof created.branch !== "string") {
        host.markOrchestrationWorkspace(prepared.workspaceId, false);
        throw new LocalOrchestrationError("OUTCOME_UNKNOWN", "Zeros did not confirm the new workspace.");
      }
      setupExpected.set(created.workspaceId, typeof created.setupCommand === "string" && created.setupCommand.length > 0);
      const row = getWorkspaceById(created.workspaceId);
      return {
        workspaceId: created.workspaceId,
        path: created.path,
        branch: created.branch,
        repoRoot: row?.repoRoot ?? input.repoRoot,
        baseBranch: row?.baseBranch ?? baseBranch ?? null,
      };
    },

    workspaceReadiness: async (workspaceId) => {
      try {
        await whenSeedingSettled(workspaceId);
        const expectsSetup = setupExpected.get(workspaceId) ?? false;
        const settledAt = Date.now();
        for (;;) {
          const row = getWorkspaceById(workspaceId);
          if (!row || row.archivedAt != null) return "missing";
          if (!expectsSetup) return "ready";
          const state = row.setupState ?? null;
          if (state === "passed") return "ready";
          if (state === "failed" || state === "stopped") return "setup_failed";
          const waited = Date.now() - settledAt;
          if ((state === null && waited > SETUP_START_GRACE_MS) || waited > SETUP_MAX_WAIT_MS) return "ready";
          await new Promise((resolve) => setTimeout(resolve, SETUP_POLL_MS).unref?.());
        }
      } finally {
        // The run-on-create mark is consumed by the engine when setup passes.
        setupExpected.delete(workspaceId);
      }
    },

    resolveCommit: async (cwd, ref) => {
      if (!SAFE_REF.test(ref)) return null;
      return gitOut(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    },

    chatsChanged: (chatIds) => host.chatsChanged(chatIds),
    agentConnection: (agentId) =>
      host.agentAccountConnected(agentId)
        ? { connected: true }
        : {
            connected: false,
            message: `Sign in to ${host.agentDisplayName(agentId) ?? agentId} in Zeros Settings before starting a chat with it.`,
          },
    removeChat: async (chatId) => {
      // A bind can outlive the prompt it was for; close it with the tab.
      const live = host.executionForChat(chatId);
      if (live) {
        await host
          .dispatchAgent(
            createMessage({ type: "AGENT_CLOSE_SESSION", source: "engine", agentId: live.agentId, sessionId: live.executionId, executionId: live.executionId, chatId }),
            new Receiver().client,
          )
          .catch(() => {});
      }
      host.removeChat(chatId);
    },
  };
  return ports;
}

/** A named branch stays the workspace's base branch (diffs and PRs target
 * it); anything else (a detached HEAD, a tag, a SHA) pins the exact commit. */
async function baseForCreate(repoRoot: string, base: { ref: string; commit: string; cwd: string }): Promise<string> {
  let ref = base.ref;
  if (ref === "HEAD") {
    const branch = await gitOut(base.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch) return base.commit;
    ref = branch;
  }
  const candidates = ref.startsWith("refs/heads/") || ref.startsWith("refs/remotes/")
    ? [ref]
    : [`refs/heads/${ref}`, `refs/remotes/${ref}`];
  for (const full of candidates) {
    if (!SAFE_REF.test(full)) continue;
    const tip = await gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", `${full}^{commit}`]);
    if (tip && tip === base.commit) return full;
  }
  return base.commit;
}
