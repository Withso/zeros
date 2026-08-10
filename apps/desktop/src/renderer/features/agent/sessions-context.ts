// ──────────────────────────────────────────────────────────
// sessions-context — actions context shared between provider + hooks
// ──────────────────────────────────────────────────────────
//
// Vite Fast Refresh requires that a `.tsx` file with a
// component export ONLY export components (and type-only exports).
// Mixing the `<AgentSessionsProvider>` component with the
// `useChatSession`/`useAgentSessions` hooks in the same file forced
// a full page reload on every edit instead of a hot-swap.
//
// The fix is to extract the Context object and the actions interface
// into this plain `.ts` module. Provider creates+populates the Context
// from here; hooks read from here. Both files now have a clean Fast
// Refresh boundary (provider = component-only, hooks = hooks-only).
// ──────────────────────────────────────────────────────────

import { createContext } from "react";
import type {
  ContentBlock,
  InitializeResponse,
  QuestionResponse,
  RequestPermissionResponse,
} from "../../platform/bridge/agent-events";
import type { ListSessionsResponse } from "../../platform/bridge/agent-events";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import type {
  AgentSessionState,
  StartSessionOptions,
} from "./use-agent-session";

/** Options accepted by `ensureSession`/`loadIntoChat`. Extends the
 *  base `StartSessionOptions` with chat-scoped fields the provider
 *  needs (cwd, force-restart). */
export interface StartForChatOptions extends StartSessionOptions {
  /** Absolute path the agent subprocess should use as cwd. */
  cwd?: string;
  /** Provider-native durable resume handle (Codex app-server thread id). */
  nativeSessionId?: string;
  /** Force a fresh session even when one is already ready. Used when
   *  the user changes model/effort. */
  force?: boolean;
}

/** Full replacement payload for a still-queued send — the same pieces
 *  `sendPrompt` takes (minus chatId), built by the composer's edit flow so a
 *  queued-message edit goes through the exact send pipeline (mention
 *  expansion, attachment blocks, bubble segments). */
export interface QueuedEditPayload {
  /** Wire text (mentions expanded). */
  text: string;
  /** What the bubble shows (mention TOKENS, not their expansion).
   *  Defaults to `text`. */
  displayText?: string;
  /** Protocol content blocks appended after the text block (images /
   *  file references). */
  attachments?: ContentBlock[];
  bubbleAttachments?: import("./use-agent-session").AgentTextMessageAttachment[];
  segments?: import("./use-agent-session").MessageContentSegment[];
}

/** Bridge-connected actions. The context value contains ONLY these —
 *  no session data — so the value is stable and downstream consumers
 *  using `useContext(ActionsCtx)` don't re-render on every token. */
export interface SessionsActions {
  getSession(chatId: string): AgentSessionState | undefined;
  listAgents(force?: boolean): Promise<BridgeRegistryAgent[]>;
  initAgent(agentId: string): Promise<InitializeResponse>;
  ensureSession(
    chatId: string,
    agentId: string,
    options?: StartForChatOptions,
  ): Promise<void>;
  sendPrompt(
    chatId: string,
    text: string,
    displayText?: string,
    attachments?: ContentBlock[],
    /** Metadata stamped on the user-message bubble so the timeline shows the
     *  same chip row the user saw
     *  in the composer. Optional — callers without attachments
     *  omit it. */
    bubbleAttachments?: import("./use-agent-session").AgentTextMessageAttachment[],
    /** Ordered composer content (text + inline pills) for the sent bubble. */
    segments?: import("./use-agent-session").MessageContentSegment[],
    /** Set when Zeros auto-sends this prompt on the user's behalf (PR island
     *  buttons) — the action kind stamped on the user bubble so it renders
     *  with the "sent by Zeros" treatment (icon + brown bubble, copy-only). */
    autoAction?: string,
  ): Promise<void>;
  cancel(chatId: string): Promise<void>;
  /** Stop one background task while leaving the foreground turn and sibling
   * tasks alone. Fire-and-forget; the next provider snapshot removes it. */
  stopBackgroundTask(chatId: string, taskId: string): void;
  respondToPermission(
    chatId: string,
    response: RequestPermissionResponse,
  ): void;
  respondToQuestion(chatId: string, response: QuestionResponse): void;
  setMode(chatId: string, modeId: string): Promise<void>;
  /** Change a live session's model without rebuilding it. Fire-and-forget:
   *  the chat's persisted model is already updated via the store; this just
   *  applies it to the running session (Claude SDK → query.setModel) so the
   *  change takes effect on the next turn instead of only on a rebuild. */
  setModel(chatId: string, model: string): void;
  /** Run a real context compaction on the live session through
   *  Codex `thread/compact/start`). Fire-and-forget: progress streams back
   *  as the agent's contextCompaction item (the two-state transcript row).
   *  Triggered by `/compact` in a Codex chat and the gauge's Compact now. */
  compactContext(chatId: string): void;
  /** Apply a live session's config change (effort / fast / ultracode /
   *  additionalDirectories / allow-deny / maxTurns) without rebuilding it.
   *  Fire-and-forget: the chat's persisted config is already updated via the
   *  store; this just applies the full composer env to the running session so
   *  the change takes effect on the next turn instead of only on a rebuild. */
  updateConfig(chatId: string): void;
  /** Drop a still-pending queued send (by its placeholder message id) and
   *  remove its greyed bubble, before it flushes. */
  removeQueued(chatId: string, messageId: string): void;
  /** Replace a still-pending queued send's payload in place (before it
   *  flushes). Updates both the queued bubble and the prompt that will be
   *  sent. The payload is built by the composer's normal send pipeline
   *  (wire text with mentions expanded + display text + attachments), so
   *  editing mention-bearing sends is safe. */
  editQueued(
    chatId: string,
    messageId: string,
    payload: QueuedEditPayload,
  ): void;
  /** "Send now" for a queued message. While a turn is RUNNING and the agent
   *  supports steering, injects it into the running turn (AGENT_STEER) and
   *  promotes its bubble into the transcript; while idle (queue parked),
   *  flushes it out of FIFO order as a normal send. Resolves false when the
   *  steer was refused/failed — the message then STAYS queued. */
  steerQueued(chatId: string, messageId: string): Promise<boolean>;
  /** Park the send queue (the user is editing a queued message): a turn
   *  completing while held leaves the queue in place instead of draining it,
   *  so the edit target can't be yanked mid-edit. */
  holdQueue(chatId: string): void;
  /** Release a `holdQueue` park and drain the next queued send if the chat
   *  is idle+ready. Idempotent. */
  releaseQueue(chatId: string): void;
  reset(chatId: string): void;
  listSessionsFor(
    agentId: string,
    opts?: { cwd?: string; cursor?: string | null },
  ): Promise<ListSessionsResponse>;
  loadIntoChat(
    chatId: string,
    agentId: string,
    sessionId: string,
    options?: StartForChatOptions,
  ): Promise<void>;
  /** Load an explicitly cold transcript from disk. Idempotent and shared per
   *  exact chat; resident slots only receive a background reconcile, while a
   *  retained cold slot publishes `loading` until its authoritative window is
   *  ready. */
  hydrateChat(chatId: string): Promise<void>;
  /** Publish the exact bounded chat-view deck after React commits it. Slots
   *  outside this set may release only their heavyweight transcript payload;
   *  live session routing and control state remain resident. */
  setRetainedChatIds(chatIds: readonly string[]): void;
  /** Tell the engine to tear down this chat's session (subprocess /
   *  server child / hook token / session dir) because its tab is being
   *  closed/archived. Fire-and-forget; the on-disk transcript is kept, so
   *  reopening the chat re-resumes via loadSession. Safe to call for a
   *  chat with no live session (no-op). */
  closeSession(chatId: string): void;
  disposeAll(): void;
}

/** Public alias for the context type — kept under its old name so
 *  `useAgentSessions(): SessionsCtx` consumers don't need to update. */
export type SessionsCtx = SessionsActions;

/** Internal React context. The provider sets the value; hooks
 *  consume it. Null when used outside the provider — hooks throw. */
export const ActionsCtx = createContext<SessionsActions | null>(null);
