// ──────────────────────────────────────────────────────────
// sessions-store — Zustand store for per-chat session slots
// ──────────────────────────────────────────────────────────
//
// Phase 0 step 3 of the chat UI rebuild. Before this, every
// chat lived in a single React useState<Record<chatId, slot>>
// inside <AgentSessionsProvider>. That meant a token arriving
// for chat A re-rendered chat B's MessageView, the sidebar
// row for chat C, and every other consumer of the context.
//
// Zustand inverts that: subscribers pick the slice they care
// about and only re-render when *that slice* changes. The
// per-chat hook (`useChatSession`) now subscribes to one
// `sessions[chatId]` slot via a selector — chat A's stream no
// longer touches chat B.
//
// What lives here:
//   - `sessions`: the chatId-keyed slot map (the one truth)
//   - `warmAgentIds`: set of agent ids the engine confirmed alive
//   - `sessionToChatId`: O(1) reverse index for bridge dispatch
//     (kept in the store so it stays consistent with `sessions`
//     instead of as a separate React ref that can drift)
//   - Pure mutators + bridge-notification reducers
//
// What does NOT live here:
//   - The bridge client (lives in <AgentSessionsProvider>)
//   - Async actions that talk to the bridge (sendPrompt,
//     ensureSession, …) — those need bridge access and stay
//     in the provider as React-callback methods
//
// ──────────────────────────────────────────────────────────

import { create } from "zustand";
import type {
  AvailableCommand,
  AvailableSubagent,
  BackgroundTask,
  QuestionOutcome,
  QuestionRequest,
  RequestPermissionRequest,
  SessionNotification,
} from "../bridge/agent-events";
import {
  applyUpdate,
  BLANK_USAGE,
  type AgentMessage,
  type AgentSessionState,
  type AgentUsage,
  type SessionStatus,
} from "./use-agent-session";
import { saveScrollPosition } from "./device-local";
import {
  sameChatScrollPosition,
  type ChatScrollPosition,
} from "./chat-scroll-anchor";
import { isPlanReviewRequest } from "./renderers/plan-body";
import { loadPolicies, savePolicies, type PolicyRule } from "./policies";

const MAX_STDERR_LINES = 200;
const MAX_BACKGROUND_TASKS_PER_CHAT = 100;

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
      task.lastToolName === other.lastToolName
    );
  });
}

/** Merge the engine's authoritative recent-message window into a local slot's
 *  message list (the cross-device reconcile in <AgentSessionsProvider>).
 *
 *  The window is the canonical most-recent tail. The only reason the local
 *  `current` list can be LONGER is a scroll-up that loaded older history above
 *  the window. We anchor the window by its first id inside `current`:
 *
 *   - anchor found → keep `current` ABOVE the anchor (the scrolled-up history)
 *     and let the window own everything from the anchor down. A remote
 *     truncation returns a shorter (non-empty) window, so the now-stale tail
 *     below the anchor is DROPPED rather than overlaid back in (the cross-device
 *     click-to-edit "stale messages stay visible" bug).
 *   - anchor absent → the window's head isn't loaded here, so it's a full
 *     remote reset; replace wholesale with the window.
 *   - empty window → AMBIGUOUS: a genuine remote clear is indistinguishable
 *     from a transient empty read (older builds returned [] when the bridge
 *     is momentarily unavailable). Don't let that wipe a populated slot — keep
 *     what we have; a real clear reflects on the next full re-hydrate (re-open).
 *
 *  Pure + side-effect-free so it's unit-testable without the provider. */
export function mergeWindowedTail(
  current: AgentMessage[],
  windowed: AgentMessage[],
): AgentMessage[] {
  if (windowed.length === 0) return current;
  const anchor = current.findIndex((m) => m.id === windowed[0].id);
  return anchor >= 0 ? [...current.slice(0, anchor), ...windowed] : windowed;
}

/** Per-chat debounce timers for scroll-position persistence. Scroll
 *  events fire many times per second; we let the in-memory store
 *  update on every event (free) but coalesce writes into one per chat per
 *  second of scroll-idle. The trailing write captures the user's final resting
 *  position. Phase 2 §2.11 closure; device-local since Phase 2c. */
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

// The question-resolution stamp model (QuestionRecordStamp / build / read)
// moved to @zeros/core/agent-messages (2026-07-04): the ADAPTERS now stamp
// the engine-persisted transcript on settle (a synthetic tool_call_update),
// so the engine needs the same builder. Re-exported here so every existing
// sessions-store import site keeps resolving.
export {
  buildQuestionStamp,
  readQuestionStamp,
  type QuestionRecordStamp,
} from "@zeros/core/agent-messages";
import {
  buildQuestionStamp,
  type QuestionRecordStamp,
} from "@zeros/core/agent-messages";

/** Renderer-side cap on per-chat message history. The engine streams
 *  every tool-call delta as a separate notification; long edit-heavy
 *  sessions can produce tens of thousands of entries. We keep the most
 *  recent N so the renderer doesn't grow without bound. Phase 0 step 4
 *  replaces this silent truncation with a SQLite-backed windowed view
 *  so disk is the source of truth and nothing is lost. */
export const MAX_MESSAGES_PER_CHAT = 1000;

function capMessages(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= MAX_MESSAGES_PER_CHAT) return messages;
  return messages.slice(-MAX_MESSAGES_PER_CHAT);
}

export const BLANK: AgentSessionState = {
  agentId: null,
  agentName: null,
  sessionId: null,
  cwd: null,
  initialize: null,
  session: null,
  status: "idle",
  messages: [],
  pendingPermission: null,
  pendingQuestions: [],
  stderrLog: [],
  error: null,
  failure: null,
  lastStopReason: null,
  availableModes: [],
  currentModeId: null,
  usage: BLANK_USAGE,
  availableCommands: [],
  availableSubagents: [],
  backgroundTasks: [],
  waitingForBackgroundTasks: false,
  backgroundTasksWaitingSince: null,
};

export interface SessionsStoreState {
  sessions: Record<string, AgentSessionState>;
  warmAgentIds: Set<string>;
  /** sessionId → chatId reverse index. Updated atomically with `sessions`
   *  so bridge dispatch stays O(1) and never reads a half-applied state. */
  sessionToChatId: Record<string, string>;
  // NOTE (2026-06-08): the `loadInProgress` content-suppression was removed.
  // It existed solely to drop the OLD Claude `history.ts` JSONL transcript
  // replay (`claude -p --resume`) so it wouldn't duplicate the disk hydrate.
  // That adapter is deleted — Claude runs through the Agent SDK now, which
  // keeps the conversation in-process and never re-emits prior turns on
  // resume; NO current adapter (Codex app-server, Cursor) replays on
  // loadSession either. Suppressing the whole load window instead
  // silently swallowed live turns sent during a slow resume (the Cursor
  // "reply shows up later" bug). `dedupeConsecutiveMessages` (in hydrateChat)
  // remains as the net for any legacy on-disk dupes. If a future adapter ever
  // replays on load, re-introduce a gate keyed on a per-adapter capability —
  // not a blanket window.

  /** Per-chat scroll position. Phase 1 §2.5.8: when the user swaps
   *  between parallel agent chats, each chat restores its last scroll
   *  position rather than snapping to bottom. 2026-07-21: the value is a
   *  ChatScrollPosition (anchor turn id + offset + at-bottom flag), not a
   *  bare px — pixel offsets drift in the content-visibility transcript
   *  (see chat-scroll-anchor.ts). Hydrated at app boot via
   *  `seedScrollPositions`, so the layoutEffect on chat mount finds the
   *  durable value synchronously. Writes persist on a 1-second
   *  scroll-idle debounce (see `setScrollPosition`). */
  scrollPositions: Record<string, ChatScrollPosition>;

  /** Chats whose user has just clicked Cancel. The cancel sends a
   *  SIGTERM to the agent subprocess, which exits with code 143;
   *  the engine emits AGENT_PROMPT_FAILED — but that's an *expected*
   *  exit, not a real failure. Without this flag, the cancel path
   *  flips status to "failed" and shows an "agent error" tag, leaving
   *  the user stranded. With it, the prompt-failure handler ignores
   *  the post-cancel exit and the chat stays in "ready" state so the
   *  user can immediately type a new prompt. The flag is cleared
   *  inside the prompt-failure handler when the expected exit arrives. */
  cancellingChats: Set<string>;

  /** Stage 6.2 — per-chat permission policies ("Always allow Bash",
   *  etc.). Loaded from localStorage at boot; kept in memory and
   *  persisted on every mutation. Keys are chat ids; values are
   *  ordered lists (newest last). */
  chatPolicies: Record<string, PolicyRule[]>;

  // ── Pure mutators ───────────────────────────────────────
  setSession: (chatId: string, slot: AgentSessionState) => void;
  patchSession: (chatId: string, patch: Partial<AgentSessionState>) => void;
  /** Phase 2 chat overhaul (2026-05-07): drop the message with
   *  fromMsgId and every later message in this chat from the in-memory
   *  store. Used by the click-to-edit flow before re-sending the edited
   *  prompt. The caller persists the corresponding SQLite truncation
   *  via agent-history-client.truncateMessagesFrom — this is the
   *  in-memory half. No-op when the message id isn't in the slot. */
  truncateMessagesFromInMemory: (chatId: string, fromMsgId: string) => void;
  /** Drop only the volatile live session slot. Used when a workspace is
   * archived: transcript linkage, scroll anchor, and policies must survive so
   * restore can resume exactly where the user left off. */
  detachSession: (chatId: string) => void;
  removeSession: (chatId: string) => void;
  setWarmAgent: (agentId: string, warm: boolean) => void;
  setScrollPosition: (chatId: string, pos: ChatScrollPosition) => void;
  /** Replace the scrollPositions map with the boot-time hydrated copy
   *  from device-local storage. Called once at app start before any chat
   *  mounts so the layoutEffect's `scrollPositions[chatId]` lookup is
   *  populated. */
  seedScrollPositions: (positions: Record<string, ChatScrollPosition>) => void;
  setCancelling: (chatId: string, value: boolean) => void;
  clearAll: () => void;

  // Stage 6.2 — policy mutators.
  addPolicy: (chatId: string, rule: PolicyRule) => void;
  /** Pull the durable copy of a chat's policies from SQLite and
   *  replace the in-memory slice for that chat. Called on chat
   *  open so localStorage's bootstrap data is overlaid with the
   *  authoritative DB rows. Idempotent. */
  hydrateChatPolicies: (chatId: string) => Promise<void>;

  // ── Bridge-notification reducers ────────────────────────
  /** Dispatch a SessionNotification to its chat's slot. Splits on
   *  notification kind: `usage_update`/`current_mode_update`/
   *  `available_commands_update` patch top-level fields; everything else
   *  feeds into the messages reducer (`applyUpdate`). */
  applyBridgeUpdate: (notification: SessionNotification) => void;

  /** Permission requests are routed through the request's sessionId. */
  applyBridgePermissionRequest: (
    agentId: string,
    permissionId: string,
    request: RequestPermissionRequest,
  ) => void;

  /** Drop a STRANDED plan-review card (Claude's ExitPlanMode gate) when its
   *  turn reaches a TERMINAL state with the gate still pending — the adapter's
   *  30-minute auto-deny fired, or the turn died mid-plan. The engine already
   *  released the gate, so the PlanReviewCard's buttons would click into a
   *  resolved gate (a silent no-op) with no way to dismiss the card. Called
   *  from the turn-settle `finally`: clears `pendingPermission` IFF it's a plan
   *  review — a real Allow/Deny gate (which REPLACES the composer) is
   *  deliberately left untouched. No-op in the happy path, where Approve / a
   *  typed follow-up already cleared the gate before the turn settled. */
  clearStrandedPlanReview: (chatId: string) => void;

  /** Blocking questions — routed like permissions, but APPENDED to a queue
   *  (never clobber) and deduped on nativeRequestId (SDK replay on reconnect). */
  applyBridgeQuestionRequest: (
    agentId: string,
    questionId: string,
    request: QuestionRequest,
  ) => void;

  /** Durable question-record: stamp the resolution onto the matching
   *  transcript tool message (by toolCallId) so the read-only record shows
   *  ANSWERED (with the user's per-question answers) or SKIPPED (dismissed /
   *  timed out — the agent proceeded with its default). No-op if the message
   *  isn't found yet. */
  stampQuestionAnswer: (
    chatId: string,
    toolCallId: string,
    stamp: QuestionRecordStamp,
  ) => void;

  /** Remove a question's resolution stamp (the answer-ack watchdog re-queues
   *  an undelivered answer — the premature ANSWERED record must return to
   *  AWAITING). Matches by toolCallId OR nativeToolCallId like the stamper. */
  clearQuestionStamp: (chatId: string, toolCallId: string) => void;

  /** A question settled ENGINE-SIDE (response timeout, turn abort, or another
   *  client answered). Evict it from whichever chat's queue holds it — its
   *  resolver is gone, so a parked card would answer into the void — and stamp
   *  the transcript record with the outcome. No-op when the questionId isn't
   *  queued (the local client already answered it). */
  applyBridgeQuestionSettled: (
    questionId: string,
    outcome: QuestionOutcome,
  ) => void;

  /** Stderr fans out to every chat on this agent — a single subprocess
   *  serves them all and the user could be looking at any of them. */
  applyBridgeStderr: (agentId: string, line: string) => void;

  /** Subprocess exited. Any chat on this agent that wasn't already in a
   *  terminal state flips to `reconnecting` so the next user action can
   *  drive a fresh ensureSession. We do NOT auto-retry — that path
   *  produced eternal "Reconnecting…" bugs in the past.
   *
   *  `sessionId` scopes the exit to ONE chat (Codex runs one app-server
   *  child per chat). When set, only the chat bound to that sessionId
   *  flips — sibling chats on the same agent stay live, and the agent
   *  isn't cooled. When absent, the exit is agent-wide (a shared
   *  subprocess) and every non-terminal chat flips. */
  applyBridgeAgentExit: (agentId: string, sessionId?: string | null) => void;
}

export const useSessionsStore = create<SessionsStoreState>((set, get) => ({
  sessions: {},
  warmAgentIds: new Set(),
  sessionToChatId: {},
  scrollPositions: {},
  cancellingChats: new Set(),
  // Stage 6.2 — load existing policies eagerly so the first permission
  // request after boot can already auto-respond. The doc is small
  // (a few rules per chat) so eager load has no measurable cost.
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
    // Debounced persist — coalesces a fast scroll burst into one write at
    // scroll-idle. Errors are swallowed (in-memory state is the truth
    // until restart). Phase 2 §2.11 closure.
    schedulePersistScrollPosition(chatId, pos);
  },

  seedScrollPositions: (positions) => {
    // Replace, not merge — the SQLite copy is authoritative at boot.
    // No-op when positions is empty so non-Electron harnesses don't
    // wipe any in-memory state seeded by tests.
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

  // ── Stage 6.2: policies (localStorage — device-local since Phase 2c) ──
  addPolicy: (chatId, rule) => {
    set((state) => {
      const existing = state.chatPolicies[chatId] ?? [];
      const nextRules = [...existing, rule];
      const nextByChat = { ...state.chatPolicies, [chatId]: nextRules };
      // Persist on every mutation. The doc is tiny (a few rules per chat) so
      // the localStorage write is cheap enough to skip debouncing.
      savePolicies({ byChat: nextByChat });
      return { chatPolicies: nextByChat };
    });
  },
  hydrateChatPolicies: async (chatId) => {
    // Re-read this chat's rules from localStorage on open, so a change made in
    // another window/tab since boot is picked up. localStorage is the sole store
    // now (Phase 2c dropped the electron/db.ts backstop). Async signature kept
    // for callers.
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
      const next = { ...state.sessions, [chatId]: slot };
      return {
        sessions: next,
        sessionToChatId: rebuildIndex(next),
      };
    });
  },

  patchSession: (chatId, patch) => {
    set((state) => {
      const existing = state.sessions[chatId] ?? BLANK;
      const updated = { ...existing, ...patch };
      const next = { ...state.sessions, [chatId]: updated };
      // Only rebuild the reverse index if sessionId changed — saves work
      // on the common path (token chunks don't touch sessionId).
      const indexNeedsUpdate = existing.sessionId !== updated.sessionId;
      return {
        sessions: next,
        sessionToChatId: indexNeedsUpdate
          ? rebuildIndex(next)
          : state.sessionToChatId,
      };
    });
  },

  truncateMessagesFromInMemory: (chatId, fromMsgId) => {
    set((state) => {
      const slot = state.sessions[chatId];
      if (!slot) return state;
      const cutIndex = slot.messages.findIndex((m) => m.id === fromMsgId);
      if (cutIndex < 0) return state;
      const truncated = slot.messages.slice(0, cutIndex);
      const updated: AgentSessionState = {
        ...slot,
        messages: truncated,
        // Pending permission may have been bound to a tool the user
        // is now removing — clear it so the inline cluster doesn't
        // dangle. Plan stays since the user's intent is "edit this
        // prompt and continue"; the planner can re-emit if needed.
        pendingPermission: null,
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
        sessionToChatId: rebuildIndex(sessions),
        cancellingChats,
      };
    });
  },

  removeSession: (chatId) => {
    // Clear any pending scroll-persist debounce timer first. Otherwise
    // a debounce timer scheduled in the last second writes to a
    // deleted chat_id row (SQLite UPSERT recreates the row) AFTER the
    // user explicitly removed the chat. Cleanup-on-removal closes the
    // race window cleanly.
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
        sessionToChatId: rebuildIndex(next),
        scrollPositions: nextScroll,
        cancellingChats: nextCancelling,
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
      sessionToChatId: {},
      scrollPositions: {},
      cancellingChats: new Set(),
    });
  },

  applyBridgeUpdate: (notification) => {
    // Engine-authoritative chatId (stamped on the notification by the bridge
    // listener) wins over the local sessionId→chatId index, which can be
    // momentarily stale (mid force-respawn the old sessionId is de-indexed
    // before the new one binds; an agent may emit before its sessionId is
    // stored). This is the keystone fix for "messages/tool calls vanish, only
    // mode-switch banners survive": banners are synthesized locally with the
    // live sessionId so they always routed, while agent content arrived on a
    // sessionId the index didn't (yet) know and was silently dropped here.
    const chatId =
      (notification as { chatId?: string }).chatId ??
      get().sessionToChatId[notification.sessionId];
    if (!chatId) return;

    const upd = notification.update as {
      sessionUpdate?: string;
      size?: number;
      used?: number;
      cost?: { totalCostUsd?: number } | null;
      categories?: Array<{ name: string; tokens: number }>;
      currentModeId?: string;
      availableCommands?: AvailableCommand[];
      availableSubagents?: AvailableSubagent[];
      tasks?: BackgroundTask[];
      waiting?: boolean;
    };

    // usage_update → context window accounting. Keep cumulative counters
    // from prompt-response usage; overwrite size/used. Stage 5.2 adds
    // costUsd capture from upd.cost.totalCostUsd.
    if (upd.sessionUpdate === "usage_update") {
      set((state) => {
        const slot = state.sessions[chatId];
        if (!slot) return state;
        const nextUsage: AgentUsage = {
          ...slot.usage,
          size: typeof upd.size === "number" ? upd.size : slot.usage.size,
          used: typeof upd.used === "number" ? upd.used : slot.usage.used,
          costUsd:
            typeof upd.cost?.totalCostUsd === "number"
              ? upd.cost.totalCostUsd
              : slot.usage.costUsd,
          // Breakdown only when the update carries one (Claude) — a
          // categoryless codex update must not wipe a prior breakdown.
          categories: upd.categories ?? slot.usage.categories,
        };
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
        if (!slot) return state;
        const tasks = incomingTasks.slice(0, MAX_BACKGROUND_TASKS_PER_CHAT);
        const waitingSince = waiting
          ? slot.waitingForBackgroundTasks &&
            typeof slot.backgroundTasksWaitingSince === "number"
            ? slot.backgroundTasksWaitingSince
            : Date.now()
          : null;
        if (
          sameBackgroundTasks(slot.backgroundTasks, tasks) &&
          slot.waitingForBackgroundTasks === waiting &&
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
              waitingForBackgroundTasks: waiting,
              backgroundTasksWaitingSince: waitingSince,
            },
          },
        };
      });
      return;
    }

    // Everything else → feed to the messages reducer.
    set((state) => {
      const slot = state.sessions[chatId];
      if (!slot) return state;
      // Cap suspended while the user has paged older history in
      // (historyExpanded) — trimming mid-read would pull the transcript
      // out from under them. agent-chat re-arms the cap at bottom.
      const updated = applyUpdate(slot.messages, notification);
      const nextMessages = slot.historyExpanded
        ? updated
        : capMessages(updated);
      // Reference-equal short-circuit: if applyUpdate returned the same
      // array (no-op for a kind we don't model in messages), avoid the
      // spread to keep selectors stable.
      if (nextMessages === slot.messages) return state;
      return {
        sessions: {
          ...state.sessions,
          [chatId]: { ...slot, messages: nextMessages },
        },
      };
    });
  },

  applyBridgePermissionRequest: (agentId, permissionId, request) => {
    const sid = (request as { sessionId?: string }).sessionId;
    const chatId = sid ? get().sessionToChatId[sid] : undefined;
    if (!chatId) return;
    get().patchSession(chatId, {
      pendingPermission: {
        agentId,
        permissionId,
        request,
      },
    });
  },

  clearStrandedPlanReview: (chatId) => {
    const p = get().sessions[chatId]?.pendingPermission;
    if (p && isPlanReviewRequest(p.request)) {
      get().patchSession(chatId, { pendingPermission: null });
    }
  },

  applyBridgeQuestionRequest: (agentId, questionId, request) => {
    const sid = (request as { sessionId?: string }).sessionId;
    const chatId = sid ? get().sessionToChatId[sid] : undefined;
    if (!chatId) return;
    const slot = get().sessions[chatId];
    if (!slot) return;
    // Dedup on nativeRequestId (SDK re-arms in-flight requests on reconnect and
    // the adapter mints a fresh questionId for the same underlying request), and
    // on questionId itself. APPEND — never clobber a queued question.
    const existing = slot.pendingQuestions ?? [];
    const dupe = existing.some(
      (q) =>
        q.questionId === questionId ||
        q.request.nativeRequestId === request.nativeRequestId,
    );
    if (dupe) return;
    get().patchSession(chatId, {
      pendingQuestions: [...existing, { agentId, questionId, request }],
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
    set((state) => {
      let changed = false;
      const next: Record<string, AgentSessionState> = {};
      for (const [chatId, slot] of Object.entries(state.sessions)) {
        if (slot.agentId === agentId) {
          next[chatId] = {
            ...slot,
            stderrLog: [...slot.stderrLog.slice(-(MAX_STDERR_LINES - 1)), line],
          };
          changed = true;
        } else {
          next[chatId] = slot;
        }
      }
      return changed ? { sessions: next } : state;
    });
  },

  applyBridgeAgentExit: (agentId, sessionId) => {
    // A per-session exit (Codex: one app-server child per chat) must NOT
    // cool the whole agent — sibling chats on the same agent are still
    // live. Only an agent-wide exit (a shared subprocess, no sessionId)
    // marks the pool cold.
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
        // Evict any parked question card for this dead session REGARDLESS of
        // status (even streaming) — a pending card must not outlive the request
        // that spawned it. The engine resolver fails closed on the crash; a
        // stale card would send an answer into a dead session. Runs BEFORE the
        // activelyDriven early-return, which otherwise skips the streaming case.
        let cur = slot;
        if ((slot.pendingQuestions?.length ?? 0) > 0) {
          cur = { ...slot, pendingQuestions: [] };
          changed = true;
        }
        // Same rule for a parked Allow/Deny permission gate (incl. Claude's plan
        // review, which is a pendingPermission): the SDK's canUseTool resolver
        // died with the subprocess, so the card can never resolve — clicking
        // Allow/Deny fires AGENT_PERMISSION_RESPONSE into a dead session (a
        // silent no-op) while the card keeps CONCEALING the composer
        // (permissionCardActive → the composer card is display:none). Left in
        // place it was a second way a crashed/rebuilt chat wedged the composer
        // (the first being the failed-state read-only editor). Evict REGARDLESS
        // of status — mirrors pendingQuestions above — so the composer returns
        // and sendPrompt's rebuild+resend path starts from a clean gate.
        if (cur.pendingPermission) {
          cur = { ...cur, pendingPermission: null };
          changed = true;
        }
        // Active task snapshots are owned by this provider process. Once the
        // process exits they are no longer usable stale-while-revalidate data:
        // no task in that snapshot can still receive progress or a scoped Stop.
        // Clear before the activelyDriven branch too, so a turn-recovery race
        // cannot leave dead work docked while the replacement session warms.
        if (
          cur.backgroundTasks.length > 0 ||
          cur.waitingForBackgroundTasks ||
          cur.backgroundTasksWaitingSince !== null
        ) {
          cur = {
            ...cur,
            backgroundTasks: [],
            waitingForBackgroundTasks: false,
            backgroundTasksWaitingSince: null,
          };
          changed = true;
        }
        // Terminal states (failed / auth-required) already show the user a
        // clear next step — don't downgrade them to a transient blip.
        const terminal =
          cur.status === "failed" || cur.status === "auth-required";
        // A SESSION-SCOPED crash while a turn is in flight (streaming) or a
        // rebuild is warming is already owned by the prompt-retry path: the
        // codex adapter throws a recoverable transport-closed that sendPrompt
        // rebuilds + resends from. Clearing the sessionId here would race
        // that recovery, so leave the actively-driven chat alone. (An
        // agent-wide exit has no in-flight prompt to lean on, so it still
        // flips.)
        const activelyDriven =
          !!sessionId &&
          (cur.status === "streaming" || cur.status === "warming");
        if (terminal || activelyDriven) {
          next[chatId] = cur;
          continue;
        }
        changed = true;
        next[chatId] = {
          ...cur,
          status: "reconnecting" as SessionStatus,
          error: null,
          failure: null,
          sessionId: null,
          session: null,
        };
      }
      if (!changed) return state;
      return {
        sessions: next,
        sessionToChatId: rebuildIndex(next),
      };
    });
  },
}));

function rebuildIndex(
  sessions: Record<string, AgentSessionState>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [chatId, slot] of Object.entries(sessions)) {
    if (slot.sessionId) map[slot.sessionId] = chatId;
  }
  return map;
}

// ──────────────────────────────────────────────────────────
// Selector hooks — preferred over reading the whole store
// ──────────────────────────────────────────────────────────

/** True if ANY chat in the given id list currently has an in-flight
 *  turn (status === "streaming"). Used by Column 1's WorkspaceRow to
 *  swap the GitBranch icon for the ZerosSpinner whenever any agent
 *  bound to a chat in that workspace is actively producing output.
 *
 *  Implementation note: we return a plain boolean (computed inside
 *  the Zustand selector) rather than the full slot list, so tabs
 *  unrelated to the workspace don't trigger re-renders on every
 *  token chunk. Selector identity is stable when the truthy result
 *  doesn't flip — sessions[chatId].status is the only field read,
 *  not the slot reference. */
export function useAnyChatStreaming(chatIds: readonly string[]): boolean {
  return useSessionsStore((s) => {
    for (const id of chatIds) {
      if (s.sessions[id]?.status === "streaming") return true;
    }
    return false;
  });
}

/** True if ANY chat in the given id list has an agent actively occupying its
 *  session — "warming" (a queued prompt is about to run), "streaming" (turn in
 *  flight), or "reconnecting" (respawn reviving an in-flight turn). Broader
 *  than {@link useAnyChatStreaming}: the PR surfaces use it to park their
 *  git-mutating actions (Create PR / Commit-and-push / Merge) while the agent
 *  may still be reshaping the branch — including the warm-up/reconnect windows
 *  where no tokens stream yet but work is committed. Primitive boolean, so the
 *  subscription is stable across token-chunk churn. */
export function useAnyChatWorking(chatIds: readonly string[]): boolean {
  return useSessionsStore((s) => {
    for (const id of chatIds) {
      const status = s.sessions[id]?.status;
      if (
        status === "warming" ||
        status === "streaming" ||
        status === "reconnecting"
      ) {
        return true;
      }
    }
    return false;
  });
}

/** True if THIS chat currently has an in-flight turn (status ===
 *  "streaming"). Mirror of {@link useAnyChatStreaming} for the
 *  single-chat case. Used by the chat-tab row to swap its
 *  AgentIcon for a ZerosSpinner while the agent is producing
 *  output. Returns a primitive boolean so the subscription is
 *  stable across token-chunk churn. */
export function useChatStreaming(chatId: string | null | undefined): boolean {
  return useSessionsStore((s) => {
    if (!chatId) return false;
    return s.sessions[chatId]?.status === "streaming";
  });
}

/** How a chat's agent is PARKED ON THE USER, if at all:
 *    • "plan"  — Claude's plan review pends (ExitPlanMode gate)
 *    • "input" — a blocking question or a regular permission gate pends
 *    • null    — not parked
 *  Column-1 rows and chat tabs swap the working spinner for the matching
 *  glyph (clipboard for plan review, message-circle-question-mark for input)
 *  while this holds. Primitive string|null so the subscription stays stable
 *  across token-chunk churn. */
export type ChatAwaitingKind = "plan" | "input" | null;

function awaitingKindOfSlot(slot: AgentSessionState): ChatAwaitingKind {
  if ((slot.pendingQuestions?.length ?? 0) > 0) return "input";
  const p = slot.pendingPermission;
  if (!p) return null;
  return isPlanReviewRequest(p.request) ? "plan" : "input";
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

/** Any-chat variant of {@link useChatAwaitingKind} for Column 1's
 *  WorkspaceRow (a workspace hosts several chats). "input" wins over "plan"
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

/** True if ANY session across the whole app is actively working — status
 *  "warming" (spinning up), "streaming" (turn in flight), or "reconnecting"
 *  (engine respawn reviving it). Read by app-level chrome (the auto-update
 *  toast) to decide whether to offer "Restart when idle" and to defer the
 *  restart until no agent is mid-turn, so an update never kills in-progress
 *  work. Returns a primitive boolean so the subscription stays stable across
 *  token-chunk churn. */
export function useAnyAgentRunning(): boolean {
  return useSessionsStore((s) => {
    for (const slot of Object.values(s.sessions)) {
      const status = slot.status;
      if (
        status === "warming" ||
        status === "streaming" ||
        status === "reconnecting"
      ) {
        return true;
      }
    }
    return false;
  });
}
