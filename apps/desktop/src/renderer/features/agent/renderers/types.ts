// ──────────────────────────────────────────────────────────
// renderer registry — types
// ──────────────────────────────────────────────────────────
//
// The old MessageView was a
// binary if/else (text vs. tool) which made every new message
// type a fork in agent-chat.tsx. The registry inverts that:
// each message kind is a self-contained renderer, dispatch is
// a table lookup. New tool renderers (bash, edit, read, …) land
// as new files plus a single registry entry — no churn in the
// chat shell, no risk of breaking unrelated paths.
//
// Dispatch axes (in order):
//   1. message.kind            — "text" | "tool" | unknown
//   2. (text)  message.role    — user | agent | thought | system
//   3. (tool)  custom matchers — subagent, plan card, …
//   4. (tool)  tool kind    — read | edit | execute | …
//
// Per-tool-kind renderers are memoized and dispatched through this registry.
//
// ──────────────────────────────────────────────────────────

import type { ComponentType } from "react";
import type { ToolKind } from "../../../platform/bridge/agent-events";
import type {
  AgentMessage,
  AgentMessageRole,
  AgentTextMessage,
  AgentToolMessage,
} from "../use-agent-session";

/** Per-render context shared by every renderer. Passed by the host
 *  (agent-chat) so renderers stay pure — no hooks into store / bridge
 *  inside renderer files. Extend by adding fields here, never by
 *  reaching into globals. */
export interface RendererContext {
  /** True when the session is actively streaming agent output. Renderers
   *  use this for shimmer / live-tick duration / "now" affordances. */
  isStreaming: boolean;
  /** Id of the most recent message in the timeline. Renderers that
   *  need "am I the in-flight message?" compare their own message.id
   *  to this. Stable per render — agent-chat memoizes the context. */
  lastMessageId: string | null;
  /** createdAt of the last user message — i.e. the start of the
   *  currently-active turn. Renderers that want "am I in the active
   *  turn?" compare their own message.createdAt against this. */
  activeTurnStartedAt: number;
  /** 2026-06-20 — pre-edit baselines for full-content writes, keyed by the
   *  edit's toolCallId → the prior full content of the same file earlier in the
   *  session. EditCard feeds this to `extractDiffSource` so a Write that
   *  overwrites a file the agent already wrote shows what CHANGED instead of
   *  rendering the whole file as additions. Empty when no such chain exists.
   *  Computed once per session.messages change (see `computeEditBaselines`). */
  editBaselines: Map<string, string>;
  /** Submit handler for QuestionCard. Today this dispatches
   *  the answer as a normal next-turn user prompt (the "inferred" path
   *  through an inferred next-turn path, since our adapters close stdin after spawn and can't
   *  write a tool_result back to the running Claude process. Native
   *  blocking AskUserQuestion requires a future adapter capability —
   *  same hook, different routing under the hood when it ships. */
  respondToQuestion: (text: string) => void;
  /** Inline permission flow. When a tool call needs
   *  permission, the host puts the request here so the matching
   *  tool card can render an inline Allow/Deny/Always-for-X cluster
   *  beneath itself instead of pulling the user's eye to chrome.
   *
   *  Match by `pendingPermission.request.toolCall.toolCallId ===
   *  message.toolCallId`. Null when no permission is pending. */
  pendingPermission: import("../use-agent-session").PendingPermission | null;
  /** toolCallIds of the chat's QUEUED blocking questions (2026-07-04). The
   *  question tool card matches its own toolCallId here to render the
   *  AWAITING RESPONSE state (non-expandable) while the composer-slot card is
   *  up, and TurnEventList suppresses the tail shimmer + timer while the
   *  agent is parked on the user. Empty set when nothing is pending. */
  pendingQuestionToolCallIds: Set<string>;
  /** Submit handler that pairs with pendingPermission. Calls back
   *  through the bridge to AGENT_PERMISSION_RESPONSE; clears the
   *  pendingPermission slot on the store. */
  respondToPermission: (
    response: import("../../../platform/bridge/agent-events").RequestPermissionResponse,
  ) => void;
  /** Retry one engine-retained denied safety action by opaque id. */
  retrySafetyReview: (retryId: string) => Promise<void>;
  /** Ephemeral retry ids keyed by the durable safety-review tool row. */
  safetyReviewRetries?: Readonly<Record<string, string>>;
  /** Record a sticky "Always for X" rule before
   *  responding. Inline permission cluster fires this when the user
   *  picks an `allow_always` / `reject_always` option so future
   *  matching requests in the same chat auto-respond. */
  recordPolicy: (rule: import("../policies").PolicyRule) => void;
  /** Active chat id. Used by the inline permission
   *  cluster to scope an Always-for-X rule to the right chat. Null
   *  when no chat is active (e.g. the empty-state composer). */
  chatId: string | null;
  /** Switch the agent to a named permission mode. Used
   *  by the ExitPlanModeCard to apply the user's "approve plan and
   *  continue in Default / Accept Edits / Auto" pick. Returns null
   *  for sessions whose adapter doesn't expose modes (Codex). */
  setMode: ((modeId: string) => void) | null;
  /** Children of an in-flight subagent, keyed by
   *  the parent's toolCallId. SubagentCard reads its own children
   *  here and renders them indented inside its expanded body.
   *  Computed once per session.messages change at the host level
   *  so the per-card lookup is O(1). Empty map when no subagent is
   *  active. */
  subagentChildren: Map<string, AgentMessage[]>;
  /** Click-to-edit on past user messages. The renderer calls this with
   *  `(messageId, editedText)`;
   *  agent-chat truncates SQLite + the in-memory store at messageId
   *  (inclusive) and dispatches editedText as a fresh user prompt.
   *  Files on disk are not reverted; transcript editing and working-tree
   *  restoration are separate operations.
   *
   *  Edit mode reconstructs the whole message inline in the
   *  editor (text + mention pills + attachment pills). `attachments` is the
   *  full staged set (reconstructed originals + new); `segments` is the
   *  ordered bubble content so the resubmitted message renders inline. */
  editAndResubmit: (
    messageId: string,
    editedText: string,
    attachments: import("../composer-attachments").ComposerAttachment[],
    segments?: import("../composer-editor").ComposerSegment[],
  ) => void;
  /** Open a full-screen image preview overlay
   *  for a sent user-bubble image attachment. Same lightbox the
   *  composer uses; lifted to the chat level so any sent image is
   *  clickable for preview without entering edit mode. */
  previewImage?: (src: string) => void;
  /** Workspace root used to resolve disk-backed transcript image paths. */
  attachmentCwd?: string | null;
  /** False while a retained chat surface is hidden; invisible transcripts must
   *  release full-resolution blob URLs until they are surfaced again. */
  attachmentImagesActive?: boolean;
  /** Open a workspace-relative file in the workbench viewer (the same preview
   *  tab the Source tree drives). Wired by agent-chat; used by clickable
   *  file-path chips / links in the agent's output markdown. Undefined on
   *  surfaces with no workbench (e.g. the empty-state composer). */
  openFile?: (path: string) => void;
  /** Route a clicked URL to the Review tab when it's the ACTIVE
   *  workspace's PR link ("PR created: https://github.com/…/pull/13").
   *  Returns true when handled (caller preventDefaults); false lets the
   *  link open externally as usual. Wired by agent-chat. */
  openPrUrl?: (url: string) => boolean;
}

export type Renderer<M extends AgentMessage> = ComponentType<{
  message: M;
  ctx: RendererContext;
}>;

/** A custom matcher runs before tool-kind dispatch. Lets design
 *  tools and subagent calls win over the generic by-kind renderer
 *  when their title/input shape says so. */
export interface ToolMatcher {
  match: (tool: AgentToolMessage) => boolean;
  render: Renderer<AgentToolMessage>;
}

export interface RendererRegistry {
  text: Partial<Record<AgentMessageRole, Renderer<AgentTextMessage>>>;
  /** Default text renderer if a role has none registered. */
  textFallback: Renderer<AgentTextMessage>;
  /** Custom matchers, evaluated top-down. First hit wins. */
  toolMatchers: ToolMatcher[];
  /** canonical tool kinds — `kind` field on ToolCall. */
  toolByKind: Partial<Record<ToolKind, Renderer<AgentToolMessage>>>;
  /** Final fallback for tools that match no rule above. */
  toolFallback: Renderer<AgentToolMessage>;
  /** Non-text/non-tool message kinds (mode_switch,
   *  subagent, error_notice, …). Looked up by `message.kind` after the
   *  text + tool branches fail. */
  byKind: Partial<
    Record<
      Exclude<AgentMessage["kind"], "text" | "tool">,
      ComponentType<{ message: AgentMessage; ctx: RendererContext }>
    >
  >;
  /** Renderer for messages whose `kind` is not in our union, so future engine
   *  events never silently drop. */
  unknown: ComponentType<{ message: AgentMessage; ctx: RendererContext }>;
}
