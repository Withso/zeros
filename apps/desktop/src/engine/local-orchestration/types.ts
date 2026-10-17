// ──────────────────────────────────────────────────────────
// Local orchestration — the engine ports the service runs on
// ──────────────────────────────────────────────────────────
//
// The service (service.ts) owns policy: Local-only ownership, visibility,
// inheritance, receipts, follows and the card guard. Everything it needs from
// the running engine — chats, workspaces, live turns, cards and the desktop's
// own create/prompt/steer/cancel paths — comes through these ports, so the
// policy is testable without a provider and the engine keeps one copy of each
// lifecycle operation.
// ──────────────────────────────────────────────────────────

import type { InitializeResponse, QuestionRequest, QuestionResponse, RequestPermissionRequest, RequestPermissionResponse } from "@zeros/protocol/agent-events";
import type { LocalLinkScheme } from "@zeros/protocol/local-orchestration";
import type { LocalMessageChatRef, LocalMessageNote } from "@zeros/protocol/agent-messages";
import type { CardAnsweredBy } from "@zeros/protocol/messages";
import type { ChatRow } from "../db/chats";
import type { EngineProject } from "../db/projects";
import type { Workspace } from "../git/types";

/** The authenticated caller: one admitted agent execution in one chat. */
export interface LocalCallerScope {
  executionId: string;
  chatId: string;
  agentId: string;
  /** `cli` or `tool` — only changes wait caps and message-file support. */
  surface: "cli" | "tool";
}

/** Where a chat lives. `worktree` = a managed workspace row; `folder` = a
 * registered repository root or legacy plain folder (no workspace row). */
export interface LocalWorkspaceOwner {
  id: string;
  kind: "worktree" | "folder";
  path: string;
  repoRoot: string;
  name: string;
  branch: string | null;
  projectId: string | null;
  archived: boolean;
  setupState: string | null;
  present: boolean;
}

export interface LocalLiveChat {
  executionId: string | null;
  agentId: string | null;
  /** The accepted turn, if one is running. */
  activeTurn: { turnId: string; cancelled: boolean; startedAt: number } | null;
  /** The engine-held current mode id (provider-applied), when known. */
  modeId: string | null;
}

export interface LocalPendingCardRecord {
  id: string;
  type: "permission" | "question";
  chatId: string | null;
  executionId: string;
  agentId: string;
  permission?: RequestPermissionRequest;
  question?: QuestionRequest;
}

export type LocalStartTurnOutcome =
  | { kind: "accepted"; executionId: string; turnId: string }
  | { kind: "busy"; executionId: string; activeTurnId: string | null }
  | {
      kind: "failed";
      message: string;
      code?: "UNAVAILABLE" | "NOT_FOUND" | "STALE" | "STOPPED_BY_USER" | "OUTCOME_UNKNOWN";
      /** The provider failure behind an UNAVAILABLE refusal, when one was reported. */
      failureKind?: string;
    };

/** How the receiving chat shows an input the provider gets as `text`. */
export interface LocalMessagePresentation {
  displayText: string;
  localFrom?: LocalMessageChatRef;
  localNote?: LocalMessageNote;
}

export type LocalSteerOutcome =
  | { kind: "delivered" }
  | { kind: "not_delivered"; reason: string }
  | { kind: "unknown"; reason: string };

export interface LocalStartTurnInput {
  chatId: string;
  agentId: string;
  folder: string;
  workspaceId?: string;
  /** Composer settings env (model, effort, Fast, mode, Claude knobs). Provider
   * credentials are filled by the gateway's trusted fallback, never here. */
  env: Record<string, string>;
  text: string;
  turnId: string;
  presentation?: LocalMessagePresentation;
}

export interface LocalCreateWorkspaceInput {
  repoRoot: string;
  /** Where the new worktree starts. Omitted: the repository's default base,
   * exactly like a workspace the user creates. `ref` is what the agent named
   * (a branch keeps its name as the workspace base), `commit` its resolved SHA
   * and `cwd` the checkout it was resolved in. */
  base?: { ref: string; commit: string; cwd: string };
  name?: string;
  agentId?: string;
}

export interface LocalOrchestrationPorts {
  /** Engine boot identity (changes on restart). */
  engineId(): string;
  linkScheme(): LocalLinkScheme;
  isCloudWorker(): boolean;
  /** Is the staged feature open right now? */
  featureOpen(): boolean;

  listManagedWorkspaces(): Workspace[];
  getManagedWorkspace(id: string): Workspace | null;
  listProjects(): EngineProject[];

  getChat(id: string): ChatRow | null;
  listChats(): ChatRow[];
  wasChatDeleted(id: string): boolean;
  upsertChat(row: ChatRow): void;
  /** Narrow permission posture update for an existing chat. */
  updateChatMode(chatId: string, mode: { permissionMode: string; lastModeId: string | null; prePlanModeId: string | null }): void;
  agentDisplayName(agentId: string): string | null;

  liveChat(chatId: string): LocalLiveChat;
  pendingCards(): LocalPendingCardRecord[];
  initializeSnapshot(agentId: string): InitializeResponse | null;
  /** The agent's current catalog (an adapter republishes models after an
   * account refuses one); falls back to the snapshot when it cannot answer. */
  currentInitialize(agentId: string): Promise<InitializeResponse | null>;
  /** User settings for a folder (Claude idle/memory/compaction knobs). */
  userSettings(cwd: string): Record<string, unknown>;

  /** Start a turn in a chat (resuming its provider conversation when no
   * execution is live). Resolves on acceptance, never on completion. */
  startTurn(input: LocalStartTurnInput): Promise<LocalStartTurnOutcome>;
  steer(input: { chatId: string; executionId: string; agentId: string; text: string; messageId: string; presentation?: LocalMessagePresentation }): Promise<LocalSteerOutcome>;
  cancelTurn(chatId: string): Promise<"stopped" | "not_running">;
  /** Settle a card for an agent; `answeredBy` rides the settle broadcast. */
  answerPermission(card: LocalPendingCardRecord, response: RequestPermissionResponse, answeredBy: CardAnsweredBy): boolean;
  answerQuestion(card: LocalPendingCardRecord, response: QuestionResponse, answeredBy: CardAnsweredBy): boolean;
  /** Apply a permission mode to a live execution (plan approval). */
  setMode(chatId: string, modeId: string): Promise<void>;

  createWorkspace(input: LocalCreateWorkspaceInput): Promise<{ workspaceId: string; path: string; branch: string; repoRoot: string; baseBranch: string | null }>;
  /** Resolves when seeding settles; `none` when no setup is configured. */
  workspaceReadiness(workspaceId: string): Promise<"ready" | "setup_failed" | "missing">;
  resolveCommit(cwd: string, ref: string): Promise<string | null>;

  /** Tell renderers the chat list changed. */
  chatsChanged(chatIds: string[]): void;
  /** Can this agent's selected account run right now? A disconnected or
   * expired sign-in fails before any tab exists. */
  agentConnection(agentId: string): { connected: true } | { connected: false; message: string };
  /** Remove a tab this service created whose agent never connected. */
  removeChat(chatId: string): Promise<void>;
}

export const LOCAL_NOTE_PREFIX = "[Zeros]";
