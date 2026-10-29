import { trackAgentTurnUsage } from "@/renderer/platform/observability/analytics/agent-events";
import { turnRowCache, turnRowKey } from "@/renderer/state/read-caches";
// Per-chat session slots in Zustand, so a subscriber re-renders only when its
// own slice changes: chat A's stream never re-renders chat B. Bridge actions
// (sendPrompt, ensureSession) live in AgentSessionsProvider.

import {
  agentActivity,
  agentExecutionActivity,
  chatAgentActivity,
  chatWorkingActivity,
  combinedAgentActivity,
  workingActivity,
  type AgentActivity,
} from "./agent-activity";
import { create } from "zustand";
import { shallow } from "zustand/shallow";
import type {
  AvailableCommand,
  AvailableSubagent,
  BackgroundTask,
  QuestionOutcome,
  QuestionRequest,
  RequestPermissionRequest,
  SessionNotification,
  WorkflowProgress,
} from "../../platform/bridge/agent-events";
import {
  applyUpdate,
  BLANK_USAGE,
  type AgentMessage,
  type AgentTextMessage,
  type AgentSessionState,
  type AgentUsage,
  type PendingPermission,
  type SessionStatus,
} from "./use-agent-session";
import { saveScrollPosition } from "./device-local";
import {
  sameChatScrollPosition,
  type ChatScrollPosition,
} from "./chat-scroll-anchor";
import { isPlanReviewRequest } from "./renderers/plan-body";
import { retainMessageReferences } from "./message-persistence-tracker";
import { settleLeadingPrompt } from "./transcript-leading-prompt";
import { settledTurnStatus } from "./session-reload-lifecycle";
import { loadPolicies, savePolicies, type PolicyRule } from "./policies";
import { effortAdoptedEnvKey } from "./model-catalog";
import { useWorkspaceStore } from "../../state/workspace-store";
import type { ChatEffort } from "../../state/store";
import { sameProviderBinding } from "@zeros/protocol/identities";
import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";
import type { AgentGoal } from "@zeros/protocol/agent-events";
import { isCloudWorkspace, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { cloudPresentationRunning, cloudTurnEnding, cloudTurnStart, withCloudTurnPresentation, type CloudTurnEnding } from "./cloud-turn-presentation";

const MAX_STDERR_LINES = 200;
const MAX_BACKGROUND_TASKS_PER_CHAT = 100;
const MAX_WORKFLOWS_PER_CHAT = 100;
const VALID_CHAT_EFFORTS = new Set<ChatEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
]);

/** Background snapshots cross the JSON bridge, so even an unchanged refresh
 * arrives as fresh objects. Compare the small bounded set before patching the
 * slot to keep hot chat selectors reference-stable. */
function sameBackgroundTasks(
  a: BackgroundTask[],
  b: BackgroundTask[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((task, index) => {
    const other = b[index];
    return (
      task.taskId === other.taskId &&
      task.name === other.name &&
      task.taskType === other.taskType &&
      task.startedAt === other.startedAt &&
      task.updatedAt === other.updatedAt &&
      task.command === other.command &&
      task.summary === other.summary &&
      task.lastToolName === other.lastToolName &&
      task.scheduledFor === other.scheduledFor
    );
  });
}

function sameWorkflows(a: WorkflowProgress[], b: WorkflowProgress[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((workflow, index) => {
    const other = b[index];
    return (
      workflow.taskId === other.taskId &&
      workflow.name === other.name &&
      workflow.status === other.status &&
      workflow.startedAt === other.startedAt &&
      workflow.updatedAt === other.updatedAt &&
      workflow.phases.length === other.phases.length &&
      workflow.phases.every((phase, phaseIndex) => {
        const otherPhase = other.phases[phaseIndex];
        return (
          phase.index === otherPhase.index &&
          phase.title === otherPhase.title &&
          phase.completed === otherPhase.completed &&
          phase.total === otherPhase.total &&
          phase.status === otherPhase.status
        );
      })
    );
  });
}

/** Append a gate to the pending queue in arrival order, except that a real
 *  Allow/Deny gate queues ahead of a pending plan review. Only the head renders,
 *  and a plan review can sit there for minutes while the user refines it; a
 *  real gate behind it would stay invisible until its auto-deny. */
function queuePermission(
  existing: PendingPermission[],
  incoming: PendingPermission,
): PendingPermission[] {
  if (isPlanReviewRequest(incoming.request)) return [...existing, incoming];
  const firstPlanReview = existing.findIndex((pending) =>
    isPlanReviewRequest(pending.request),
  );
  if (firstPlanReview < 0) return [...existing, incoming];
  return [
    ...existing.slice(0, firstPlanReview),
    incoming,
    ...existing.slice(firstPlanReview),
  ];
}

/** Merge the engine's authoritative recent window into a local message list.
 *  Anchor the window by its first id: above the anchor keep scrolled-up
 *  history and let the window own the rest, dropping a remotely truncated
 *  tail; without the anchor, replace wholesale. An empty window is ambiguous
 *  (a clear or a transient empty read), so keep what is there. */
export function mergeWindowedTail(
  current: AgentMessage[],
  windowed: AgentMessage[],
): AgentMessage[] {
  if (windowed.length === 0) return current;
  const anchor = current.findIndex((m) => m.id === windowed[0].id);
  return retainMessageReferences(current, anchor >= 0 ? [...current.slice(0, anchor), ...windowed] : windowed);
}

/** Scroll positions update in memory on every event but persist once per chat
 *  per second of scroll-idle, capturing the final resting position. */
const SCROLL_PERSIST_DEBOUNCE_MS = 1000;
const scrollPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function schedulePersistScrollPosition(
  chatId: string,
  pos: ChatScrollPosition,
): void {
  const existing = scrollPersistTimers.get(chatId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    scrollPersistTimers.delete(chatId);
    saveScrollPosition(chatId, pos);
  }, SCROLL_PERSIST_DEBOUNCE_MS);
  scrollPersistTimers.set(chatId, t);
}

// The question-stamp model lives in @zeros/protocol/agent-messages, where the
// adapters also use it; re-exported for existing import sites.
export {
  buildQuestionStamp,
  readQuestionStamp,
  type QuestionRecordStamp,
} from "@zeros/protocol/agent-messages";
import {
  buildQuestionStamp,
  type QuestionRecordStamp,
} from "@zeros/protocol/agent-messages";

/** Renderer cap on per-chat messages: edit-heavy sessions emit tens of
 *  thousands of deltas. SQLite stays the source of truth; older history loads
 *  through the windowed view. */
export const MAX_MESSAGES_PER_CHAT = 1000;

function capMessages(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= MAX_MESSAGES_PER_CHAT) return messages;
  return messages.slice(-MAX_MESSAGES_PER_CHAT);
}

/** Keep a slot's leading prompt consistent with the front of its window
 *  through every trim, prepend and replacement (transcript-leading-prompt.ts).
 *  `proposed` is an explicit value from a window read; undefined derives it.
 *  Legacy unscoped cloud slots cannot carry one. O(1) unless the front changed. */
function settleSlotLeadingPrompt(
  chatId: string,
  previous: AgentSessionState | undefined,
  next: AgentSessionState,
  proposed: AgentSessionState["leadingPrompt"],
): AgentSessionState {
  if (!parseCloudScopedId(chatId) && isCloudWorkspace(next.cwd)) {
    return next.leadingPrompt == null ? next : { ...next, leadingPrompt: null };
  }
  const leadingPrompt = settleLeadingPrompt(
    previous?.messages ?? [],
    previous?.leadingPrompt,
    next.messages,
    proposed,
  );
  return (next.leadingPrompt ?? null) === leadingPrompt
    ? next
    : { ...next, leadingPrompt };
}

function hasDurableMessages(messages: AgentMessage[]): boolean {
  return messages.some((message) => message.kind !== "text" || !message.queued);
}

function isLocalSessionSlot(chatId: string, slot: AgentSessionState): boolean {
  return !!slot.cwd && !isCloudWorkspace(slot.cwd) && !parseCloudScopedId(chatId);
}

/** Reattachment is metadata, not proof that a command stopped. Only the Stop
 * observer clears its exact operation; an authoritative successor drops it. */
function settleCloudStop(previous: AgentSessionState | undefined, next: AgentSessionState, reattaching = false): AgentSessionState {
  const sameOwner = isCloudWorkspace(next.cwd) && (!previous || previous.cwd === next.cwd && previous.agentId === next.agentId);
  if (!sameOwner && next.cloudTurnPresentations) next = { ...next, cloudTurnPresentations: undefined };
  if (reattaching && sameOwner && !next.cloudTurnPresentations && previous?.cloudTurnPresentations)
    next = { ...next, cloudTurnPresentations: previous.cloudTurnPresentations };
  if (reattaching && !next.cloudStop && previous?.cloudStop && sameOwner &&
      (!next.foregroundTurnId || next.foregroundTurnId === previous.cloudStop.turnId))
    next = { ...next, cloudStop: previous.cloudStop, foregroundTurnId: previous.foregroundTurnId };
  const stop = next.cloudStop;
  if (!stop) return next;
  if (!sameOwner || stop.turnId !== (next.foregroundTurnId ?? null) || stop.turnId === null && previous &&
      (next.executionId ?? next.sessionId) && (previous.executionId ?? previous.sessionId) &&
      (next.executionId ?? next.sessionId) !== (previous.executionId ?? previous.sessionId))
    return { ...next, cloudStop: undefined };
  if (previous?.cloudStop?.operationId === stop.operationId && next.activeTurnStartedAt === null && previous.activeTurnStartedAt !== null)
    next = { ...next, activeTurnStartedAt: previous.activeTurnStartedAt };
  if (stop.state === "unconfirmed" && previous?.cloudStop?.operationId === stop.operationId && !next.error && previous.error)
    next = { ...next, error: previous.error, failure: previous.failure };
  return next;
}

function retiredCloudStop(state: SessionsStoreState, chatId: string, previous: AgentSessionState | undefined, next: AgentSessionState): Partial<Pick<SessionsStoreState, "cancellingChats">> {
  if (!previous?.cloudStop || next.cloudStop || !state.cancellingChats.has(chatId)) return {};
  const cancellingChats = new Set(state.cancellingChats); cancellingChats.delete(chatId);
  return { cancellingChats };
}

export const BLANK: AgentSessionState = {
  agentId: null,
  agentName: null,
  agentRole: "code",
  designDocumentId: null,
  executionId: null,
  sessionId: null,
  providerBinding: null,
  providerMetadata: null,
  boundary: null,
  boundaryPorts: null,
  cwd: null,
  initialize: null,
  session: null,
  status: "idle",
  transcriptState: "resident",
  transcriptPresentation: null,
  transcriptDirty: false,
  hasTranscript: false,
  messages: [],
  pendingPermission: null,
  pendingPermissions: [],
  pendingQuestions: [],
  stderrLog: [],
  error: null,
  failure: null,
  lastStopReason: null,
  foregroundTurnId: null,
  activeTurnStartedAt: null,
  availableModes: [],
  currentModeId: null,
  usage: BLANK_USAGE,
  availableCommands: [],
  availableSubagents: [],
  backgroundTasks: [],
  backgroundActivity: null,
  workflows: [],
  goal: null,
  safetyReviewRetries: {},
  waitingForBackgroundTasks: false,
  backgroundTasksWaitingSince: null,
};

export interface SessionsStoreState {
  sessions: Record<string, AgentSessionState>;
  warmAgentIds: Set<string>;
  /** executionId → chatId reverse index. Updated atomically with `sessions`
   *  so bridge dispatch stays O(1) and never reads a half-applied state. */
  executionToChatId: Record<string, string>;
  // Live updates can arrive during a slow session load. Never suppress that
  // entire window: adapters reconcile native replay identities, and history
  // hydration reconciles durable row ids in reconcileHistoryMessages. Equal
  // content or tool inputs do not prove that two events are the same call.

  /** Per-chat scroll position, restored when switching between chats. An anchor
   *  turn, offset and at-bottom flag rather than pixels, which drift in the
   *  content-visibility transcript (chat-scroll-anchor.ts). Seeded at boot so
   *  the mount layout effect finds it synchronously. */
  scrollPositions: Record<string, ChatScrollPosition>;

  /** Chats the user just cancelled. The stopped subprocess exits with
   *  AGENT_PROMPT_FAILED; this flag keeps that expected exit from marking the
   *  chat failed. Cleared when the exit arrives. */
  cancellingChats: Set<string>;

  /** chatId → the user-message id of the turn this renderer has in flight.
   *  Top-level, not a slot field, because a mid-send rebuild re-seeds the slot.
   *  Inferring "in flight" from warming status misfired: reopening a chat warms
   *  it too, so a turn stopped before any output was repainted as live. */
  pendingLocalTurns: Record<string, string>;

  /** Per-chat permission policies ("Always allow Bash"), loaded from
   *  localStorage at boot and persisted on every mutation. Newest last. */
  chatPolicies: Record<string, PolicyRule[]>;

  setSession: (chatId: string, slot: AgentSessionState) => void;
  patchSession: (chatId: string, patch: Partial<AgentSessionState>, pendingTurnId?: string | null) => void;
  presentCloudStop: (chatId: string) => AgentSessionState["cloudStop"];
  recordCloudTurnEnd: (chatId: string, turnId: string, ending: Pick<CloudTurnEnding, "status" | "source" | "stopReason">) => void;
  rejectCloudStopPresentation: (chatId: string, operationId: string) => void;
  /** Apply a goal snapshot only while its exact execution still owns the chat.
   * Used by both bridge pushes and awaited goal mutation replies. */
  applyGoalSnapshot: (
    chatId: string,
    executionId: string,
    goal: AgentGoal | null,
  ) => boolean;
  /** Release only the heavyweight transcript payload for a chat that left the
   *  bounded retained-view deck. The live runtime shell and reverse routing
   *  index stay intact so turns, gates and scheduled work keep functioning. */
  evictTranscript: (chatId: string) => void;
  /** Drop the message fromMsgId and every later one from memory, for
   *  click-to-edit. The caller persists the matching SQLite truncation. */
  truncateMessagesFromInMemory: (chatId: string, fromMsgId: string) => void;
  /** Drop only the volatile live session slot. Used when a workspace is
   * archived: transcript linkage, scroll anchor, and policies must survive so
   * restore can resume exactly where the user left off. */
  detachSession: (chatId: string) => void;
  removeSession: (chatId: string) => void;
  setWarmAgent: (agentId: string, warm: boolean) => void;
  setScrollPosition: (chatId: string, pos: ChatScrollPosition) => void;
  /** Replace scrollPositions with the boot-time copy, before any chat mounts. */
  seedScrollPositions: (positions: Record<string, ChatScrollPosition>) => void;
  setCancelling: (chatId: string, value: boolean) => void;
  /** Publish (or clear, with null) the turn this renderer has in flight for a
   *  chat. Called by sendPrompt as it commits the optimistic bubble and again
   *  from its finally, so it is never left set for a settled turn. */
  setPendingLocalTurn: (chatId: string, turnId: string | null) => void;
  clearAll: () => void;

  addPolicy: (chatId: string, rule: PolicyRule) => void;
  /** Reload a chat's policies on open; idempotent. */
  hydrateChatPolicies: (chatId: string) => Promise<void>;

  /** Usage, mode and command updates patch top-level fields; everything else
   *  goes through the messages reducer (applyUpdate). */
  applyBridgeUpdate: (notification: SessionNotification) => void;
  /** Local transcript content already grouped by one provider flush. Controls
   * and cloud notifications keep their individual, ordered reducer path. */
  applyBridgeTranscriptUpdates: (notifications: readonly SessionNotification[]) => void;

  /** Permission requests are routed through the request's sessionId. */
  applyBridgePermissionRequest: (
    agentId: string,
    permissionId: string,
    request: RequestPermissionRequest,
  ) => void;

  /** Settle one queued gate and expose the next head without changing the
   * single-card rendering contract. */
  settlePendingPermission: (chatId: string, permissionId: string) => void;

  /** Drop a plan-review card stranded by a terminal turn (the 30-minute
   *  auto-deny, or a turn that died mid-plan). The gate is already released, so
   *  its buttons would do nothing. Real Allow/Deny gates are left untouched. */
  clearStrandedPlanReview: (chatId: string) => void;

  /** Blocking questions — routed like permissions, but APPENDED to a queue
   *  (never clobber) and deduped on nativeRequestId (SDK replay on reconnect). */
  applyBridgeQuestionRequest: (
    agentId: string,
    questionId: string,
    request: QuestionRequest,
  ) => void;

  /** Stamp the outcome onto the matching tool message so its read-only record
   *  shows ANSWERED (with answers) or SKIPPED. No-op until the message lands. */
  stampQuestionAnswer: (
    chatId: string,
    toolCallId: string,
    stamp: QuestionRecordStamp,
  ) => void;

  /** Remove a question's resolution stamp (the answer-ack watchdog re-queues
   *  an undelivered answer — the premature ANSWERED record must return to
   *  AWAITING). Matches by toolCallId OR nativeToolCallId like the stamper. */
  clearQuestionStamp: (chatId: string, toolCallId: string) => void;

  /** A question settled engine-side (timeout, abort, another client): evict it,
   *  since its resolver is gone, and stamp the outcome. No-op when already
   *  answered here. */
  applyBridgeQuestionSettled: (
    questionId: string,
    outcome: QuestionOutcome,
  ) => void;

  /** Stderr fans out to every chat on this agent — a single subprocess
   *  serves them all and the user could be looking at any of them. */
  applyBridgeStderr: (agentId: string, line: string) => void;

  /** One store update for a buffered burst, in arrival order. Retains exactly
   *  what applying each line with `applyBridgeStderr` would retain. */
  applyBridgeStderrLines: (
    entries: ReadonlyArray<{ agentId: string; line: string }>,
  ) => void;

  /** The subprocess exited: non-terminal chats on the agent flip to
   *  reconnecting so the next user action rebuilds; no auto-retry, which looped
   *  forever before. sessionId scopes it to one chat (Codex runs a child per
   *  chat) without cooling the agent. */
  applyBridgeAgentExit: (agentId: string, sessionId?: string | null) => void;

  /** Apply an exact execution-boundary update. A revoked boundary is stronger
   *  than a generic subprocess-exit hint: it invalidates the route even while
   *  a turn or bind is active, while preserving the durable provider identity
   *  needed to resume the conversation on a replacement execution. */
  applyBridgeBoundaryStatus: (
    agentId: string,
    executionId: string,
    status: ExecutionBoundaryStatus,
  ) => void;
}

/** Select only Local message reducers; usage, lifecycle and provider controls
 * must remain observable before later events can act on them. */
export function canBatchLocalTranscriptUpdate(state: SessionsStoreState, notification: SessionNotification): boolean {
  const kind = notification.update.sessionUpdate;
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk" && kind !== "tool_call" && kind !== "tool_call_update") return false;
  const chatId = (notification as { chatId?: string }).chatId ??
    state.executionToChatId[notification.executionId ?? notification.sessionId];
  const slot = chatId ? state.sessions[chatId] : undefined;
  return !!slot?.cwd && !isCloudWorkspace(slot.cwd) && !parseCloudScopedId(chatId);
}

function reduceTranscriptUpdate(state: SessionsStoreState, chatId: string, notification: SessionNotification): SessionsStoreState {
  const slot = state.sessions[chatId];
  if (!slot) return state;
  if (slot.transcriptState !== "resident") {
    // Keep evicted transcripts absent; the engine owns their durable content.
    const producesMessage = applyUpdate([], notification).length > 0;
    if (slot.transcriptDirty && (slot.hasTranscript || !producesMessage)) return state;
    return { ...state, sessions: { ...state.sessions, [chatId]: {
      ...slot, transcriptDirty: true, hasTranscript: slot.hasTranscript || producesMessage,
    } } };
  }
  const recordedId = notification.update.sessionUpdate === "user_message_recorded"
    ? notification.update.message?.id : undefined;
  const recordedSignatures = () => {
    const signatures = slot.transcriptContentSignatures;
    if (!recordedId || !signatures || !Object.hasOwn(signatures, recordedId)) return signatures;
    // A cached signature proves only the old row's content. Retire it after
    // a live summary replacement so a lagging mirror cannot restore that row.
    const next = { ...signatures };
    delete next[recordedId];
    return next;
  };
  if (notification.update.sessionUpdate === "user_message_recorded" &&
      slot.leadingPrompt && slot.leadingPrompt.id === recordedId &&
      !slot.messages.some(message => message.id === recordedId)) {
    // A completed cloud turn republishes its opening with the recorded diff.
    // Long turns keep that opening beside the resident window. Folding it
    // into the tail would manufacture a new, empty turn after the answer.
    const [leadingPrompt] = applyUpdate([slot.leadingPrompt], notification);
    if (leadingPrompt === slot.leadingPrompt) return state;
    return { ...state, sessions: { ...state.sessions, [chatId]: {
      ...slot, leadingPrompt: leadingPrompt as AgentTextMessage, transcriptPresentation: null,
      transcriptContentSignatures: recordedSignatures(),
      ...(parseCloudScopedId(chatId) ? { transcriptSource: "worker" as const } : {}),
    } } };
  }
  const updated = applyUpdate(slot.messages, notification);
  const messages = slot.historyExpanded ? updated : capMessages(updated);
  if (messages === slot.messages) return state;
  return { ...state, sessions: { ...state.sessions, [chatId]: settleSlotLeadingPrompt(chatId, slot, {
    ...slot, messages, transcriptPresentation: null,
    transcriptContentSignatures: recordedSignatures(),
    ...(parseCloudScopedId(chatId) ? { transcriptSource: "worker" as const } : {}),
    hasTranscript: slot.hasTranscript || hasDurableMessages(messages),
  }, undefined) } };
}

export const useSessionsStore = create<SessionsStoreState>((set, get) => ({
  sessions: {},
  warmAgentIds: new Set(),
  executionToChatId: {},
  scrollPositions: {},
  cancellingChats: new Set(),
  pendingLocalTurns: {},
  // Load policies eagerly so the first request after boot can auto-respond.
  chatPolicies: loadPolicies().byChat,

  setScrollPosition: (chatId, pos) => {
    // Identity-stable when value unchanged so subscribers (e.g. the
    // sidebar reading the map) don't re-render on every scroll tick.
    set((state) => {
      if (sameChatScrollPosition(state.scrollPositions[chatId], pos)) {
        return state;
      }
      return {
        scrollPositions: { ...state.scrollPositions, [chatId]: pos },
      };
    });
    // Debounced; write errors are swallowed (memory is the truth until restart).
    schedulePersistScrollPosition(chatId, pos);
  },

  seedScrollPositions: (positions) => {
    // Replace, not merge: the SQLite copy is authoritative at boot. Skip an empty
    // map so harnesses keep their seeded state.
    if (Object.keys(positions).length === 0) return;
    set(() => ({ scrollPositions: { ...positions } }));
  },

  setCancelling: (chatId, value) => {
    set((state) => {
      const has = state.cancellingChats.has(chatId);
      if (value === has) return state;
      const next = new Set(state.cancellingChats);
      if (value) next.add(chatId);
      else next.delete(chatId);
      return { cancellingChats: next };
    });
  },

  setPendingLocalTurn: (chatId, turnId) => {
    set((state) => {
      const current = state.pendingLocalTurns[chatId];
      if ((turnId ?? undefined) === current) return state;
      const next = { ...state.pendingLocalTurns };
      if (turnId) next[chatId] = turnId;
      else delete next[chatId];
      return { pendingLocalTurns: next };
    });
  },

  presentCloudStop: (chatId) => {
    let stop: AgentSessionState["cloudStop"];
    set(state => {
      const slot = state.sessions[chatId];
      if (!slot || !isCloudWorkspace(slot.cwd)) return state;
      const turnId = slot.cloudStop?.turnId ?? state.pendingLocalTurns[chatId] ?? slot.cloudOutbox?.pendingId ??
        (cloudTurnEnding(slot) ? null : slot.foregroundTurnId) ??
        slot.cloudOutbox?.rows.find(row => !["completed", "failed", "cancelled", "interrupted"].includes(slot.cloudOutbox?.states[row.id] ?? ""))?.id ?? null;
      if (!turnId && !slot.cloudStop) return state;
      stop = slot.cloudStop ? slot.cloudStop.state === "failed" || slot.cloudStop.state === "unconfirmed"
        ? { ...slot.cloudStop, state: "pending", requestedAt: slot.cloudStop.state === "failed" ? Date.now() : slot.cloudStop.requestedAt, preparing: true }
        : slot.cloudStop : { operationId: crypto.randomUUID(), turnId, state: "pending", requestedAt: Date.now(), preparing: true };
      const cloudTurnPresentations = turnId ? withCloudTurnPresentation(slot.cloudTurnPresentations, turnId, {
        startedAt: cloudTurnStart(slot, turnId), endedAt: stop.requestedAt ?? Date.now(), status: "cancelled", source: "stop",
        stopReason: "cancelled", operationId: stop.operationId,
      }) : slot.cloudTurnPresentations;
      return { sessions: { ...state.sessions, [chatId]: { ...slot, cloudStop: stop, cloudTurnPresentations,
        foregroundTurnId: cloudTurnEnding(slot) ? turnId : slot.foregroundTurnId ?? turnId } },
        pendingLocalTurns: state.pendingLocalTurns[chatId] === turnId ? withoutPendingLocalTurn(state.pendingLocalTurns, chatId) : state.pendingLocalTurns };
    });
    return stop;
  },

  recordCloudTurnEnd: (chatId, turnId, ending) => {
    const slot = get().sessions[chatId];
    if (!slot || !isCloudWorkspace(slot.cwd)) return;
    const cloudTurnPresentations = withCloudTurnPresentation(slot.cloudTurnPresentations, turnId, {
      ...ending, startedAt: cloudTurnStart(slot, turnId), endedAt: Date.now(),
    });
    if (cloudTurnPresentations !== slot.cloudTurnPresentations) get().patchSession(chatId, { cloudTurnPresentations });
  },

  rejectCloudStopPresentation: (chatId, operationId) => {
    const slot = get().sessions[chatId];
    if (!slot || !isCloudWorkspace(slot.cwd) || slot.cloudStop?.operationId !== operationId) return;
    const cloudTurnPresentations = Object.fromEntries(Object.entries(slot.cloudTurnPresentations ?? {}).filter(([, value]) =>
      value.source !== "stop" || value.operationId !== operationId));
    get().patchSession(chatId, { cloudTurnPresentations });
  },

  addPolicy: (chatId, rule) => {
    set((state) => {
      const existing = state.chatPolicies[chatId] ?? [];
      const nextRules = [...existing, rule];
      const nextByChat = { ...state.chatPolicies, [chatId]: nextRules };
      savePolicies({ byChat: nextByChat });
      return { chatPolicies: nextByChat };
    });
  },
  hydrateChatPolicies: async (chatId) => {
    // Re-read on open so a change made in another window since boot is picked up.
    const rules = loadPolicies().byChat[chatId] ?? [];
    set((state) => {
      const previous = state.chatPolicies[chatId] ?? [];
      const unchanged =
        previous.length === rules.length &&
        previous.every(
          (rule, index) =>
            rule.id === rules[index]?.id &&
            rule.decision === rules[index]?.decision &&
            rule.toolKind === rules[index]?.toolKind &&
            rule.toolTitle === rules[index]?.toolTitle &&
            rule.createdAt === rules[index]?.createdAt,
        );
      if (unchanged) return state;
      return { chatPolicies: { ...state.chatPolicies, [chatId]: rules } };
    });
  },
  setSession: (chatId, slot) => {
    set((state) => {
      let normalized =
        !slot.hasTranscript && hasDurableMessages(slot.messages)
          ? { ...slot, hasTranscript: true }
          : slot;
      const executionId = normalized.executionId ?? normalized.sessionId;
      if (
        normalized.executionId !== executionId ||
        normalized.sessionId !== executionId
      ) {
        normalized = { ...normalized, executionId, sessionId: executionId };
      }
      const previous = state.sessions[chatId];
      if (normalized.transcriptSource === undefined && previous?.transcriptSource &&
          previous.cwd === normalized.cwd && previous.messages === normalized.messages)
        normalized = { ...normalized, transcriptSource: previous.transcriptSource };
      if (!Object.hasOwn(slot, "transcriptContentSignatures") && previous?.transcriptContentSignatures &&
          previous.cwd === normalized.cwd && previous.messages === normalized.messages)
        normalized = { ...normalized, transcriptContentSignatures: previous.transcriptContentSignatures };
      if (!normalized.cloudOutbox && previous?.cloudOutbox && isCloudWorkspace(normalized.cwd) &&
          previous.cwd === normalized.cwd && previous.agentId === normalized.agentId)
        normalized = { ...normalized, cloudOutbox: previous.cloudOutbox };
      if (previous && ((previous.executionId ?? previous.sessionId) !== executionId ||
          previous.cwd !== normalized.cwd || previous.agentId !== normalized.agentId) &&
          normalized.foregroundTurnId === previous.foregroundTurnId && normalized.foregroundTurnId !== null)
        normalized = { ...normalized, foregroundTurnId: null };
      if (normalized.transcriptState === "cold" || previous && normalized.messages !== previous.messages &&
          normalized.transcriptPresentation === previous.transcriptPresentation) {
        normalized = { ...normalized, transcriptPresentation: null };
      }
      normalized = settleSlotLeadingPrompt(chatId, previous, normalized, slot.leadingPrompt);
      normalized = settleCloudStop(previous, normalized, true);
      if (
        previous &&
        (previous.executionId ?? previous.sessionId) !== executionId &&
        Object.keys(normalized.safetyReviewRetries).length > 0
      ) {
        normalized = { ...normalized, safetyReviewRetries: {} };
      }
      const local = isLocalSessionSlot(chatId, normalized);
      if (local && previous && previous.cwd === normalized.cwd &&
          previous.agentId === normalized.agentId &&
          (previous.executionId ?? previous.sessionId) === executionId) {
        // Authoritative replacement is low frequency. Reuse equal serialized
        // rows only within the same owner; streaming reducers never do this
        // comparison. Normalization above still owns every lifecycle field.
        const messages = retainMessageReferences(previous.messages, normalized.messages);
        if (messages !== normalized.messages) normalized = { ...normalized, messages };
        if (shallow(previous, normalized)) return state;
      }
      const next = { ...state.sessions, [chatId]: normalized };
      return {
        sessions: next,
        ...retiredCloudStop(state, chatId, previous, normalized),
        executionToChatId: local && previous &&
          (previous.executionId ?? previous.sessionId) === executionId
          ? state.executionToChatId : rebuildIndex(next),
      };
    });
  },

  patchSession: (chatId, patch, pendingTurnId) => {
    set((state) => {
      const existing = state.sessions[chatId] ?? BLANK;
      let normalizedPatch = patch;
      if (patch.messages !== undefined) {
        const hasTranscript =
          existing.hasTranscript || hasDurableMessages(patch.messages);
        normalizedPatch = {
          ...patch,
          hasTranscript,
          // Message mutations made by local UI actions operate on a complete
          // transcript. Bridge deltas for cold/loading slots are handled in
          // applyBridgeUpdate and never reach this path with message arrays.
          transcriptState: patch.transcriptState ?? "resident",
          transcriptPresentation: patch.transcriptPresentation ?? null,
          transcriptDirty: patch.transcriptDirty ?? false,
        };
      }
      let updated = { ...existing, ...normalizedPatch };
      if (updated.transcriptState === "cold") updated = { ...updated, transcriptPresentation: null };
      if (patch.messages !== undefined || patch.leadingPrompt !== undefined) {
        updated = settleSlotLeadingPrompt(chatId, state.sessions[chatId], updated, patch.leadingPrompt);
      }
      const executionId =
        patch.executionId !== undefined
          ? patch.executionId
          : patch.sessionId !== undefined
            ? patch.sessionId
            : (existing.executionId ?? existing.sessionId);
      if (existing.cloudPromptPending && patch.cloudPromptPending === undefined &&
          (!["streaming", "warming", "reconnecting"].includes(updated.status) || existing.cwd !== updated.cwd || existing.agentId !== updated.agentId ||
            (existing.executionId ?? existing.sessionId) !== executionId || existing.foregroundTurnId !== updated.foregroundTurnId))
        updated = { ...updated, cloudPromptPending: false };
      if (
        updated.executionId !== executionId ||
        updated.sessionId !== executionId
      ) {
        updated = { ...updated, executionId, sessionId: executionId };
      }
      // A settled turn retains its identity; a different execution or owner
      // cannot inherit it. Explicit lifecycle/snapshot identity wins.
      if (patch.foregroundTurnId === undefined && updated.foregroundTurnId !== null &&
          ((existing.executionId ?? existing.sessionId) !== executionId ||
            existing.cwd !== updated.cwd || existing.agentId !== updated.agentId))
        updated = { ...updated, foregroundTurnId: null };
      if (
        (existing.executionId ?? existing.sessionId) !== executionId &&
        Object.keys(updated.safetyReviewRetries).length > 0
      ) {
        updated = { ...updated, safetyReviewRetries: {} };
      }
      // Repeated status/metadata writes should not wake transcript consumers.
      // This checks field identity only; no history scan or serialization on
      // the patch path, and an absent slot must still be installed.
      updated = settleCloudStop(existing, updated);
      if (state.sessions[chatId] && isLocalSessionSlot(chatId, updated) && shallow(existing, updated)) return state;
      const next = { ...state.sessions, [chatId]: updated };
      // Only rebuild the reverse index if executionId changed — saves work
      // on the common path (token chunks don't touch routing identity).
      const indexNeedsUpdate = existing.executionId !== updated.executionId;
      return {
        sessions: next,
        ...(pendingTurnId !== undefined ? { pendingLocalTurns: pendingTurnId === null
          ? withoutPendingLocalTurn(state.pendingLocalTurns, chatId)
          : state.pendingLocalTurns[chatId] === pendingTurnId ? state.pendingLocalTurns : { ...state.pendingLocalTurns, [chatId]: pendingTurnId } } : {}),
        ...retiredCloudStop(state, chatId, existing, updated),
        executionToChatId: indexNeedsUpdate
          ? rebuildIndex(next)
          : state.executionToChatId,
      };
    });
  },

  applyGoalSnapshot: (chatId, executionId, goal) => {
    let applied = false;
    set((state) => {
      const slot = state.sessions[chatId];
      if (!slot || (slot.executionId ?? slot.sessionId) !== executionId) {
        return state;
      }
      applied = true;
      if (slot.goal === goal) return state;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [chatId]: { ...slot, goal },
        },
      };
    });
    return applied;
  },

  evictTranscript: (chatId) => {
    set((state) => {
      const slot = state.sessions[chatId];
      if (!slot) return state;
      const hasTranscript =
        slot.hasTranscript || hasDurableMessages(slot.messages);
      if (
        slot.transcriptState === "cold" &&
        slot.messages.length === 0 &&
        slot.stderrLog.length === 0 &&
        slot.historyExpanded !== true &&
        slot.hasTranscript === hasTranscript &&
        !slot.transcriptReadError &&
        !slot.transcriptDirty
      ) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [chatId]: {
            ...slot,
            transcriptState: "cold",
            transcriptReadError: null,
            transcriptPresentation: null,
            transcriptDirty: false,
            hasTranscript,
            messages: [],
            leadingPrompt: null,
            historyExpanded: false,
            stderrLog: [],
          },
        },
      };
    });
  },

  truncateMessagesFromInMemory: (chatId, fromMsgId) => {
    set((state) => {
      const slot = state.sessions[chatId];
      if (!slot) return state;
      // Editing or resetting the turn the window starts inside cuts every
      // resident row: they all follow its off-window opening prompt.
      const cutsLeadingTurn = slot.leadingPrompt?.id === fromMsgId;
      const cutIndex = cutsLeadingTurn
        ? 0
        : slot.messages.findIndex((m) => m.id === fromMsgId);
      if (cutIndex < 0) return state;
      const truncated = slot.messages.slice(0, cutIndex);
      const updated: AgentSessionState = {
        ...slot,
        messages: truncated,
        leadingPrompt: cutsLeadingTurn ? null : slot.leadingPrompt,
        // The pending permission may belong to a removed tool; clear it.
        pendingPermission: null,
        pendingPermissions: [],
      };
      return {
        sessions: { ...state.sessions, [chatId]: updated },
      };
    });
  },

  detachSession: (chatId) => {
    set((state) => {
      if (!(chatId in state.sessions)) return state;
      const sessions = { ...state.sessions };
      delete sessions[chatId];
      const cancellingChats = state.cancellingChats.has(chatId)
        ? new Set(
            [...state.cancellingChats].filter(
              (candidate) => candidate !== chatId,
            ),
          )
        : state.cancellingChats;
      return {
        sessions,
        executionToChatId: rebuildIndex(sessions),
        cancellingChats,
        pendingLocalTurns: withoutPendingLocalTurn(
          state.pendingLocalTurns,
          chatId,
        ),
      };
    });
  },

  removeSession: (chatId) => {
    // Clear the pending scroll-persist timer first, or its UPSERT recreates the
    // row after the chat was removed.
    const pendingTimer = scrollPersistTimers.get(chatId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      scrollPersistTimers.delete(chatId);
    }
    set((state) => {
      if (!(chatId in state.sessions)) return state;
      const next = { ...state.sessions };
      delete next[chatId];
      const nextScroll = { ...state.scrollPositions };
      delete nextScroll[chatId];
      const nextCancelling = state.cancellingChats.has(chatId)
        ? new Set([...state.cancellingChats].filter((id) => id !== chatId))
        : state.cancellingChats;
      return {
        sessions: next,
        executionToChatId: rebuildIndex(next),
        scrollPositions: nextScroll,
        cancellingChats: nextCancelling,
        pendingLocalTurns: withoutPendingLocalTurn(
          state.pendingLocalTurns,
          chatId,
        ),
      };
    });
  },

  setWarmAgent: (agentId, warm) => {
    set((state) => {
      const has = state.warmAgentIds.has(agentId);
      if (warm === has) return state;
      const next = new Set(state.warmAgentIds);
      if (warm) next.add(agentId);
      else next.delete(agentId);
      return { warmAgentIds: next };
    });
  },

  clearAll: () => {
    set({
      sessions: {},
      warmAgentIds: new Set(),
      executionToChatId: {},
      scrollPositions: {},
      cancellingChats: new Set(),
      pendingLocalTurns: {},
    });
  },

  applyBridgeTranscriptUpdates: (notifications) => {
    // The provider partitions at cloud/control boundaries. Recheck here so an
    // accidental mixed caller cannot change the cloud publication contract.
    let pending: SessionNotification[] = [];
    const flush = () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      set((state) => {
        let next = state;
        for (const notification of batch) {
          const chatId = (notification as { chatId?: string }).chatId ??
            next.executionToChatId[notification.executionId ?? notification.sessionId];
          if (chatId) next = reduceTranscriptUpdate(next, chatId, notification);
        }
        return next;
      });
    };
    for (const notification of notifications) {
      if (canBatchLocalTranscriptUpdate(get(), notification)) pending.push(notification);
      else {
        flush();
        get().applyBridgeUpdate(notification);
      }
    }
    flush();
  },

  applyBridgeUpdate: (notification) => {
    // The engine-stamped chatId wins over the executionId→chatId index, which can
    // be stale mid force-respawn or before an agent's executionId is stored.
    // Routing by the index alone silently dropped agent content.
    const chatId =
      (notification as { chatId?: string }).chatId ??
      get().executionToChatId[
        notification.executionId ?? notification.sessionId
      ];
    if (!chatId) return;

    const upd = notification.update as {
      sessionUpdate?: string;
      size?: number;
      used?: number;
      cost?: { totalCostUsd?: number } | null;
      categories?: AgentUsage["categories"];
      currentModeId?: string;
      availableCommands?: AvailableCommand[];
      availableSubagents?: AvailableSubagent[];
      tasks?: BackgroundTask[];
      workflows?: WorkflowProgress[];
      waiting?: boolean;
      activity?: AgentSessionState["backgroundActivity"];
      state?: "running" | "completed" | "failed" | "cancelled";
      turnId?: string;
      stopReason?: AgentSessionState["lastStopReason"];
      startedAt?: number;
      effort?: string;
      providerBinding?: import("@zeros/protocol/identities").ProviderBinding;
      providerMetadata?: import("@zeros/protocol/identities").ProviderMetadata;
      resumedFresh?: boolean;
      goal?: import("@zeros/protocol/agent-events").AgentGoal | null;
      toolCallId?: string;
      retryId?: string | null;
    };

    if (
      upd.sessionUpdate === "provider_binding_update" &&
      upd.providerBinding
    ) {
      const slot = get().sessions[chatId];
      const currentExecution = slot?.executionId ?? slot?.sessionId;
      const sourceExecution =
        notification.executionId ?? notification.sessionId;
      if (
        !slot ||
        currentExecution !== sourceExecution ||
        upd.providerBinding.providerId !== slot.agentId
      ) {
        return;
      }
      get().patchSession(chatId, {
        providerBinding: upd.providerBinding,
        ...(upd.resumedFresh ? { needsConversationReplay: true } : {}),
        ...(upd.providerMetadata
          ? { providerMetadata: upd.providerMetadata }
          : {}),
      });
      return;
    }

    if (upd.sessionUpdate === "goal_update") {
      get().applyGoalSnapshot(
        chatId,
        notification.executionId ?? notification.sessionId,
        upd.goal ?? null,
      );
      return;
    }

    if (upd.sessionUpdate === "safety_review_retry_available") {
      const sourceExecution =
        notification.executionId ?? notification.sessionId;
      set((state) => {
        const slot = state.sessions[chatId];
        if (
          !slot ||
          (slot.executionId ?? slot.sessionId) !== sourceExecution ||
          typeof upd.toolCallId !== "string" ||
          (typeof upd.retryId !== "string" && upd.retryId !== null)
        ) {
          return state;
        }
        const current = slot.safetyReviewRetries[upd.toolCallId];
        if (
          (upd.retryId === null && current === undefined) ||
          current === upd.retryId
        ) {
          return state;
        }
        const safetyReviewRetries = { ...slot.safetyReviewRetries };
        if (upd.retryId === null) delete safetyReviewRetries[upd.toolCallId];
        else safetyReviewRetries[upd.toolCallId] = upd.retryId;
        return {
          sessions: {
            ...state.sessions,
            [chatId]: { ...slot, safetyReviewRetries },
          },
        };
      });
      return;
    }

    if (
      upd.sessionUpdate === "provider_binding_detached" &&
      upd.providerBinding
    ) {
      const slot = get().sessions[chatId];
      const currentExecution = slot?.executionId ?? slot?.sessionId;
      const sourceExecution =
        notification.executionId ?? notification.sessionId;
      if (
        !slot ||
        currentExecution !== sourceExecution ||
        upd.providerBinding.providerId !== slot.agentId ||
        !sameProviderBinding(slot.providerBinding, upd.providerBinding)
      ) {
        return;
      }
      get().patchSession(chatId, {
        providerBinding: null,
        providerMetadata: null,
      });
      return;
    }

    // Lifecycle is exact-session state. Content may legitimately arrive with
    // an engine-stamped chatId during a bind race, but a terminal event from a
    // superseded session must never settle the replacement session.
    if (upd.sessionUpdate === "turn_state" && upd.state) {
      const slot = get().sessions[chatId];
      const pendingTurn = get().pendingLocalTurns[chatId];
      if (!slot || (slot.executionId ?? slot.sessionId) !== (notification.executionId ?? notification.sessionId)) return;
      if (
        (pendingTurn && upd.turnId && pendingTurn !== upd.turnId) ||
        (slot.cloudPromptPending && slot.foregroundTurnId !== upd.turnId) ||
        // Adopted turns have no local prompt RPC. An old completion on the
        // same route cannot settle their successor, even after it finishes.
        (upd.state !== "running" && !pendingTurn && slot.foregroundTurnId && slot.foregroundTurnId !== upd.turnId)
      ) {
        // A newly queued prompt owns the next indicator, not the predecessor's
        // result. Retain that exact ending without changing the active route.
        if (upd.state !== "running" && upd.turnId && slot.cloudTurnPresentations?.[upd.turnId]) {
          get().recordCloudTurnEnd(chatId, upd.turnId, { source: "native", status: upd.state,
            stopReason: upd.state === "cancelled" ? "cancelled" : upd.stopReason });
        }
        return;
      }
      if (upd.state === "running") {
        // Late native running snapshots still reconcile content on this route,
        // but cannot reopen an exact turn whose UI has ended.
        if (cloudTurnEnding(slot, upd.turnId)) return;
        const engineStartedAt =
          typeof upd.startedAt === "number" &&
          Number.isFinite(upd.startedAt) &&
          upd.startedAt >= 0
            ? upd.startedAt
            : null;
        get().patchSession(chatId, {
          status: "streaming",
          error: null,
          failure: null,
          lastStopReason: null,
          foregroundTurnId: upd.turnId ?? slot.foregroundTurnId,
          ...(slot.cloudPromptPending ? { cloudPromptPending: false } : {}),
          // A local send starts this clock before admission. Lifecycle updates may move
          // the start earlier, never later, or the timer visibly resets.
          activeTurnStartedAt:
            (slot.foregroundTurnId && slot.foregroundTurnId !== upd.turnId && !pendingTurn) || slot.activeTurnStartedAt == null
              ? engineStartedAt
              : engineStartedAt == null
                ? slot.activeTurnStartedAt
                : Math.min(slot.activeTurnStartedAt, engineStartedAt),
        });
      } else {
        const terminalState = upd.state;
        set(state => ({
          sessions: {
            ...state.sessions,
            [chatId]: {
              ...slot,
              // Keep an already classified failure. A re-adopted terminal
              // turn without a live failure settles to ready; its durable
              // turn row supplies the saved stopped/failed presentation.
              status: settledTurnStatus(slot),
              lastStopReason:
                upd.state === "cancelled" ? "cancelled" : (upd.stopReason ?? null),
              foregroundTurnId: upd.turnId ?? slot.foregroundTurnId,
              ...(slot.cloudPromptPending ? { cloudPromptPending: false } : {}),
              activeTurnStartedAt: slot.cloudStop ? slot.activeTurnStartedAt : null,
              ...(isCloudWorkspace(slot.cwd) && upd.turnId ? { cloudTurnPresentations: withCloudTurnPresentation(slot.cloudTurnPresentations, upd.turnId, {
                startedAt: cloudTurnStart(slot, upd.turnId), endedAt: Date.now(), status: terminalState,
                source: "native", stopReason: upd.state === "cancelled" ? "cancelled" : upd.stopReason,
              }) } : {}),
            },
          },
          // Cloud retirement and its durable receipt can outlast the turn. Clear this
          // exact presentation owner on terminal state, so a finished answer stops
          // reading as running; an older turn cannot release a newer send.
          pendingLocalTurns: state.pendingLocalTurns[chatId] === upd.turnId
            ? withoutPendingLocalTurn(state.pendingLocalTurns, chatId)
            : state.pendingLocalTurns,
        }));
      }
      return;
    }

    if (notification.update.sessionUpdate === "turn_usage_update") {
      const slot = get().sessions[chatId];
      if (!slot || (slot.executionId ?? slot.sessionId) !== (notification.executionId ?? notification.sessionId)) return;
      // Persisted before delivery by the engine. Invalidate this key only;
      // retained confirmed data stays visible while it revalidates.
      turnRowCache.invalidate(turnRowKey(chatId, notification.update.turnId));
      if (slot.agentId) trackAgentTurnUsage({ executionId: notification.executionId ?? notification.sessionId,
        turnId: notification.update.turnId, agentId: slot.agentId, usage: notification.update.usage });
      return;
    }

    // Context snapshots belong to an execution, even when the engine routes
    // them by durable chatId. A retired execution cannot update its replacement
    // or an unbound slot. Retain confirmed fields for partial refreshes.
    if (upd.sessionUpdate === "usage_update") {
      set((state) => {
        const slot = state.sessions[chatId];
        if (!slot || (slot.executionId ?? slot.sessionId) !==
          (notification.executionId ?? notification.sessionId)) return state;
        const nextUsage: AgentUsage = {
          ...slot.usage,
          size: typeof upd.size === "number" ? upd.size : slot.usage.size,
          used: typeof upd.used === "number" ? upd.used : slot.usage.used,
          costUsd:
            typeof upd.cost?.totalCostUsd === "number"
              ? upd.cost.totalCostUsd
              : slot.usage.costUsd,
          // Omitted = partial update; [] explicitly clears an old breakdown.
          categories: upd.categories ?? slot.usage.categories,
        };
        const previousCategories = slot.usage.categories;
        if (
          nextUsage.categories && previousCategories &&
          nextUsage.categories.length === previousCategories.length &&
          nextUsage.categories.every((category, index) =>
            category.name === previousCategories[index].name &&
            category.tokens === previousCategories[index].tokens &&
            category.kind === previousCategories[index].kind &&
            category.id === previousCategories[index].id &&
            (category.mcpServers === previousCategories[index].mcpServers ||
              (category.mcpServers && previousCategories[index].mcpServers &&
                category.mcpServers.length === previousCategories[index].mcpServers.length &&
                category.mcpServers.every((server, serverIndex) =>
                  server.serverName === previousCategories[index].mcpServers![serverIndex].serverName &&
                  server.tokens === previousCategories[index].mcpServers![serverIndex].tokens))))
        ) nextUsage.categories = previousCategories;
        if (
          nextUsage.size === slot.usage.size && nextUsage.used === slot.usage.used &&
          nextUsage.costUsd === slot.usage.costUsd &&
          nextUsage.categories === slot.usage.categories
        ) return state;
        return {
          sessions: {
            ...state.sessions,
            [chatId]: { ...slot, usage: nextUsage },
          },
        };
      });
      return;
    }

    if (upd.sessionUpdate === "current_mode_update" && upd.currentModeId) {
      get().patchSession(chatId, { currentModeId: upd.currentModeId });
      return;
    }

    if (notification.update.sessionUpdate === "current_model_update") {
      const upd = notification.update;
      const slot = get().sessions[chatId];
      if (!slot || (slot.executionId ?? slot.sessionId) !== (notification.executionId ?? notification.sessionId) ||
          typeof upd.model !== "string" || !upd.model || upd.model.length > 200 || (/\s/.test(upd.model) || [...upd.model].some((char) => char.charCodeAt(0) < 32)) ||
          !Number.isFinite(upd.turnStartedAt) || (slot.modelSelectionRevision ?? 0) !== (slot.modelSelectionRevisionAtRequest ?? 0)) return;
      const workspace = useWorkspaceStore.getState();
      const chat = workspace.chats.find((c) => c.id === chatId);
      if (!chat || chat.agentId !== slot.agentId || (chat.model && chat.model !== upd.model && chat.model !== upd.previousModel)) return;
      // This is a provider fact for one chat, never a user preference/global
      // default. The adapter has already adopted it for the next queued send.
      if (chat.model !== upd.model) workspace.dispatch({ type: "UPDATE_CHAT_SETTINGS", id: chatId, updates: { model: upd.model } });
      if (slot.appliedChatEnvKey) {
        try {
          const env = JSON.parse(slot.appliedChatEnvKey) as Record<string, string>;
          const key = slot.agentId?.includes("claude") ? "ANTHROPIC_MODEL" : "OPENAI_MODEL";
          if (!env[key] || env[key] === upd.previousModel) {
            env[key] = upd.model;
            get().patchSession(chatId, { appliedChatEnvKey: JSON.stringify(env) });
          }
        } catch { /* Keep a missing/legacy stamp available for reconciliation. */ }
      }
      return;
    }

    if (
      upd.sessionUpdate === "current_effort_update" &&
      typeof upd.effort === "string" &&
      VALID_CHAT_EFFORTS.has(upd.effort as ChatEffort)
    ) {
      const effort = upd.effort as ChatEffort;
      const workspace = useWorkspaceStore.getState();
      const chat = workspace.chats.find((candidate) => candidate.id === chatId);
      if (chat && chat.effort !== effort) {
        // Only the chat snapshot moves: Codex raises its own thread to ultra mid-turn,
        // and writing the model's durable memory would reopen every future chat at
        // that tier and mirror it into settings.toml.
        workspace.dispatch({
          type: "UPDATE_CHAT_SETTINGS",
          id: chatId,
          updates: { effort },
        });
        // The agent already runs at this tier. Advance the slot's applied-env stamp
        // for the effort only, or sendPrompt reads the write above as user drift and
        // close-resumes before the next send.
        const applied = effortAdoptedEnvKey(
          get().sessions[chatId]?.appliedChatEnvKey,
          effort,
        );
        if (applied !== undefined) {
          get().patchSession(chatId, { appliedChatEnvKey: applied });
        }
      }
      return;
    }

    if (
      upd.sessionUpdate === "available_commands_update" &&
      Array.isArray(upd.availableCommands)
    ) {
      get().patchSession(chatId, { availableCommands: upd.availableCommands });
      return;
    }

    if (
      upd.sessionUpdate === "available_subagents_update" &&
      Array.isArray(upd.availableSubagents)
    ) {
      get().patchSession(chatId, {
        availableSubagents: upd.availableSubagents,
      });
      return;
    }

    if (
      upd.sessionUpdate === "background_tasks_update" &&
      Array.isArray(upd.tasks)
    ) {
      const incomingTasks = upd.tasks;
      const waiting = upd.waiting === true && incomingTasks.length > 0;
      set((state) => {
        const slot = state.sessions[chatId];
        if (!slot || (slot.executionId ?? slot.sessionId) !== (notification.executionId ?? notification.sessionId)) return state;
        const tasks = incomingTasks.slice(0, MAX_BACKGROUND_TASKS_PER_CHAT);
        const activity = upd.activity ?? null;
        const waitingSince = waiting
          ? activity?.startedAt ?? slot.activeTurnStartedAt ?? (slot.waitingForBackgroundTasks &&
            typeof slot.backgroundTasksWaitingSince === "number"
            ? slot.backgroundTasksWaitingSince
            : Date.now())
          : null;
        if (
          sameBackgroundTasks(slot.backgroundTasks, tasks) &&
          slot.waitingForBackgroundTasks === waiting &&
          slot.backgroundActivity?.state === activity?.state &&
          slot.backgroundActivity?.startedAt === activity?.startedAt &&
          slot.backgroundTasksWaitingSince === waitingSince
        ) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [chatId]: {
              ...slot,
              backgroundTasks: tasks,
              backgroundActivity: activity,
              waitingForBackgroundTasks: waiting,
              backgroundTasksWaitingSince: waitingSince,
            },
          },
        };
      });
      return;
    }

    if (
      upd.sessionUpdate === "workflow_progress_update" &&
      Array.isArray(upd.workflows)
    ) {
      const incoming = upd.workflows;
      set((state) => {
        const slot = state.sessions[chatId];
        if (!slot || (slot.executionId ?? slot.sessionId) !== (notification.executionId ?? notification.sessionId)) return state;
        const workflows = incoming.slice(0, MAX_WORKFLOWS_PER_CHAT);
        if (sameWorkflows(slot.workflows, workflows)) return state;
        return {
          sessions: {
            ...state.sessions,
            [chatId]: { ...slot, workflows },
          },
        };
      });
      return;
    }

    set((state) => reduceTranscriptUpdate(state, chatId, notification));
  },

  applyBridgePermissionRequest: (agentId, permissionId, request) => {
    const sid = (request as { sessionId?: string }).sessionId;
    const chatId = sid ? get().executionToChatId[sid] : undefined;
    if (!chatId) return;
    const slot = get().sessions[chatId];
    if (!slot) return;
    const existing =
      slot.pendingPermissions.length > 0
        ? slot.pendingPermissions
        : slot.pendingPermission
          ? [slot.pendingPermission]
          : [];
    if (existing.some((pending) => pending.permissionId === permissionId)) {
      return;
    }
    const nativeDuplicateIndex =
      request.nativeRequestId === undefined
        ? -1
        : existing.findIndex(
            (pending) =>
              pending.request.nativeRequestId === request.nativeRequestId,
          );
    if (nativeDuplicateIndex >= 0) {
      // A rebuilt SDK re-arms the same vendor request under a fresh local id: keep
      // its queue position but adopt the live resolver id. Vendor ids are unique per
      // parked request, so this collapses only replays.
      const pendingPermissions = existing.map((pending, index) =>
        index === nativeDuplicateIndex
          ? { agentId, permissionId, request }
          : pending,
      );
      get().patchSession(chatId, {
        pendingPermissions,
        pendingPermission: pendingPermissions[0] ?? null,
      });
      return;
    }
    const pendingPermissions = queuePermission(existing, {
      agentId,
      permissionId,
      request,
    });
    get().patchSession(chatId, {
      pendingPermissions,
      pendingPermission: pendingPermissions[0] ?? null,
    });
  },

  settlePendingPermission: (chatId, permissionId) => {
    const slot = get().sessions[chatId];
    if (!slot) return;
    const existing =
      slot.pendingPermissions.length > 0
        ? slot.pendingPermissions
        : slot.pendingPermission
          ? [slot.pendingPermission]
          : [];
    const pendingPermissions = existing.filter(
      (pending) => pending.permissionId !== permissionId,
    );
    if (pendingPermissions.length === existing.length) return;
    get().patchSession(chatId, {
      pendingPermissions,
      pendingPermission: pendingPermissions[0] ?? null,
    });
  },

  clearStrandedPlanReview: (chatId) => {
    const slot = get().sessions[chatId];
    if (!slot) return;
    // A plan review is no longer guaranteed to be the head — a real Allow/Deny
    // gate queues ahead of it (see queuePermission) — so settle it wherever in
    // the queue it sits.
    const queued =
      slot.pendingPermissions.length > 0
        ? slot.pendingPermissions
        : slot.pendingPermission
          ? [slot.pendingPermission]
          : [];
    for (const pending of queued) {
      if (isPlanReviewRequest(pending.request)) {
        get().settlePendingPermission(chatId, pending.permissionId);
      }
    }
  },

  applyBridgeQuestionRequest: (agentId, questionId, request) => {
    const sid = (request as { sessionId?: string }).sessionId;
    const chatId = sid ? get().executionToChatId[sid] : undefined;
    if (!chatId) return;
    const slot = get().sessions[chatId];
    if (!slot) return;
    // Dedupe on nativeRequestId (the SDK re-arms on reconnect under a fresh
    // questionId) and questionId; append, never clobber.
    const existing = slot.pendingQuestions ?? [];
    const dupe = existing.some(
      (q) =>
        q.questionId === questionId ||
        q.request.nativeRequestId === request.nativeRequestId,
    );
    if (dupe) return;
    const next = [...existing, { agentId, questionId, request }];
    // Preserve FIFO within each class; an optional question cannot conceal a
    // parked provider request that the running turn needs answered.
    next.sort((a, b) => Number(b.request.blocking) - Number(a.request.blocking));
    get().patchSession(chatId, {
      pendingQuestions: next,
    });
  },

  stampQuestionAnswer: (chatId, toolCallId, stamp) => {
    set((state) => {
      const slot = state.sessions[chatId];
      if (!slot) return state;
      let changed = false;
      const messages = slot.messages.map((m) => {
        // `toolCallId` is the VENDOR's id (off the QuestionRequest) — the
        // timeline row carries it as nativeToolCallId (translators mint their
        // own toolCallId uuids); match either for adapters where they're one.
        if (
          m.kind === "tool" &&
          (m.toolCallId === toolCallId ||
            (m as { nativeToolCallId?: string }).nativeToolCallId ===
              toolCallId)
        ) {
          changed = true;
          const prev =
            m.rawOutput && typeof m.rawOutput === "object"
              ? (m.rawOutput as Record<string, unknown>)
              : {};
          return { ...m, rawOutput: { ...prev, zerosQuestion: stamp } };
        }
        return m;
      });
      if (!changed) return state;
      return {
        sessions: { ...state.sessions, [chatId]: { ...slot, messages } },
      };
    });
  },

  clearQuestionStamp: (chatId, toolCallId) => {
    set((state) => {
      const slot = state.sessions[chatId];
      if (!slot) return state;
      let changed = false;
      const messages = slot.messages.map((m) => {
        if (
          m.kind === "tool" &&
          (m.toolCallId === toolCallId ||
            (m as { nativeToolCallId?: string }).nativeToolCallId ===
              toolCallId) &&
          m.rawOutput &&
          typeof m.rawOutput === "object" &&
          "zerosQuestion" in (m.rawOutput as Record<string, unknown>)
        ) {
          changed = true;
          const next = { ...(m.rawOutput as Record<string, unknown>) };
          delete next.zerosQuestion;
          return { ...m, rawOutput: next };
        }
        return m;
      });
      if (!changed) return state;
      return {
        sessions: { ...state.sessions, [chatId]: { ...slot, messages } },
      };
    });
  },

  applyBridgeQuestionSettled: (questionId, outcome) => {
    // The settled message routes by sessionId, but the queue entry itself is
    // the truth — scan the slots for whichever chat still holds the id. (One
    // linear scan of open chats; settles are rare.)
    for (const [chatId, slot] of Object.entries(get().sessions)) {
      const entry = slot.pendingQuestions?.find(
        (q) => q.questionId === questionId,
      );
      if (!entry) continue;
      get().patchSession(chatId, {
        pendingQuestions: slot.pendingQuestions.filter(
          (q) => q.questionId !== questionId,
        ),
      });
      const toolCallId = entry.request.toolCallId;
      if (toolCallId) {
        get().stampQuestionAnswer(
          chatId,
          toolCallId,
          buildQuestionStamp(entry.request, outcome),
        );
      }
      return;
    }
  },

  applyBridgeStderr: (agentId, line) => {
    get().applyBridgeStderrLines([{ agentId, line }]);
  },

  applyBridgeStderrLines: (entries) => {
    if (entries.length === 0) return;
    const linesByAgent = new Map<string, string[]>();
    for (const { agentId, line } of entries) {
      const lines = linesByAgent.get(agentId);
      if (lines) lines.push(line);
      else linesByAgent.set(agentId, [line]);
    }
    set((state) => {
      let changed = false;
      const next: Record<string, AgentSessionState> = {};
      for (const [chatId, slot] of Object.entries(state.sessions)) {
        const lines =
          slot.agentId != null && slot.transcriptState === "resident"
            ? linesByAgent.get(slot.agentId)
            : undefined;
        if (lines) {
          next[chatId] = {
            ...slot,
            stderrLog: [...slot.stderrLog, ...lines].slice(-MAX_STDERR_LINES),
          };
          changed = true;
        } else {
          next[chatId] = slot;
        }
      }
      return changed ? { sessions: next } : state;
    });
  },

  applyBridgeBoundaryStatus: (agentId, executionId, status) => {
    set((state) => {
      const chatId = state.executionToChatId[executionId];
      if (!chatId) return state;
      const slot = state.sessions[chatId];
      if (
        !slot ||
        slot.agentId !== agentId ||
        (slot.executionId ?? slot.sessionId) !== executionId
      ) {
        return state;
      }
      if (status.state !== "revoked") {
        if (status.failure === "design-protection-failed") {
          const failure = {
            kind: "design-protection-failed" as const,
            stage: "prompt" as const,
            agentId,
            message:
              "The agent was stopped because Design protection could not be proven.",
          };
          return {
            sessions: {
              ...state.sessions,
              [chatId]: {
                ...slot,
                status: "failed" as SessionStatus,
                error: failure.message,
                failure,
                boundary: status,
                activeTurnStartedAt: null,
                pendingPermission: null,
                pendingPermissions: [],
                pendingQuestions: [],
                backgroundTasks: [],
                backgroundActivity: null,
                workflows: [],
                waitingForBackgroundTasks: false,
                backgroundTasksWaitingSince: null,
              },
            },
            pendingLocalTurns: withoutPendingLocalTurn(
              state.pendingLocalTurns,
              chatId,
            ),
          };
        }
        if (slot.boundary === status) return state;
        return {
          sessions: {
            ...state.sessions,
            [chatId]: { ...slot, boundary: status },
          },
        };
      }

      // Revocation is execution-scoped and authoritative: never keep the route for
      // an active send, or its next prompt targets a removed execution. Keep the
      // conversation state silent re-adoption needs. A cloud route's retained Stop
      // still needs its route and turn until retirement is proved.
      const stoppingCloud = isCloudWorkspace(slot.cwd) && !!slot.cloudStop;
      const terminal =
        slot.status === "failed" || slot.status === "auth-required";
      const sessions = {
        ...state.sessions,
        [chatId]: {
          ...slot,
          status: terminal ? slot.status : ("reconnecting" as SessionStatus),
          error: terminal || stoppingCloud ? slot.error : null,
          failure: terminal || stoppingCloud ? slot.failure : null,
          executionId: stoppingCloud ? slot.executionId : null,
          sessionId: stoppingCloud ? slot.sessionId : null,
          session: stoppingCloud ? slot.session : null,
          boundary: null,
          boundaryPorts: null,
          foregroundTurnId: stoppingCloud ? slot.foregroundTurnId : null,
          activeTurnStartedAt: stoppingCloud ? slot.activeTurnStartedAt : null,
          pendingPermission: null,
          pendingPermissions: [],
          pendingQuestions: [],
          backgroundTasks: [],
          backgroundActivity: null,
          workflows: [],
          waitingForBackgroundTasks: false,
          backgroundTasksWaitingSince: null,
        },
      };
      const cancellingChats = !stoppingCloud && state.cancellingChats.has(chatId)
        ? new Set(
            [...state.cancellingChats].filter(
              (candidate) => candidate !== chatId,
            ),
          )
        : state.cancellingChats;
      return {
        sessions,
        executionToChatId: rebuildIndex(sessions),
        cancellingChats,
        pendingLocalTurns: withoutPendingLocalTurn(
          state.pendingLocalTurns,
          chatId,
        ),
      };
    });
  },

  applyBridgeAgentExit: (agentId, sessionId) => {
    // A per-session exit must not cool the agent; sibling chats stay live.
    if (!sessionId) get().setWarmAgent(agentId, false);
    set((state) => {
      let changed = false;
      const next: Record<string, AgentSessionState> = {};
      for (const [chatId, slot] of Object.entries(state.sessions)) {
        const matches =
          slot.agentId === agentId &&
          (sessionId ? slot.sessionId === sessionId : true);
        if (!matches) {
          next[chatId] = slot;
          continue;
        }
        // Evict a parked question for the dead session regardless of status: its
        // resolver failed with the process, and an answer would go nowhere.
        let cur = slot;
        if ((slot.pendingQuestions?.length ?? 0) > 0) {
          cur = { ...slot, pendingQuestions: [] };
          changed = true;
        }
        // Same for a parked permission gate (including plan review): its resolver died
        // too, and the card would keep concealing the composer.
        if (cur.pendingPermission) {
          cur = {
            ...cur,
            pendingPermission: null,
            pendingPermissions: [],
          };
          changed = true;
        }
        // Task snapshots belong to the exited process; clear them before the
        // activelyDriven branch so dead work cannot stay docked.
        if (
          cur.backgroundTasks.length > 0 ||
          cur.waitingForBackgroundTasks ||
          cur.backgroundTasksWaitingSince !== null ||
          cur.backgroundActivity != null
        ) {
          cur = {
            ...cur,
            backgroundTasks: [],
            backgroundActivity: null,
            waitingForBackgroundTasks: false,
            backgroundTasksWaitingSince: null,
          };
          changed = true;
        }
        if (cur.workflows.length > 0) {
          cur = { ...cur, workflows: [] };
          changed = true;
        }
        // Terminal states (failed / auth-required) already show the user a
        // clear next step — don't downgrade them to a transient blip.
        const terminal =
          cur.status === "failed" || cur.status === "auth-required";
        // A session-scoped crash during a turn or rebuild belongs to the prompt-retry
        // path, which rebuilds and resends; clearing the sessionId would race it.
        const activelyDriven =
          !!sessionId &&
          (cur.status === "streaming" || cur.status === "warming");
        // Native exit can follow turn_state before the paired command
        // retirement. Keep the logical cloud route available for Stop retry.
        const stoppingCloud = isCloudWorkspace(cur.cwd) && !!cur.cloudStop;
        if (terminal || activelyDriven || stoppingCloud) {
          next[chatId] = cur;
          continue;
        }
        changed = true;
        next[chatId] = {
          ...cur,
          status: "reconnecting" as SessionStatus,
          error: null,
          failure: null,
          executionId: null,
          sessionId: null,
          session: null,
          // The boundary belonged to the dead execution, and late publishes for it are
          // now dropped, so a stale snapshot would spin forever. The next create or load
          // repopulates it.
          boundary: null,
          boundaryPorts: null,
          foregroundTurnId: null,
          activeTurnStartedAt: null,
        };
      }
      if (!changed) return state;
      return {
        sessions: next,
        executionToChatId: rebuildIndex(next),
      };
    });
  },
}));

function rebuildIndex(
  sessions: Record<string, AgentSessionState>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [chatId, slot] of Object.entries(sessions)) {
    const executionId = slot.executionId ?? slot.sessionId;
    if (executionId) map[executionId] = chatId;
  }
  return map;
}

/** Identity-stable removal: a chat with no pending local turn returns the same
 *  map, so dropping an unrelated slot never re-renders every transcript. */
function withoutPendingLocalTurn(
  pending: Record<string, string>,
  chatId: string,
): Record<string, string> {
  if (!(chatId in pending)) return pending;
  const next = { ...pending };
  delete next[chatId];
  return next;
}

export function useChatAgentActivity(chatId: string | null | undefined): AgentActivity {
  return useSessionsStore((state) => chatId ? chatAgentActivity(state.sessions[chatId], state.pendingLocalTurns[chatId]) : null);
}

export function useAnyChatAgentActivity(chatIds: readonly string[]): AgentActivity {
  return useSessionsStore((state) => combinedAgentActivity(chatIds.map((id) => agentActivity(state.sessions[id], state.pendingLocalTurns[id]))));
}

/** A chat tab's loader: its agent activity, at rest while the turn is parked
 *  on the user (see parkedOnUser). */
export function useChatWorkingActivity(chatId: string | null | undefined): AgentActivity {
  return useSessionsStore((state) => chatId ? chatWorkingActivity(state.sessions[chatId], state.pendingLocalTurns[chatId]) : null);
}

/** A workspace square's motion: any of its chats working, where a chat parked
 *  on the user counts as resting. */
export function useAnyChatWorkingActivity(chatIds: readonly string[]): AgentActivity {
  return useSessionsStore((state) => combinedAgentActivity(chatIds.map((id) => workingActivity(state.sessions[id], state.pendingLocalTurns[id]))));
}

/** The user-message id of the turn this renderer has in flight, or null. A
 *  primitive, so a transcript re-renders only when its own pending turn
 *  changes. Session status cannot tell a mid-send rebuild from a resume. */
export function usePendingLocalTurnId(
  chatId: string | null | undefined,
): string | null {
  return useSessionsStore((s) =>
    chatId ? (s.pendingLocalTurns[chatId] ?? null) : null,
  );
}

export function useAnyChatStreaming(chatIds: readonly string[]): boolean {
  return useSessionsStore((s) => {
    for (const id of chatIds) {
      if (s.sessions[id]?.status === "streaming") return true;
    }
    return false;
  });
}

/** Execution-safety answer to "is an agent doing work?" Session admission alone
 * is not work: every newly-opened chat warms an execution before the user has
 * sent anything. A live/rebuilding turn, an owned optimistic turn, an active
 * background task, or a running workflow is real work. */
export function agentSessionHasActiveWork(
  slot: AgentSessionState | undefined,
  pendingLocalTurnId: string | null | undefined,
): boolean {
  return agentExecutionActivity(slot, pendingLocalTurnId) !== null;
}

/** Workspace-tab activity indicator. Unlike useAnyChatWorking (a conservative
 * mutation-safety gate), this excludes pristine session warm-up. */
export function useAnyChatAgentWorking(chatIds: readonly string[]): boolean {
  return useSessionsStore((state) => {
    for (const id of chatIds) {
      if (
        agentActivity(
          state.sessions[id],
          state.pendingLocalTurns[id],
        ) !== null
      ) {
        return true;
      }
    }
    return false;
  });
}

/** True if any chat's agent occupies its session (warming, streaming or
 *  reconnecting). PR surfaces park Git-mutating actions while the agent may
 *  still be reshaping the branch. */
export function useAnyChatWorking(chatIds: readonly string[]): boolean {
  return useSessionsStore((s) => {
    for (const id of chatIds) {
      const status = s.sessions[id]?.status;
      if (
        status === "warming" ||
        status === "streaming" ||
        status === "reconnecting" ||
        agentSessionHasActiveWork(s.sessions[id], s.pendingLocalTurns[id])
      ) {
        return true;
      }
    }
    return false;
  });
}

/** Whether this chat presents a running turn. Local keeps its streaming
 *  status; cloud can finish presentation before command retirement. */
export function useChatStreaming(chatId: string | null | undefined): boolean {
  return useSessionsStore((s) => {
    if (!chatId) return false;
    const slot = s.sessions[chatId];
    return (slot && cloudPresentationRunning(slot, s.pendingLocalTurns[chatId])) ?? slot?.status === "streaming";
  });
}

/** What a chat's agent is asking: "plan" (plan review), "input" (a question or
 *  a permission gate), or null (agent-awaiting-indicator.tsx). */
export type ChatAwaitingKind = "plan" | "input" | null;

export function awaitingKindOfSlot(slot: AgentSessionState): ChatAwaitingKind {
  if (slot.pendingQuestions?.some((entry) => entry.request.blocking)) return "input";
  const p = slot.pendingPermission;
  if (p) return isPlanReviewRequest(p.request) ? "plan" : "input";
  // Codex's async questions wait beside a turn that keeps working.
  return slot.pendingQuestions?.length ? "input" : null;
}

export function useChatAwaitingKind(
  chatId: string | null | undefined,
): ChatAwaitingKind {
  return useSessionsStore((s) => {
    if (!chatId) return null;
    const slot = s.sessions[chatId];
    if (!slot) return null;
    return awaitingKindOfSlot(slot);
  });
}

/** Any-chat variant of {@link useChatAwaitingKind} for the sidebar's
 *  workspace rows (a workspace hosts several chats). "input" wins over "plan"
 *  when different chats pend different kinds — the generic marker covers
 *  both, while a clipboard would hide the harder question/permission block. */
export function useAnyChatAwaitingKind(
  chatIds: readonly string[],
): ChatAwaitingKind {
  return useSessionsStore((s) => {
    let kind: ChatAwaitingKind = null;
    for (const id of chatIds) {
      const slot = s.sessions[id];
      if (!slot) continue;
      const k = awaitingKindOfSlot(slot);
      if (k === "input") return "input";
      if (k) kind = k;
    }
    return kind;
  });
}

/** True if any session has work an app restart would interrupt: an open turn,
 *  a send this renderer owns (a cloud send waiting included), or background
 *  tasks and workflows. Warming and reconnecting alone are not work. Both
 *  update surfaces read it before restarting. */
export function anyAgentHasActiveWork(
  state: Pick<SessionsStoreState, "sessions" | "pendingLocalTurns">,
): boolean {
  for (const [chatId, slot] of Object.entries(state.sessions)) {
    if (
      slot.status === "streaming" ||
      // Until dispatch, the queued cloud send exists only in this renderer.
      (slot.cloudSendWait?.state === "waiting" && isCloudWorkspace(slot.cwd)) ||
      agentSessionHasActiveWork(slot, state.pendingLocalTurns[chatId])
    ) {
      return true;
    }
  }
  // A mid-send rebuild re-seeds the slot, but the send is still in flight.
  return Object.values(state.pendingLocalTurns).some(Boolean);
}

/** {@link anyAgentHasActiveWork} as a primitive subscription, stable across
 *  token-chunk churn. */
export function useAnyAgentRunning(): boolean {
  return useSessionsStore(anyAgentHasActiveWork);
}
