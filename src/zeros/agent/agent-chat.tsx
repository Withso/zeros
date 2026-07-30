// ──────────────────────────────────────────────────────────
// AgentChat — messages + tool cards + permission modal + composer
// ──────────────────────────────────────────────────────────
//
// The chat surface for an in-flight agent session. It's driven entirely
// by the state the useAgentSession hook exposes — this component does
// not store message state of its own, which keeps us honest about
// what the protocol says vs. what we invent.
//
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOpenChatFileInRow1 } from "@/shell/use-open-file-in-row1";
import {
  materializeScrollGeometryWithin,
  registerScrollRestore,
} from "@/shell/scroll-memory";
import {
  captureScrollAnchor,
  isAtChatContentBottom,
  restoreTargetTop,
  shouldCaptureChatScroll,
  type ChatScrollPosition,
} from "./chat-scroll-anchor";
import { useOpenPrUrlInReviewTab } from "@/shell/pr/use-open-review-tab";
import { warmWorkspaceFiles } from "@/shell/workspace-files-cache";
import { useNativeRuntime } from "@/native/runtime";
import { ZerosSpinner } from "@/loaders";
import {
  useWorkspaceStore,
  useWorkspaceDispatch,
  useActiveChatId,
  useChatById,
  useBrowserPickerSelection,
  usePendingChatSubmission,
  usePendingAutoSend,
  usePendingComposerAppend,
  type ChatThread,
} from "../store/store";
import { newChatId } from "../store/chat-id";
import { expandMentionsInText } from "./mentions";
import {
  useComposerEditor,
  textToDoc,
  toMessageSegments,
  messageToEditorContent,
  type ComposerInitialContent,
} from "./composer-editor";
import { QueuedMessagesCard } from "./queued-messages-card";
import { EmbeddedTerminalCommand } from "./embedded-terminal-command";
import { AddedDirectories } from "./added-directories";
import { PermissionCard } from "./permission-card";
import { PlanReviewCard } from "./plan-review-card";
import { QuestionCard } from "./question-card";
import { readPlan, isPlanReviewRequest } from "./renderers/plan-body";
import { WorkspaceDirectoryPicker } from "./workspace-directory-picker";
import { useProjects } from "../store/use-projects";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/primitives/dropdown-menu";
import { findProjectForFolder } from "../store/workspace-resolution";
import {
  Bot,
  Square,
  ArrowLeft,
  Plus,
  Upload,
  Paperclip,
  FolderInput,
  MessageSquareText,
  Check,
} from "lucide-react";
import { encodeAttachments } from "./encode-attachments";
import type { ComposerAttachment } from "./composer-attachments";
// Wave 4 (2026-05-16): the composer card is now built on the canonical
// AI Elements PromptInput recipe (form-shaped InputGroup with a
// block-end addon toolbar). Only COMPOSER_FILE_ACCEPT survives here
// (the file input still uses the same accept list) — the textarea
// autosize was removed with the textarea, and the visual shell moved
// off ComposerShell/ComposerTextarea/ComposerToolbar.
import { COMPOSER_FILE_ACCEPT } from "./composer-shell";
import {
  Conversation,
  ConversationContent,
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
  toast,
} from "@/zeros/ui/primitives/elements";
import { Tooltip } from "@/zeros/ui/primitives";
import { getLiveChatDraft, setLiveChatDraft } from "./composer-live-drafts";
import {
  composerOwnsFocus,
  isFocusHeldElsewhere,
  nextComposerFocusAction,
  OPEN_OVERLAY_SELECTOR,
  shouldReclaimComposerFocus,
} from "./composer-focus";
import { costBumpToastShown, markCostBumpToastShown } from "./device-local";
import { slashCommandKind } from "../bridge/agent-events";
import type { ContentBlock } from "../bridge/agent-events";
import { isTransportShaped, type AgentFailure } from "../bridge/failure";
import type {
  AgentSessionControls,
  AgentSessionState,
  AgentTextMessage,
  MessageContentSegment,
} from "./use-agent-session";
import { MessageView, type RendererContext } from "./renderers";
import { computeEditBaselines } from "./renderers/tool-edit";
import { Button, cn } from "../ui";
import {
  ModelPill,
  EffortPill,
  FastPill,
  PermissionToggle,
  PlanModeFrame,
  ComposerConcealedContext,
} from "./composer-pills";
import { ContextGauge } from "./context-gauge";
import { ChatProvenance } from "./chat-provenance";
import {
  ChatTranscriptPills,
  TranscriptPickerDialog,
} from "./chat-transcript-pills";
import {
  loadTranscriptSnapshot,
  transcriptFileName,
  transcriptPillLabel,
  transcriptSourceKey,
} from "./chat-transcript-attach";
import { useChatTranscriptSummaries } from "./use-chat-transcript-summaries";
import type { ChatSummaryWire } from "./agent-history-client";
import type { TranscriptMode } from "./transcript-format";
import {
  agentFamily,
  agentHasPermissionMenu,
  agentModeForPermission,
  agentSupportsEffort,
  agentSupportsFast,
  coerceModeIdForModel,
  effortLevelsFor,
  nearestEffort,
  permissionForAgentMode,
  permissionModeShowsFrame,
  staticModesForAgent,
} from "./model-catalog";
import { requestAiChatTitle } from "./chat-title";
import { getDefaultEffort, newChatBornDefaults } from "./new-chat-defaults";
import { effectiveFavoriteModel } from "./model-favorites";
import type { AgentModelSelection } from "./agent-model-menu";
import { ProjectContextChip } from "./project-context-chip";
import {
  invalidateAgentsCache,
  loadAgents,
  refreshAgents,
  useAgentsSnapshot,
} from "./agents-cache";
import { isRunnableAgent } from "./agent-runnable";
import {
  startBackgroundSignIn,
  supportsBackgroundSignIn,
  useBackgroundSignIn,
} from "./background-signin";
import { useAgentSessions } from "./sessions-hooks";
import { useStickyBottom, nextTextMessageTarget } from "./use-sticky-bottom";
import {
  TurnContainer,
  TurnPromptHeader,
  groupMessagesIntoTurns,
  turnKey,
} from "./turn-container";
import { TurnEventList } from "./turn-event-list";
import { stabilizeTurns } from "./stable-turns";
import { TurnFooter } from "./turn-footer";
import { JumpToLatestButton, JumpToPromptPill } from "./jump-pills";
import {
  CheckpointRail,
  sameCheckpoints,
  type Checkpoint,
} from "./checkpoint-rail";
import { MAX_MESSAGES_PER_CHAT, useSessionsStore } from "./sessions-store";
import { collectPendingQuestionToolCallIds } from "./pending-question-tools";
import {
  windowOlderMessages as ipcWindowOlderMessages,
  truncateMessagesFrom as ipcTruncateMessagesFrom,
} from "./agent-history-client";

// Error classification is handled by sessions-provider's AgentFailure
// pipeline; the UI now branches on session.status directly (warming /
// ready / reconnecting / auth-required / failed). No more regex
// helpers leaking timeout strings into the banner.

// A mode id that means "plan mode" — Claude's "plan" or Codex's "read-only"
// ("Plan only; no edits or commands"). The plan enter/exit helpers and
// isPlanMode both key off this so they work for BOTH agents.
const PLAN_MODE_RX = /plan|read.?only/i;

/** Phase 2 chat overhaul (2026-05-07): map an AgentFailure (or the bare status
 *  when failure isn't classified yet) to the short label used in the toast. */
function labelForFailure(
  failure: AgentFailure | null,
  status: AgentSessionState["status"],
): string {
  if (failure) {
    switch (failure.kind) {
      case "session-expired":
        return "Session expired";
      case "timeout":
        return "Timed out";
      case "auth-required":
        return "Sign in required";
      case "transport-closed":
        return "Disconnected";
      case "subprocess-exited":
        return "Agent exited";
      case "protocol-error":
        if (/agent response failure/i.test(failure.message)) {
          return "Agent response failure";
        }
        return "Agent error";
      default:
        return "Agent error";
    }
  }
  if (status === "auth-required") return "Sign in required";
  return "Agent error";
}

function footerLabelForFailure(failure: AgentFailure | null): string | null {
  if (!failure || failure.stage !== "prompt") return null;
  if (
    failure.kind === "protocol-error" &&
    /agent response failure/i.test(failure.message)
  ) {
    return "AGENT RESPONSE FAILURE";
  }
  switch (failure.kind) {
    case "auth-required":
      return "SIGN IN REQUIRED";
    case "subprocess-exited":
      return "AGENT EXITED";
    case "session-expired":
      return "SESSION EXPIRED";
    case "timeout":
      return "AGENT RESPONSE TIMEOUT";
    case "transport-closed":
      return "CONNECTION LOST";
    case "protocol-error":
      return "AGENT RESPONSE FAILURE";
    default:
      return null;
  }
}

interface AgentChatProps {
  session: AgentSessionState & AgentSessionControls;
  onBack: () => void;
  /** Optional right-aligned header slot (e.g. a "+ new chat" picker).
   *  When provided the default back button is hidden and the slot
   *  takes over header actions. Keeps the component reusable between
   *  the AgentMode picker flow (needs "back") and the Column-2 chat
   *  flow (needs "+ new"). */
  headerActions?: React.ReactNode;
  /** When this chat is backed by a ChatThread in the store (Column 2
   *  flow), the composer shows model/effort/permissions pills and
   *  persists changes. Picker/beta flows pass no chatId and get a
   *  minimal composer. */
  chatId?: string;
  /** False for a retained chat whose complete DOM is currently off-screen. */
  surfaceActive?: boolean;
  /** The chat's exact prepared cwd has not been published by workspace.create.
   * The composer remains interactive, but Send becomes an exact-chat intent
   * that drains only after provisioning and session readiness. */
  workspaceProvisioning?: boolean;
}

export function AgentChat({
  session,
  onBack,
  headerActions,
  chatId,
  surfaceActive = true,
  workspaceProvisioning = false,
}: AgentChatProps) {
  // Phase D3 (2026-05-08): hoisted up from later in the file so the
  // composer-draft seeding below can read state.chatComposerDrafts on
  // first render via the lazy useState initializer.
  const dispatch = useWorkspaceDispatch();
  const activeChatId = useActiveChatId();
  const browserPickerSelection = useBrowserPickerSelection();
  const pendingChatSubmission = usePendingChatSubmission();
  const pendingAutoSend = usePendingAutoSend(chatId);
  const pendingComposerAppend = usePendingComposerAppend();
  // Hidden CLI authentication is deliberately local-only. Relay/browser
  // sessions keep the status pill static and direct users to Providers.
  const nativeReady = useNativeRuntime().ready;
  // Per-chat draft seeding: pull once when this chat joins the retained view
  // deck, so each transcript/editor starts from its own persisted draft.
  const seededDraft = chatId
    ? useWorkspaceStore.getState().chatComposerDrafts[chatId]
    : undefined;
  // The composer is a TipTap editor (text + inline mention/attachment pills).
  // Seed it from the persisted draft once; its JSON is the source of truth.
  const initialContentRef = useRef<ComposerInitialContent | null>(
    seededDraft
      ? {
          json:
            seededDraft.json ??
            (seededDraft.text ? textToDoc(seededDraft.text) : null),
          attachments: seededDraft.attachments,
        }
      : null,
  );
  // Latest live-draft snapshot for the sidebar's synchronous read + the
  // unmount persist. Seeded so a remount before any edit keeps the draft.
  const composerLiveRef = useRef<{
    text: string;
    attachments: ComposerAttachment[];
    json: object | null;
  }>({
    text: seededDraft?.text ?? "",
    attachments: seededDraft?.attachments ?? [],
    json: seededDraft?.json ?? null,
  });
  // Indirections so the once-built editor + early keybind handlers reach the
  // current handlers (which are defined below the editor hook).
  const submitRef = useRef<() => void>(() => {});
  const updateLiveDraftRef = useRef<() => void>(() => {});
  const composerFocusRef = useRef<() => void>(() => {});
  // Stable ctx object for MessageView memoization. Without useMemo, every
  // parent re-render hands a new ref to every message and the per-message
  // memo can never short-circuit.
  //
  // isStreaming + lastMessageId let in-flight-aware renderers detect "am I
  // the active in-flight message" without reaching back into session state.
  //
  // activeTurnStartedAt = createdAt of the last user message. Drives the
  // "am I in the current turn?" check for turn-scoped chrome.
  const lastMessageId =
    session.messages.length > 0
      ? session.messages[session.messages.length - 1].id
      : null;
  const activeTurnStartedAt = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.kind === "text" && (m as AgentTextMessage).role === "user") {
        return m.createdAt;
      }
    }
    return 0;
  }, [session.messages]);
  // Subagent children are folded under their parent's toolCallId (the
  // SubagentCard renders them inside its body) and shadowed from the top
  // level. Edits are NOT merged — each edit renders as its own standalone
  // row. (The old Stage 4.2 "+N more changes" mergeKey collapse was removed
  // 2026-06-20: it folded edits to the same path across the whole session
  // into one card, which surprised users who saw an unexpected dropdown on a
  // file they'd edited in an earlier turn. `mergeKey` is still emitted by the
  // adapters but no longer consumed here.)
  const { visibleMessages, subagentChildren, editBaselines, queuedMessages } =
    useMemo(() => {
      const shadowed = new Set<string>();
      // Roadmap §2.4.7 — group child events of in-flight subagents under
      // the parent's toolCallId. The parent SubagentCard reads its bucket
      // out of `subagentChildren` and renders them indented inside its
      // expanded body. Children are also shadowed at the top-level so
      // we don't double-render.
      const subagentChildren = new Map<
        string,
        import("./use-agent-session").AgentMessage[]
      >();
      // Still-pending queued sends render in the QueuedMessagesCard docked
      // above the composer (2026-07-06 queue redesign), NOT as transcript
      // bubbles — shadow them out of the visible turn stream. Array order is
      // enqueue order, which is the FIFO send order the card shows.
      const queuedMessages: AgentTextMessage[] = [];
      // Tool calls present in THIS window. A child is only shadowed when its
      // parent SubagentCard is here to render it — the hydrate window (or a
      // truncation) can cut between a parent and its children, and shadowing
      // an orphan made that content silently unreachable (blank turn).
      const presentToolIds = new Set<string>();
      for (const m of session.messages) {
        if (m.kind === "tool") {
          presentToolIds.add(
            (m as import("./use-agent-session").AgentToolMessage).toolCallId,
          );
        }
      }
      for (const m of session.messages) {
        if (m.kind === "text" && m.queued) {
          queuedMessages.push(m);
          shadowed.add(m.id);
          continue;
        }
        const parentId =
          m.kind === "tool"
            ? (m as import("./use-agent-session").AgentToolMessage).parentToolId
            : m.kind === "text"
              ? (m as import("./use-agent-session").AgentTextMessage)
                  .parentToolId
              : undefined;
        if (!parentId || !presentToolIds.has(parentId)) continue;
        const bucket = subagentChildren.get(parentId) ?? [];
        bucket.push(m);
        subagentChildren.set(parentId, bucket);
        shadowed.add(m.id);
      }
      const visible =
        shadowed.size === 0
          ? session.messages
          : session.messages.filter((m) => !shadowed.has(m.id));
      // Pre-edit baselines so a Write that overwrites a file the agent already
      // wrote this session shows what changed, not the whole file as additions.
      const editBaselines = computeEditBaselines(session.messages);
      return {
        visibleMessages: visible,
        subagentChildren,
        editBaselines,
        queuedMessages,
      };
    }, [session.messages]);
  const isStreaming = session.status === "streaming";
  // Stage 4.3 — QuestionCard's submit hook. Routes through
  // session.sendPrompt today (see RendererContext doc); same callsite
  // when adapters gain a native tool_result write-back path.
  const respondToQuestion = useCallback(
    (text: string) => {
      session.sendPrompt(text, text).catch(() => {
        /* error surfaces via session.error */
      });
    },
    [session],
  );
  // Stage 6.1 — pendingPermission threaded into ctx so the matching
  // tool card can render its inline Allow/Deny cluster. respondToPermission
  // is the same call as the global PermissionBar; both surfaces share it.
  const respondToPermission = useCallback(
    (response: import("../bridge/agent-events").RequestPermissionResponse) => {
      session.respondToPermission(response);
    },
    [session],
  );
  // Stage 6.2 — sticky-policy mutators. Bound to the active chatId so
  // the InlinePermissionCluster can fire-and-forget without knowing
  // which chat it's in.
  const policyChatId = chatId;
  const recordPolicy = useCallback(
    (rule: import("./policies").PolicyRule) => {
      if (!policyChatId) return;
      useSessionsStore.getState().addPolicy(policyChatId, rule);
    },
    [policyChatId],
  );
  // Stage 6.3 — surface the session's setMode through ctx so the
  // ExitPlanModeCard can apply the user's "approve and continue in
  // mode X" pick. setMode? is optional on the session controls; we
  // wrap it so consumers don't have to handle the maybe-undefined.
  const setModeForCtx = useMemo(
    () =>
      session.setMode
        ? (modeId: string) => {
            void session.setMode!(modeId);
          }
        : null,
    [session],
  );
  // Mount-flicker fix (2026-07-16): the rail publishes its scroll-spy
  // pass here so the scroll-restore layout effect below can light the
  // correct tick before the first paint, instead of flashing the 1st
  // tick until the rail's own post-paint effect corrects it.
  const checkpointRecomputeRef = useRef<(() => void) | null>(null);
  // Send-jump count (2026-07-17, replaces the 2026-07-16 send-follow) —
  // armed by the send paths below, consumed by the
  // last-checkpoint-changed effect further down (see its comment for
  // the full design). A COUNT of armed sends still awaiting their turn
  // to render, not a boolean: several prompts can be queued during one
  // in-flight turn, and they dispatch one-per-turn, each becoming a new
  // last checkpoint; the count gives every queued send its own
  // visibility check as it enters the transcript. Each send path
  // increments; the effect decrements once per new last-checkpoint id.
  // Declared here because editAndResubmit is the earliest arming site.
  const pendingSendScrollCountRef = useRef(0);

  // Phase 2 chat overhaul (2026-05-07): click-to-edit on past user
  // messages. Truncate in-memory + SQLite at the edited message
  // (inclusive), then dispatch editedText as a fresh prompt. We do
  // NOT revert files on disk — user explicitly described this as
  // "edit and continue, no code reverted." File-revert is a Phase A
  // snapshot follow-up tracked in docs/research/08.
  const editAndResubmit = useCallback(
    async (
      messageId: string,
      editedText: string,
      // ALL staged attachments (reconstructed originals + new), inline.
      attachments: ComposerAttachment[],
      segments?: MessageContentSegment[],
    ) => {
      const trimmed = editedText.trim();
      if (!chatId) return;
      if (trimmed.length === 0 && attachments.length === 0) {
        return;
      }
      // Phase 2 chat overhaul (2026-05-07): if the user edits the
      // active turn's prompt mid-stream, cancel the in-flight turn
      // first so the agent's pending response gets aborted before
      // we truncate. Otherwise the streamed response keeps arriving
      // after we've already removed the user message, polluting the
      // post-truncate timeline. cancel() is idempotent on idle
      // sessions so the non-streaming branch is safe to fire too.
      if (session.status === "streaming") {
        try {
          await session.cancel?.();
        } catch {
          /* cancel best-effort; carry on with truncate */
        }
      }
      // Materialize every staged attachment into ContentBlocks (text → file
      // XML; image → ImageContent or disk-write+path-reference by vision
      // support) + bubble metadata. Reconstructed original images carry their
      // bytes (recovered from the thumbnail), so they re-send correctly;
      // original text bodies weren't stored → empty.
      //
      // Same encoder as the live send path (2026-07-30) — these were two
      // copies and only this one was right.
      const { blocks: newBlocks, bubbleAttachments: newBubbleMeta } =
        await encodeAttachments(attachments, {
          supportsImage:
            session.initialize?.agentCapabilities?.promptCapabilities?.image !==
            false,
          cwd: session.cwd || null,
          chatId,
          agentId: session.agentId,
        });
      const mergedBubble = newBubbleMeta;
      // Truncate in-memory FIRST so the UI reflects the edit immediately.
      useSessionsStore
        .getState()
        .truncateMessagesFromInMemory(chatId, messageId);
      // Phase 2 chat overhaul (2026-05-07, refined): AWAIT the SQLite
      // truncate before firing sendPrompt — otherwise the first
      // persist-write coalesces with the store flush and zombie rows
      // for ord >= cut survive a reload.
      try {
        await ipcTruncateMessagesFrom(chatId, messageId);
      } catch {
        /* SQLite unavailable in browser harness; in-memory is fine */
      }
      // Send-jump: the resubmitted prompt appends with a FRESH id (the
      // truncate above removed the original), so the
      // last-checkpoint-changed effect can scroll it into view if it
      // rendered off screen — including edits of the latest prompt,
      // where the count doesn't change but the id does.
      pendingSendScrollCountRef.current += 1;
      session
        .sendPrompt(
          trimmed,
          trimmed,
          newBlocks.length > 0 ? newBlocks : undefined,
          mergedBubble.length > 0 ? mergedBubble : undefined,
          segments && segments.length > 0 ? segments : undefined,
        )
        .catch(() => {
          /* error surfaces via session.error */
        });
    },
    [chatId, session],
  );

  // Phase D1.5 (deferred, 2026-05-07): the user-triggered Summarize
  // flow that previously lived here was removed in favor of each
  // agent's native compaction (Claude `/compact`, Codex `/compress`,
  // etc.). The summarize.ts constants + agent_chat_meta.summary
  // persistence + replay-boundary handling stay in place because:
  //   - D2's multi-chat-import pills read agent_chat_meta.summary
  //   - D1.5 slash-command wiring will use the same persistence path
  //     to save the agent's compacted output back into our store
  //
  // When D1.5 ships, it'll detect a slash-command turn (e.g. user
  // typed `/compact`), capture the agent's response, and run the same
  // summaryBoundary marking the old button used to do.

  // Phase D3 (2026-05-08): forward-ref to the composer hook's
  // openPreview. messageCtx is declared above the hook call so we
  // can't read it directly; the ref is populated after the hook
  // returns, and a stable wrapper reads through it. Result: clicking
  // a sent-bubble image opens the same lightbox the composer uses.
  const openPreviewRef = useRef<((src: string) => void) | null>(null);
  const previewImageThroughRef = useCallback((src: string) => {
    openPreviewRef.current?.(src);
  }, []);
  // Clickable file paths in agent output open in row 1 as their own tab. The
  // chat's cwd isn't known until chatThread resolves below, and the open
  // helper's identity changes with the row-1 tab list — both are read through
  // refs so messageCtx (and every message renderer) stays stable.
  const chatCwdRef = useRef<string | undefined>(undefined);
  const openChatFile = useOpenChatFileInRow1();
  const openChatFileRef = useRef(openChatFile);
  useEffect(() => {
    openChatFileRef.current = openChatFile;
  }, [openChatFile]);
  const openFileThroughRef = useCallback((path: string) => {
    openChatFileRef.current(chatCwdRef.current, path);
  }, []);
  // A clicked link to the ACTIVE workspace's PR focuses row 1's Review tab
  // instead of the external browser. Same through-ref treatment: the hook's
  // identity changes with the workspace's PR state, but messageCtx must stay
  // stable.
  const openPrUrl = useOpenPrUrlInReviewTab();
  const openPrUrlRef = useRef(openPrUrl);
  useEffect(() => {
    openPrUrlRef.current = openPrUrl;
  }, [openPrUrl]);
  const openPrUrlThroughRef = useCallback(
    (url: string) => openPrUrlRef.current(url),
    [],
  );
  // toolCallIds of queued blocking questions — the transcript question card
  // renders AWAITING RESPONSE (non-expandable) for these, and the tail
  // shimmer/timer hide while the agent is parked on the user.
  const pendingQuestionToolCallIds = useMemo(() => {
    return collectPendingQuestionToolCallIds(
      session.pendingQuestions,
      session.messages,
    );
  }, [session.pendingQuestions, session.messages]);
  const messageCtx: RendererContext = useMemo(
    () => ({
      isStreaming,
      lastMessageId,
      activeTurnStartedAt,
      subagentChildren,
      editBaselines,
      respondToQuestion,
      pendingQuestionToolCallIds,
      pendingPermission: session.pendingPermission,
      respondToPermission,
      recordPolicy,
      chatId: chatId ?? null,
      setMode: setModeForCtx,
      editAndResubmit,
      previewImage: previewImageThroughRef,
      openFile: openFileThroughRef,
      openPrUrl: openPrUrlThroughRef,
    }),
    [
      isStreaming,
      lastMessageId,
      activeTurnStartedAt,
      subagentChildren,
      editBaselines,
      respondToQuestion,
      pendingQuestionToolCallIds,
      session.pendingPermission,
      respondToPermission,
      recordPolicy,
      chatId,
      setModeForCtx,
      editAndResubmit,
      previewImageThroughRef,
      openFileThroughRef,
      openPrUrlThroughRef,
    ],
  );
  // Scroll + active-prompt elements tracked via state so the
  // sticky-bottom hook + JumpPills re-run when they mount. Plain
  // useRef wouldn't trigger a re-render on .current changes.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [activePromptEl, setActivePromptEl] = useState<HTMLDivElement | null>(
    null,
  );
  // Imperative ref kept for legacy call sites that read scrollRef.current
  // (the keybind handler, follow-along effect). Mirrors `scrollEl`.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // (store selectors + dispatch hoisted to the top of AgentChat —
  // Phase D3 2026-05-08 — so composer-draft seeding can read on
  // first render. The original declaration here was removed.)
  const agentsList = useAgentsSnapshot();
  const agentSessions = useAgentSessions();

  // Tier 3 — background auth verification on chat mount. Trigger
  // the cache's normal load path so that Codex's active `login
  // status` command and Claude's expiry parsing have a
  // chance to flip the snapshot before the user hits Send.
  //
  // Non-blocking by design: composer stays usable, the user can
  // type immediately, and the pre-flight gate in handleSend below
  // catches the case where they Send before the probe lands.
  //
  // We deliberately use `loadAgents` (TTL-bound) rather than
  // `refreshAgents` (force) so that rapid chat-mount storms (six
  // history-restored tabs in 200ms) coalesce into one probe via
  // the cache's in-flight + 30s freshness checks. The post-failure
  // refresh path handles the "credentials silently expired in the
  // last 30s" edge case if it ever matters.
  useEffect(() => {
    if (!session.agentId) return;
    void loadAgents((force) => agentSessions.listAgents(force)).catch(() => {
      /* failures surface via the regular toast pipeline */
    });
  }, [session.agentId, agentSessions]);

  // Chat-thread-backed composer settings. When `chatId` is absent
  // (picker/beta flows) this returns null and the pills render stubs.
  const chatThread = useChatById(chatId);
  // Background CLI sign-in for auth-required failures (Claude/Codex). One
  // click on the footer's Sign in button drives the CLI login in a hidden
  // PTY and opens the browser; on success the session is rebuilt in place
  // so the user can just resend.
  const signInAgentId = session.agentId ?? chatThread?.agentId ?? null;
  const signInState = useBackgroundSignIn(signInAgentId);
  const handleSignIn = useCallback(() => {
    if (
      !nativeReady ||
      !signInAgentId ||
      !supportsBackgroundSignIn(signInAgentId)
    )
      return;
    const agentId = signInAgentId;
    void startBackgroundSignIn(agentId).then(async (res) => {
      if (res.ok) {
        // Rebuild the live session now that credentials exist — clears the
        // auth-required state without waiting for the next explicit send.
        try {
          await session.startSession(agentId);
        } catch {
          /* a failed rebuild falls back to the send-again path */
        }
      } else {
        toast.error("Sign in failed", {
          description: `${res.error ?? "Unknown error."} You can also sign in from Settings → Agent providers.`,
        });
      }
    });
  }, [nativeReady, signInAgentId, session]);
  // Keep the ref the chat file-open closure reads in sync with the active
  // chat's working dir (the running session's cwd, or the bound folder before
  // it starts).
  useEffect(() => {
    const cwd = session.cwd ?? chatThread?.folder ?? undefined;
    chatCwdRef.current = cwd;
    // Prime the workspace file list so the FIRST file-chip click resolves
    // synchronously (instant open) instead of waiting on git ls-files.
    warmWorkspaceFiles(cwd);
  }, [session.cwd, chatThread?.folder]);
  const updateChatSettings = useCallback(
    (
      updates: Partial<
        Pick<
          ChatThread,
          | "model"
          | "effort"
          | "fast"
          | "additionalDirectories"
          | "permissionMode"
          | "lastModeId"
          | "prePlanModeId"
          | "agentId"
          | "agentName"
          // Cleared (set undefined) by the fresh-chat in-place agent switch —
          // the old agent's engine session id must not resume under the new.
          | "sessionId"
        >
      >,
    ) => {
      if (!chatId) return;
      dispatch({ type: "UPDATE_CHAT_SETTINGS", id: chatId, updates });
    },
    [chatId, dispatch],
  );

  // Phase D3 (2026-05-08): single source of truth for "which past
  // user prompt is currently being edited." Lifted up from each
  // TurnPromptHeader so opening edit on one turn auto-closes any
  // other — only one edit composer is ever live at a time. null =
  // no turn in edit mode.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Plan mode is a quick-access toggle over the agent's "plan" permission
  // mode. Claude advertises "plan"; Codex's equivalent is "read-only" ("Plan
  // only; no edits or commands"), so the toggle maps to whichever the agent
  // exposes. "On" derives from the live session's current mode; before a
  // session exists we fall back to the chat's local posture. Shown for agents
  // that have a plan/read-only mode (or are Claude/Codex, which always do).
  // Before the live session advertises its modes (a brand-new chat still
  // warming, or a no-folder bind failure), fall back to the SELECTED AGENT's
  // statically-known modes so the "+" → Permissions menu shows the agent's REAL
  // vocabulary — e.g. Claude's Bypass — not the generic local posture list. The
  // engine's live modes replace these on bind (same ids → a pre-bind pick
  // reconciles by id via chat.lastModeId).
  const effectiveModes = useMemo(
    () =>
      session.availableModes.length > 0
        ? session.availableModes
        : staticModesForAgent(session.agentId ?? chatThread?.agentId ?? null),
    [session.availableModes, session.agentId, chatThread?.agentId],
  );

  // The agent family driving this chat — used to map a permission posture onto
  // the right native mode (Claude/Codex/Cursor differ).
  const chatAgentId = chatThread?.agentId ?? session.agentId ?? null;

  const planAgentModeId =
    effectiveModes.find((m) => PLAN_MODE_RX.test(m.id))?.id ?? "plan";
  const isPlanMode = session.currentModeId
    ? PLAN_MODE_RX.test(session.currentModeId)
    : chatThread?.lastModeId
      ? PLAN_MODE_RX.test(chatThread.lastModeId)
      : chatThread?.permissionMode === "plan";
  // The agent's own default/ask mode id — where we land when EXITING plan with
  // nothing remembered, or when a posture resolves to "no explicit target".
  const defaultAgentModeId =
    effectiveModes.find((m) => /default|^ask$/i.test(m.id))?.id ?? "default";

  // The "Auto" (safe default) native mode id for this agent — where a chat that
  // leaves Plan with nothing remembered lands (e.g. a born-in-plan chat), so it
  // matches the new-chat default posture rather than the prompting mode.
  const autoAgentModeId =
    agentModeForPermission("auto", effectiveModes, chatAgentId)?.id ??
    defaultAgentModeId;

  // ── Permission mode handlers (shared by the composer permission toggle +
  // the ExitPlanMode card). Selecting a mode BOTH switches the live session
  // (session/set_mode) AND persists the EXACT native id to chat.lastModeId (+ its
  // posture bucket), so it survives an effort/model/fast force-respawn (which
  // drops live session state) — see reconcilePermissionModeAtBind. The exact id
  // is what lets a specific native mode round-trip; an explicit pick clears any
  // remembered pre-plan mode. selectNativeMode (below, after the plan helpers)
  // is the menu entry point. ──

  // Enter Plan mode: remember the EXACT current mode so exiting returns to THAT
  // mode (e.g. Auto), then switch to the agent's plan/read-only mode.
  const enterPlan = useCallback(
    () => {
      if (!chatThread) return;
      const currentId =
        session.currentModeId ?? chatThread.lastModeId ?? autoAgentModeId;
      void session.setMode?.(planAgentModeId);
      updateChatSettings({
        lastModeId: planAgentModeId,
        permissionMode: "plan",
        ...(currentId && !PLAN_MODE_RX.test(currentId)
          ? { prePlanModeId: currentId }
          : {}),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      chatThread,
      session.setMode,
      session.currentModeId,
      planAgentModeId,
      autoAgentModeId,
      updateChatSettings,
    ],
  );

  // Leave Plan mode → restore the EXACT mode the user was in before entering it
  // (bypass/auto/accept-edits/default). Shared by the permission toggle AND the
  // permission card when the user approves Claude's ExitPlanMode — approving a
  // plan must actually exit Plan mode (via setMode → current_mode_update), else
  // the toggle stays stuck on Plan and the next turn re-plans. No-op when not in
  // Plan.
  const exitPlanMode = useCallback(() => {
    if (!chatThread || !isPlanMode) return;
    const backId = chatThread.prePlanModeId ?? autoAgentModeId;
    void session.setMode?.(backId);
    updateChatSettings({
      lastModeId: backId,
      permissionMode: permissionForAgentMode(backId, chatAgentId),
      prePlanModeId: undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatThread,
    isPlanMode,
    autoAgentModeId,
    session.setMode,
    chatAgentId,
    updateChatSettings,
  ]);

  // Route a permission-toggle pick to the EXACT native mode. A plan-shaped id
  // (Claude "plan" / Cursor "plan") routes through enterPlan so the pre-plan mode
  // is remembered (exit restores it) and the composer plan frame stays in sync;
  // any other native mode is set live + persisted losslessly (which naturally
  // leaves Plan). Codex's cycle has no plan-shaped id, so it never hits the plan
  // branch.
  const selectNativeMode = useCallback(
    (modeId: string) => {
      if (PLAN_MODE_RX.test(modeId)) {
        if (!isPlanMode) enterPlan();
        return;
      }
      void session.setMode?.(modeId);
      updateChatSettings({
        lastModeId: modeId,
        permissionMode: permissionForAgentMode(modeId, chatAgentId),
        prePlanModeId: undefined,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isPlanMode, enterPlan, session.setMode, chatAgentId, updateChatSettings],
  );

  // The native mode id the permission toggle shows (icon + tooltip). Prefer the
  // live session mode; fall back to the persisted exact id, then the
  // posture→native resolution pre-bind. Coerced to a mode THIS model offers so
  // switching (e.g.) an "auto" chat to Haiku — whose cycle drops "auto" — still
  // shows a real mode (Accept Edits, auto's classifier-less behavior); the
  // persisted mode is untouched, so switching back to an auto-capable model
  // restores "auto".
  const currentPermissionModeId: string | null = coerceModeIdForModel(
    chatAgentId,
    chatThread?.model ?? null,
    session.currentModeId ??
      chatThread?.lastModeId ??
      agentModeForPermission(
        chatThread?.permissionMode ?? "auto",
        effectiveModes,
        chatAgentId,
      )?.id ??
      null,
  );

  // Show the composer permission toggle when the agent has a native-mode
  // vocabulary. Includes Cursor (Ask/Edit).
  const showPermissionToggle = agentHasPermissionMenu(
    chatAgentId,
    chatThread?.model ?? null,
  );

  // Dashed composer frame for the guarded "propose, don't act" modes — Claude
  // Plan, Codex Ask for approval, Cursor Ask (2026-07-10 spec; previously the
  // frame keyed off plan mode alone).
  const composerGuarded = permissionModeShowsFrame(
    chatAgentId,
    currentPermissionModeId,
  );

  // Has this chat's conversation STARTED (first prompt sent)? Reactive twin
  // of the click-time `pristine` check below: in-memory messages OR the
  // promoted title (the durable tell that survives an engine respawn while
  // disk history hydrates). Drives the dropdown's ↗ redirect arrows — a
  // fresh chat switches agents freely; a started chat IS its agent's
  // session, so other agents' models open a new tab (2026-07-10 spec).
  const hasSessionMessages = useSessionsStore((s) =>
    chatId ? (s.sessions[chatId]?.messages.length ?? 0) > 0 : false,
  );
  const conversationStarted =
    hasSessionMessages ||
    (chatThread ? chatThread.title !== "Untitled" : false);

  // One-time-per-WORKSPACE cost heads-up, shown as a toast (the same
  // affordance Claude Code uses) and scoped per workspace rather than per
  // chat — per chat was too noisy. The prompt cache is keyed by model AND
  // effort, so a mid-conversation change makes the next reply re-read the
  // whole conversation at full input price. Fires ONLY mid-conversation —
  // gated on real transcript messages (hasSessionMessages), never the
  // promoted-title heuristic, so a fresh chat (nothing to re-read) can't
  // show it — and only once per workspace, keyed by the chat's folder.
  const maybeShowCostBumpToast = useCallback(
    (what: "model" | "effort") => {
      if (!chatId || !hasSessionMessages) return;
      const workspaceKey = session.cwd ?? chatThread?.folder ?? chatId;
      if (costBumpToastShown(workspaceKey)) return;
      markCostBumpToastShown(workspaceKey);
      toast.info(what === "model" ? "Model changed" : "Effort changed", {
        description:
          "Changing the model or effort re-reads the conversation — your next reply is slower and costs more.",
      });
    },
    [chatId, hasSessionMessages, session.cwd, chatThread?.folder],
  );

  // Cross-agent pick from the unified model dropdown (2026-07-10 spec: the
  // ModelPill lists EVERY agent's models behind a logo rail). Two paths:
  //
  //   FRESH chat (nothing sent yet) → switch IN PLACE, same tab, same strip
  //   position (user report: the old delete+recreate hopped the tab to the
  //   end of the strip). Safe because nothing agent-specific exists yet:
  //   closeSession tears down a live warm session (and drops its slot) so
  //   Column2ChatView's warmup effect — re-fired by the agentId change —
  //   spawns fresh under the new agent; a still-warming slot falls through
  //   to ensureSession's agentId-mismatch rebuild. The native mode ids
  //   (lastModeId/prePlanModeId) and the engine sessionId don't translate
  //   across agents, so they're cleared in the same dispatch. The typed
  //   draft stays put — same chat id.
  //
  //   STARTED chat (first prompt sent — the ↗ rows) → the chat IS its
  //   agent's session, so open a NEW tab bound to the picked agent+model
  //   (ADD_CHAT appends + activates it) and leave this one untouched; the
  //   in-progress draft is copied across.
  const switchAgentModel = useCallback(
    (sel: AgentModelSelection) => {
      if (!chatThread || !chatId) return;
      const born = newChatBornDefaults(sel.agentId);
      const ladder = effortLevelsFor(sel.agentId, sel.model, null);
      // Effort carry-over (2026-07-10 spec), in priority order:
      //   1. Target is its agent's FAVORITE and the user set a default
      //      effort in Settings → that default (favorite ⌁ Opus@max wins
      //      over a carried high).
      //   2. Else CARRY the current chat's effort when the target offers it
      //      (Sol@high ↗ Opus 4.8 → still high).
      //   3. Else the nearest ladder level below it (max ↗ Grok 4.5 → high).
      //   4. Empty ladder (no effort knob) → keep the value; it's inert.
      const favDefault =
        sel.model === effectiveFavoriteModel(sel.agentId)
          ? getDefaultEffort(sel.agentId)
          : null;
      const effort =
        favDefault && ladder.includes(favDefault)
          ? favDefault
          : (nearestEffort(ladder, chatThread.effort) ?? chatThread.effort);
      const fast = born.fast && agentSupportsFast(sel.agentId, sel.model, null);
      // Pristine = nothing sent yet. Both signals must agree: zero in-memory
      // messages AND the never-promoted "Untitled" title — after an engine
      // respawn the sessions slot is empty while disk history hydrates, and
      // the title is the durable tell that a first message ever happened.
      const pristine =
        (useSessionsStore.getState().sessions[chatId]?.messages ?? [])
          .length === 0 && chatThread.title === "Untitled";
      if (pristine) {
        agentSessions.closeSession(chatId);
        updateChatSettings({
          agentId: sel.agentId,
          agentName: sel.agentName || null,
          model: sel.model,
          effort,
          fast,
          permissionMode: born.permissionMode,
          lastModeId: undefined,
          prePlanModeId: undefined,
          sessionId: undefined,
        });
        return;
      }
      const fresh: ChatThread = {
        id: newChatId(),
        folder: chatThread.folder,
        kind: chatThread.kind,
        agentId: sel.agentId,
        agentName: sel.agentName || null,
        model: sel.model,
        effort,
        permissionMode: born.permissionMode,
        ...(fast ? { fast: true } : {}),
        additionalDirectories: chatThread.additionalDirectories,
        title: "Untitled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      // Carry the typed prompt across: the keystroke-fresh live draft first,
      // else the store copy. Written under the fresh id BEFORE ADD_CHAT so
      // the new composer's mount-time draft read finds it.
      const draft =
        getLiveChatDraft(chatId) ??
        useWorkspaceStore.getState().chatComposerDrafts[chatId] ??
        null;
      if (draft) {
        dispatch({ type: "SET_CHAT_DRAFT", chatId: fresh.id, draft });
      }
      dispatch({ type: "ADD_CHAT", chat: fresh });
    },
    [chatThread, chatId, dispatch, agentSessions, updateChatSettings],
  );

  // Phase 2 chat overhaul (2026-05-07): the toolbar pills the main composer
  // renders, ALSO reused in TurnPromptHeader's edit mode so editing a past
  // prompt has the same model / fast / effort / plan / permissions
  // affordances. Memoized on the slice of chatThread + session state the
  // pills actually read. (2026-06-08) added Fast + the effort battery toggle
  // + the Plan toggle.
  const editToolbarPills = useMemo(() => {
    if (!chatThread) return null;
    return (
      <>
        <ModelPill
          agentId={chatThread.agentId}
          initialize={session.initialize}
          value={chatThread.model}
          onSelectAgentModel={switchAgentModel}
          redirectCrossAgent={conversationStarted}
          onChange={(v) => {
            const ladder = effortLevelsFor(
              chatThread.agentId,
              v,
              session.initialize,
            );
            // 2026-07-10 spec: the saved default effort belongs to the
            // DEFAULT (favorite) model only. Switching TO the favorite
            // re-applies it; switching to any other model CARRIES the
            // chat's current effort, sliding to the nearest level below
            // when the new ladder doesn't offer it (Sol@max → 5.5 lands
            // on xhigh, → Grok lands on high) — same rule as redirects.
            const savedDefault =
              v === effectiveFavoriteModel(chatThread.agentId)
                ? getDefaultEffort(chatThread.agentId)
                : null;
            const carried =
              nearestEffort(ladder, chatThread.effort) ?? chatThread.effort;
            const effortReset =
              savedDefault && ladder.includes(savedDefault)
                ? ({ effort: savedDefault } as const)
                : carried !== chatThread.effort
                  ? ({ effort: carried } as const)
                  : {};
            // Clear a stale Fast flag when the new model doesn't support Fast
            // (e.g. Opus[fast] → Sonnet 5 / Haiku[no fast]). Without this the
            // FastPill hides but `fast:true` lingers in env → confusing state.
            const fastReset =
              chatThread.fast &&
              !agentSupportsFast(chatThread.agentId, v, session.initialize)
                ? ({ fast: false } as const)
                : {};
            updateChatSettings({ model: v, ...effortReset, ...fastReset });
            // Apply to the LIVE session too, so the change takes effect on the
            // next turn instead of only on a rebuild.
            if (v) session.setModel?.(v);
            // updateConfig as well, and deliberately AFTER setModel: it pushes
            // the WHOLE composer env, so it also carries the effortReset /
            // fastReset above (which setModel alone would strand on the live
            // session), and it is what stamps appliedChatEnvKey so sendPrompt's
            // drift reconcile doesn't respawn for a change already applied.
            session.updateConfig?.();
            // §3.6 R4 — once per chat: a mid-conversation model change is a
            // cache miss on the next reply (slower + more tokens).
            if (v && v !== chatThread.model) maybeShowCostBumpToast("model");
          }}
        />
        {agentSupportsFast(
          chatThread.agentId,
          chatThread.model,
          session.initialize,
        ) && (
          <FastPill
            active={!!chatThread.fast}
            onToggle={() => {
              updateChatSettings({ fast: !chatThread.fast });
              // Apply to the LIVE session too (Claude SDK), so the change
              // takes effect on the next turn instead of only on a rebuild.
              session.updateConfig?.();
            }}
          />
        )}
        {agentSupportsEffort(
          chatThread.agentId,
          chatThread.model,
          session.initialize,
        ) && (
          <EffortPill
            agentId={chatThread.agentId}
            levels={effortLevelsFor(
              chatThread.agentId,
              chatThread.model,
              session.initialize,
            )}
            value={chatThread.effort}
            onChange={(v) => {
              updateChatSettings({ effort: v });
              // Apply to the LIVE session too (Claude SDK), so the change
              // takes effect on the next turn instead of only on a rebuild.
              session.updateConfig?.();
              // §3.6 R4 — the prompt cache is keyed by effort level too:
              // same one-time heads-up as a model change.
              if (v !== chatThread.effort) maybeShowCostBumpToast("effort");
            }}
          />
        )}
        {showPermissionToggle && (
          // 2026-07-10 spec: the permission toggle sits where the Plan pill
          // used to — icon-only, cycles the agent's native modes on click,
          // names the current mode on hover. Replaces the "+" → Permissions
          // submenu (removed) as THE mode selector.
          <PermissionToggle
            agentId={chatAgentId}
            model={chatThread.model}
            currentModeId={currentPermissionModeId}
            onSelectMode={selectNativeMode}
          />
        )}
      </>
    );
    // Depend on the specific session slices read above, not the whole
    // session object — re-running on every session re-create churns the
    // memo unnecessarily. `selectNativeMode` is a stable useCallback that
    // already closes over the mode/session state it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatThread,
    session.initialize,
    session.setModel,
    session.updateConfig,
    updateChatSettings,
    switchAgentModel,
    conversationStarted,
    chatAgentId,
    showPermissionToggle,
    currentPermissionModeId,
    selectNativeMode,
    maybeShowCostBumpToast,
  ]);

  // 2026-05-21: handleAgentSwitch + folderLabel removed. The
  // agent-switch flow lived behind AgentPill's "switch agent" menu,
  // which was retired when the AgentPill row came out of the chat
  // surface. The handler created a new ChatThread with
  // `sourceChatId` set, which then drove the SummaryHandoffPill —
  // both now dead UI. Agents are picked via the "+" menu instead.

  const chatFolder = chatThread?.folder || undefined;
  // Resolve the chat's repo origin so the #-PR picker can list PRs.
  const { projects } = useProjects();
  const composerOriginUrl =
    findProjectForFolder(chatFolder ?? null, projects)?.originUrl ?? null;

  // ── Composer @-mention + slash + #-PR pickers (shared hook) ──
  // Single source shared with the edit composer (turn-container). Owns
  // caret tracking, trigger detection, filtered lists, nav + insert.
  // `/add-dir` + the composer "+" → "Link workspaces" menu open a picker
  // dialog (WorkspaceDirectoryPicker) to grant Claude access to another
  // worktree or a browsed folder. The chosen dirs are carried to the SDK as
  // additionalDirectories on the next respawn (Claude resumes, so context
  // survives).
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  // The composer "+" menu is CONTROLLED so it can be force-closed when the
  // permission/question card conceals the composer (see composerConcealed).
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  // The composer "+" → "Attach chat transcript" picker. Ephemeral: it is a
  // transient dialog, not a durable selection.
  const [transcriptPickerOpen, setTranscriptPickerOpen] = useState(false);

  // Grant access to a directory (a worktree path or a Browse… pick). Appends
  // de-duped, skipping the cwd (already accessible).
  const linkDirectory = useCallback(
    (dir: string) => {
      if (!chatThread || !dir) return;
      const current = chatThread.additionalDirectories ?? [];
      if (dir === chatThread.folder || current.includes(dir)) return;
      updateChatSettings({ additionalDirectories: [...current, dir] });
      // Apply to the LIVE session too (Claude SDK additionalDirectories), so
      // the new dir is accessible on the next turn instead of only on a rebuild.
      session.updateConfig?.();
    },
    [chatThread, updateChatSettings, session],
  );

  const removeDirectory = useCallback(
    (dir: string) => {
      if (!chatThread) return;
      const current = chatThread.additionalDirectories ?? [];
      updateChatSettings({
        additionalDirectories: current.filter((d) => d !== dir),
      });
      // Apply to the LIVE session too (Claude SDK additionalDirectories), so
      // the removal takes effect on the next turn instead of only on a rebuild.
      session.updateConfig?.();
    },
    [chatThread, updateChatSettings, session],
  );

  // Inline slash-command actions (Claude only). Picking /plan, /fast,
  // /ultracode, /add-dir or /compact runs the action locally instead of
  // inserting text; returns true when handled. Shared by the picker
  // (onSlashCommand) and the bare-command submit path in handleSend.
  const runInlineSlashCommand = useCallback(
    (name: string): boolean => {
      if (!chatThread) return false;
      if (slashCommandKind(chatThread.agentId, name) !== "inline") return false;
      switch (name) {
        case "plan": {
          const exitId =
            effectiveModes.find((m) => /default|^ask$/i.test(m.id))?.id ??
            "default";
          void session.setMode?.(isPlanMode ? exitId : planAgentModeId);
          return true;
        }
        case "fast":
          updateChatSettings({ fast: !chatThread.fast });
          // Apply to the LIVE session too (Claude SDK), so the change takes
          // effect on the next turn instead of only on a rebuild.
          session.updateConfig?.();
          return true;
        case "ultracode":
          updateChatSettings({ effort: "ultracode" });
          // Apply to the LIVE session too (Claude SDK), so the change takes
          // effect on the next turn instead of only on a rebuild.
          session.updateConfig?.();
          return true;
        case "add-dir":
          // Open the workspace/directory picker dialog (Browse… or a worktree).
          setWorkspacePickerOpen(true);
          return true;
        case "compact":
          // §3.5 Task A: real compaction, ONE path for every agent —
          // AGENT_COMPACT → adapter.compactContext (Codex: the
          // thread/compact/start RPC; Claude: the CLI-intercepted "/compact"
          // fed turnless into the SDK stream). Deliberately NOT a sendPrompt:
          // no "/compact" user bubble ever lands in the transcript — the
          // compaction narrates itself as a standalone agent-output row
          // ("Compacting.." → "Context compacted", user spec 2026-07-12).
          void session.compactContext?.();
          return true;
        case "clear": {
          // Close THIS chat and open a fresh one bound to the same
          // agent/model/workspace, then navigate to it. "Close" mirrors the
          // tab-close path: closeSession reaps the engine session but the
          // transcript stays on disk (reopenable from History via loadSession),
          // and ARCHIVE_CHAT only drops the open-strip metadata — NOT a delete.
          // User spec 2026-06-25: /clear closes the chat + lands on a new one;
          // nothing is removed. (chatThread is non-null per the guard above, so
          // chatId is set; this check just narrows the optional prop for TS.)
          if (!chatId) return false;
          const fresh: ChatThread = {
            id: newChatId(),
            folder: chatThread.folder,
            kind: chatThread.kind,
            agentId: chatThread.agentId,
            agentName: chatThread.agentName,
            model: chatThread.model,
            effort: chatThread.effort,
            fast: chatThread.fast,
            additionalDirectories: chatThread.additionalDirectories,
            permissionMode: chatThread.permissionMode,
            title: "Untitled",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          // ADD_CHAT also sets the new chat active → navigation. Archiving the
          // old chat AFTERWARD leaves it non-active, so focus stays on the new
          // one (no replacement-neighbor selection like the tab-close path).
          dispatch({ type: "ADD_CHAT", chat: fresh });
          agentSessions.closeSession(chatId);
          dispatch({ type: "ARCHIVE_CHAT", id: chatId });
          return true;
        }
        default:
          return false;
      }
    },
    [
      chatThread,
      chatId,
      session,
      dispatch,
      agentSessions,
      updateChatSettings,
      isPlanMode,
      planAgentModeId,
      effectiveModes,
    ],
  );

  // Embedded-terminal commands (Claude /mcp, /login, …): the picked command
  // name (without slash) while its banner/terminal is mounted above the
  // composer. null = nothing open. Cleared by the command's own close/dispose.
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null);
  const terminalCwd = session.cwd ?? chatThread?.folder ?? null;
  const terminalAgentId = session.agentId ?? chatThread?.agentId ?? null;

  // Open the embedded terminal for a terminal-kind command. Returns true when
  // it took ownership (the picker/submit path then strips the token instead of
  // sending text). Requires a cwd to spawn the shell in; without one it falls
  // through to text (safe). Shared by the picker (onTerminalCommand) and the
  // bare-command submit path in handleSend.
  const openTerminalCommand = useCallback(
    (name: string): boolean => {
      if (slashCommandKind(terminalAgentId, name) !== "terminal") return false;
      if (!terminalCwd) return false;
      setTerminalCommand(name);
      return true;
    },
    [terminalAgentId, terminalCwd],
  );

  // ── Queued-messages card state (2026-07-06 queue redesign) ──
  // Sends typed mid-turn park in the card docked above the composer. The
  // ↑/↓ selection is VIRTUAL (the composer keeps DOM focus); `editing` loads
  // a queued message into the composer, stashing the current draft for
  // restore on cancel. Handlers live below the composer hook (they need
  // serialize/setContent), so the keymap reaches them through queueKeysRef.
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const [queueSelectedId, setQueueSelectedId] = useState<string | null>(null);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const queueSelectedRef = useRef<string | null>(null);
  queueSelectedRef.current = queueSelectedId;
  const editingQueuedRef = useRef<string | null>(null);
  editingQueuedRef.current = editingQueuedId;
  /** The draft that was in the composer when a queued-message edit began —
   *  restored on cancel/save/target-vanish so the user's typing survives. */
  const queueStashRef = useRef<ComposerInitialContent | null>(null);
  /** Re-entrancy latch for saveQueuedEdit (a second Enter while attachment
   *  encoding awaits would double-apply the edit). */
  const queueSaveInFlightRef = useRef(false);
  const queueKeysRef = useRef({
    arrowUp: (): boolean => false,
    arrowDown: (): boolean => false,
    deleteKey: (): boolean => false,
    modEnter: (): boolean => false,
    escape: (): boolean => false,
  });

  // ── Composer editor (TipTap: text + inline mention/attachment pills) ──
  // Replaces the textarea + useComposerPickers + useComposerAttachments. Owns
  // the @/slash/# pickers, drag-drop / paste / file-pick → inline attachment
  // pills, the image lightbox, and serialize() for submit + drafts.
  const composer = useComposerEditor({
    agentId: session.agentId ?? chatThread?.agentId ?? null,
    agentName: session.agentName ?? session.agentId ?? null,
    agentSupportsImage:
      session.initialize?.agentCapabilities?.promptCapabilities?.image !==
      false,
    modelId: chatThread?.model ?? null,
    cwd: session.cwd ?? chatThread?.folder ?? null,
    originUrl: composerOriginUrl,
    availableCommands: session.availableCommands,
    placeholder: 'Type your message… "/" for commands, "@" for files',
    onSubmit: () => submitRef.current(),
    onEscape: () => queueKeysRef.current.escape(),
    onModEnter: () => queueKeysRef.current.modEnter(),
    onArrowUp: () => queueKeysRef.current.arrowUp(),
    onArrowDown: () => queueKeysRef.current.arrowDown(),
    onDeleteKey: () => queueKeysRef.current.deleteKey(),
    onSlashCommand: runInlineSlashCommand,
    onTerminalCommand: openTerminalCommand,
    onChange: () => {
      // Typing hands the virtual focus back to the composer.
      if (queueSelectedRef.current && !editingQueuedRef.current) {
        setQueueSelectedId(null);
      }
      // Live-draft persistence PAUSES while a queued message is loaded for
      // editing — the editor holds the queued text, and snapshotting it
      // would clobber the stashed draft the edit restores on exit.
      if (editingQueuedRef.current) return;
      updateLiveDraftRef.current();
    },
    initialContent: initialContentRef.current,
  });
  const {
    editor: composerEditor,
    isEmpty: composerEmpty,
    serialize: serializeComposerState,
    insertFiles: addFiles,
    insertTextAttachment: stageTextAttachment,
    removeAttachmentBySourceKey: unstageAttachment,
    stagedSourceKeys,
    clear: clearComposer,
    setContent: setComposerContent,
    appendText: appendComposerText,
    focus: focusComposer,
    editorContent: composerEditorContent,
    suggestionPopup: composerSuggestionPopup,
    imagePreviewOverlay,
    openPreview,
    dragActive,
    dragHandlers,
  } = composer;
  composerFocusRef.current = focusComposer;
  // The composer stays editable in EVERY session state. `failed` /
  // `auth-required` used to flip the editor read-only here (mirroring the old
  // textarea `disabled`), but 2026-07-10 (#157) made sending from an error
  // state the RETRY affordance — canSend dropped `!isErrorState` so the user
  // resends to rebuild the session. A read-only editor silently defeated that:
  // the failed chat became a dead end (can't type → composerEmpty → can't
  // send), recoverable only by switching tabs and back (which re-fires
  // ChatBody's spawn effect and flips status off `failed`). The composer is
  // display:none'd — not disabled — when a permission/question card takes its
  // slot (composerConcealed), so there is no remaining state that wants a
  // read-only editor. TipTap editors are created editable, so we only ever
  // need to re-assert it (defensively, after a swap) — never clear it.
  useEffect(() => {
    composerEditor?.setEditable(true);
  }, [composerEditor]);

  // ── attach another chat's transcript ──
  //
  // The read is gated three ways. `surfaceActive` because retained background
  // chats keep this component mounted, and without it every hidden tab
  // re-pulls the folder's chat list on every DB_CHANGED tick (AGENTS.md:
  // hidden surfaces are inert). The other two are the surfaces that consume
  // it: the row (empty chat only) and the "+" picker (any time). Opening the
  // "+" menu is the pointer intent that warms the list before the user reaches
  // the item inside it, so the dialog opens with data rather than empty.
  const transcriptRowLive =
    session.messages.length === 0 && !session.error && !!chatThread?.folder;
  const { summaries: transcriptSummaries, loaded: transcriptsLoaded } =
    useChatTranscriptSummaries(
      chatThread?.folder,
      chatId,
      surfaceActive &&
        (transcriptRowLive || plusMenuOpen || transcriptPickerOpen),
    );
  // The provenance block's shape hangs on this ONE question, and `null` for
  // "not known yet" is the load-bearing third answer — see
  // provenanceBlockShape. Derived from the same array the row renders, so the
  // rows can never step aside for a row that then draws nothing.
  const hasTranscripts = transcriptsLoaded
    ? transcriptSummaries.length > 0
    : null;

  // Source chats whose transcript read is in flight. A pill in here is still
  // clickable — the click cancels (see cancelTranscriptAttach).
  const [pendingTranscriptIds, setPendingTranscriptIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // Chats whose in-flight attach the user has called off. A ref, not state:
  // the resolving promise must read the CURRENT answer, not the one captured
  // when it started.
  const transcriptCancelRef = useRef<Set<string>>(new Set());
  // Every in-flight attach, so handleSend can wait for the ones the user
  // asked for rather than sending without them. See the top of handleSend.
  const transcriptAttachesRef = useRef<Set<Promise<void>>>(new Set());

  // "Is this chat attached" is derived from the composer DOCUMENT, never from
  // a second list: that is what makes removing a chip with its × un-add the
  // pill, in one direction of data flow instead of two that can disagree.
  const attachedTranscriptChatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const key of stagedSourceKeys) {
      if (key.startsWith("transcript:"))
        ids.add(key.slice("transcript:".length));
    }
    return ids;
  }, [stagedSourceKeys]);

  const attachTranscript = useCallback(
    (summary: ChatSummaryWire, mode: TranscriptMode) => {
      const label = transcriptPillLabel(summary);
      const sourceId = summary.chatId;
      // A fresh attach clears any standing cancel for this chat, so
      // click → cancel → click actually re-attaches.
      transcriptCancelRef.current.delete(sourceId);
      setPendingTranscriptIds((prev) => {
        if (prev.has(sourceId)) return prev;
        const next = new Set(prev);
        next.add(sourceId);
        return next;
      });
      const settle = () => {
        transcriptCancelRef.current.delete(sourceId);
        setPendingTranscriptIds((prev) => {
          if (!prev.has(sourceId)) return prev;
          const next = new Set(prev);
          next.delete(sourceId);
          return next;
        });
      };
      // Fire-and-forget: Rule 11 forbids the click handler awaiting I/O. The
      // hover that preceded this click has almost always warmed the cache, so
      // the await below resolves from memory on the same tick. handleSend
      // waits on `transcriptAttachesRef` for the cold case.
      const run = (async () => {
        try {
          const snap = await loadTranscriptSnapshot({
            chatId: sourceId,
            mode,
            lastMessageAt: summary.lastMessageAt,
            // Deliberately NO exportedAt. `meta` is not part of the cache key,
            // so a wall-clock stamp here would be baked into the document by
            // whichever caller missed the cache FIRST — meaning the same click
            // produced a file with or without a date line depending on whether
            // the pointer had rested on the pill. Identical bytes for the
            // hover preview and the attachment is worth more than the stamp,
            // and the chat's own title and folder still head the document.
            meta: { title: summary.title, folder: summary.folder },
          });
          // A second click while the read was in flight means "stop", not
          // "attach again" — without this the impatient double-click stages
          // the very thing the user was trying to call off.
          if (transcriptCancelRef.current.has(sourceId)) return;
          if (snap.count === 0) {
            // Everything was filtered out — e.g. a concise transcript of a
            // chat whose only turn never produced an answer. Attaching an
            // empty file would be worse than saying so.
            toast.info(
              mode === "concise"
                ? "No answers in that chat yet — try the full transcript."
                : "That chat has nothing to attach yet.",
            );
            return;
          }
          const staged = stageTextAttachment({
            sourceKey: transcriptSourceKey(sourceId),
            name: transcriptFileName(label, mode),
            text: snap.text,
            // Frozen here on purpose: the chip's hover header describes the
            // FILE, so it must not drift when the source chat streams on.
            preview: {
              agentId: summary.agentId,
              agentName: summary.agentName,
              userMessageCount: summary.userMessageCount,
              lastMessageAt: summary.lastMessageAt,
            },
          });
          // An over-budget attachment is EXCLUDED at send (encode-attachments)
          // — so if it isn't said here it is never said at all. The pill would
          // otherwise show a green check for a file the agent never receives,
          // which is the exact silent drop this feature was built to end.
          if (staged && !staged.ok) {
            toast.warning(
              `Attached "${label}", but it won't be sent — ${staged.reason ?? "it exceeds this model's attachment budget"}.`,
            );
          } else if (snap.truncated || !snap.complete) {
            // `truncated` = the formatter hit its document cap; `!complete` =
            // the engine walk stopped before the start of history. Either way
            // the user holds a partial record and must not be told otherwise —
            // the same rule the copy action already follows.
            toast.warning(
              `Attached the most recent part of "${label}" — the full history was too large to read.`,
            );
          }
        } catch (err) {
          if (transcriptCancelRef.current.has(sourceId)) return;
          // Past the not-connected case these are transport/op strings
          // ("workspace op 'messages.windowOlder' failed"), which tell the
          // user nothing actionable.
          console.error("[Zeros] transcript attach failed:", err);
          toast.error("Couldn't read that transcript — try again in a moment.");
        } finally {
          settle();
        }
      })();
      transcriptAttachesRef.current.add(run);
      void run.finally(() => transcriptAttachesRef.current.delete(run));
    },
    [stageTextAttachment],
  );

  const removeTranscript = useCallback(
    (sourceChatId: string) => {
      unstageAttachment(transcriptSourceKey(sourceChatId));
    },
    [unstageAttachment],
  );

  /** Second click on a pill whose read hasn't landed. Marks the in-flight
   *  attach abandoned and drops the pending state immediately, so the control
   *  answers on the same frame the user clicked it. */
  const cancelTranscriptAttach = useCallback((sourceChatId: string) => {
    transcriptCancelRef.current.add(sourceChatId);
    setPendingTranscriptIds((prev) => {
      if (!prev.has(sourceChatId)) return prev;
      const next = new Set(prev);
      next.delete(sourceChatId);
      return next;
    });
  }, []);

  /** "Open this chat" from a pill's context menu.
   *
   *  UNARCHIVE first, and unconditionally. This list deliberately includes
   *  CLOSED chats (a transcript doesn't get less useful when its tab is
   *  dismissed), and a bare SET_ACTIVE_CHAT on an archived id is worse than a
   *  no-op: the tab strip and the chat deck both filter on `!archived`, so
   *  there is nothing to show — and then column2-panes' selection keeper sees
   *  an invalid selection and bounces it, or spawns a fresh default chat if
   *  the workspace has no live ones. UNARCHIVE_CHAT returns state untouched
   *  when the chat is already open, so this is safe for both cases; it also
   *  carries the engine write-through for free via the chats mirror. */
  const openTranscriptChat = useCallback(
    (sourceChatId: string) => {
      dispatch({ type: "UNARCHIVE_CHAT", id: sourceChatId });
      dispatch({ type: "SET_ACTIVE_CHAT", id: sourceChatId });
    },
    [dispatch],
  );

  // Per-chat scroll memory (Phase 1 §2.5.8, anchor-based since 2026-07-21).
  // The transcript's turns render with content-visibility:auto, so raw
  // scrollTop pixels are NOT a stable currency: a hidden chat's turns
  // collapse to intrinsic-size estimates and re-expand on reveal, shifting
  // any pixel offset by the accumulated estimate error. Positions are
  // therefore saved as {anchor turn id + offset into it + at-bottom flag}
  // (see chat-scroll-anchor.ts), and every restore runs a short settle loop
  // that re-measures the anchor for a few frames while content-visibility
  // re-renders the turns around the restored viewport at true sizes.
  const setScrollPosition = useSessionsStore((s) => s.setScrollPosition);
  /** Mirrors the surfaceActive prop for the save gate: a HIDDEN chat's
   *  clamp/collapse scroll events must never overwrite the saved reading
   *  position (that corruption then persisted to disk — the "scroll is
   *  wrong even after restart" report). */
  const surfaceActiveRef = useRef(surfaceActive);
  surfaceActiveRef.current = surfaceActive;
  /** Saved position waiting for the transcript hydrate. Cold boot mounts
   *  the chat BEFORE the SQLite hydrate lands, so the mount restore runs
   *  against a near-empty scroller; the layout effect after useStickyBottom
   *  re-applies this once messages exist. Null when nothing is pending. */
  const pendingHydrateRestoreRef = useRef<ChatScrollPosition | null>(null);
  /** True from the first programmatic restore write through its final settle
   * pass. Scroll/fade/paging listeners must not reinterpret those correction
   * events as reader intent and overwrite the durable anchor. */
  const restoreInProgressRef = useRef(false);
  /** Latest reader-owned position, including a pre-detach synchronous capture.
   * The pane can reattach in the same commit, before a store render occurs. */
  const lastScrollPositionRef = useRef<ChatScrollPosition | undefined>(
    chatId ? useSessionsStore.getState().scrollPositions[chatId] : undefined,
  );
  /** Read by the capture callback declared before the spacer state below. */
  const checkpointSpacerPxRef = useRef(0);

  // ── Settle loop ─────────────────────────────────────────
  // Apply a per-frame-recomputed target for a few frames. One assignment is
  // not enough: at restore time the turns near the target are still laid
  // out at their remembered/estimated sizes, and content-visibility renders
  // them for real only at the next rendering opportunities — each pass
  // re-measures the anchor in the refined layout and converges. A user
  // gesture cancels immediately (the reader always wins).
  const SETTLE_FRAMES = 4;
  const settleCancelRef = useRef<() => void>(() => {});
  const settleEpochRef = useRef(0);
  useEffect(() => () => settleCancelRef.current(), []);
  const settleScroll = useCallback(
    (el: HTMLElement, computeTarget: () => number) => {
      settleCancelRef.current();
      const epoch = settleEpochRef.current + 1;
      settleEpochRef.current = epoch;
      restoreInProgressRef.current = true;
      let raf = 0;
      let remaining = SETTLE_FRAMES;
      let finished = false;
      const apply = () => {
        const target = Math.max(0, computeTarget());
        if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        el.removeEventListener("wheel", finish);
        el.removeEventListener("touchstart", finish);
        el.removeEventListener("pointerdown", finish);
        el.removeEventListener("keydown", finish);
        if (settleEpochRef.current === epoch) {
          restoreInProgressRef.current = false;
        }
      };
      const tick = () => {
        raf = 0;
        remaining -= 1;
        apply();
        if (remaining <= 0) {
          finish();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      apply();
      el.addEventListener("wheel", finish, { passive: true });
      el.addEventListener("touchstart", finish, { passive: true });
      el.addEventListener("pointerdown", finish, { passive: true });
      el.addEventListener("keydown", finish);
      raf = requestAnimationFrame(tick);
      settleCancelRef.current = finish;
    },
    [],
  );
  /** Land on a saved position: the anchor turn's live top + offset, raw px
   *  when the anchor is gone. The rail recompute runs synchronously so the
   *  correct tick is lit before the next paint. */
  const restoreToPosition = useCallback(
    (el: HTMLElement, pos: ChatScrollPosition) => {
      const anchor = pos.anchorId
        ? (Array.from(
            el.querySelectorAll<HTMLElement>("[data-checkpoint-id]"),
          ).find(
            (candidate) =>
              candidate.getAttribute("data-checkpoint-id") === pos.anchorId,
          ) ?? null)
        : null;
      materializeScrollGeometryWithin(el, anchor);
      lastScrollPositionRef.current = pos;
      settleScroll(el, () => restoreTargetTop(el, pos));
      checkpointRecomputeRef.current?.();
    },
    [settleScroll],
  );
  /** Land on the tail — for readers who were following the bottom. The
   *  target re-derives from scrollHeight each settle frame, so content that
   *  re-expands under the viewport still ends flush at the true bottom. */
  const restoreToBottom = useCallback(
    (el: HTMLElement) => {
      // Tail-following does not need every historical turn materialized: the
      // target is re-derived from scrollHeight on each settle pass, and the
      // latest turn is already content-visibility:visible. Avoid putting a
      // cold 200-message transcript's full layout on the workspace click.
      settleScroll(el, () => el.scrollHeight - el.clientHeight);
      checkpointRecomputeRef.current?.();
    },
    [settleScroll],
  );

  // ── Initial position on mount ───────────────────────────
  // Snap to bottom by default (chat convention — "open chat, see latest"),
  // OR restore the saved position when a chat first joins the retained
  // deck / cold-boots. useLayoutEffect so the initial position is set
  // before paint. The rail recompute runs synchronously AFTER the position
  // is set but BEFORE paint, so a chat restored below the top lights the
  // correct tick on the first frame (the rail seeds index 0; its ref is
  // assigned in a child layout effect that has already run here).
  useLayoutEffect(() => {
    if (!scrollEl) return;
    pendingHydrateRestoreRef.current = null;
    if (chatId) {
      const saved = useSessionsStore.getState().scrollPositions[chatId];
      if (saved) {
        // Transcript not hydrated yet (cold boot) — apply best-effort now,
        // re-apply from the post-hydrate effect once messages exist.
        const slotMessages =
          useSessionsStore.getState().sessions[chatId]?.messages;
        if ((slotMessages?.length ?? 0) === 0) {
          pendingHydrateRestoreRef.current = saved;
        }
        if (saved.atBottom) restoreToBottom(scrollEl);
        else restoreToPosition(scrollEl, saved);
        return;
      }
    }
    // No saved position OR no chatId (picker/beta flows) → snap to
    // bottom so the user sees the latest message immediately.
    scrollEl.scrollTop = scrollEl.scrollHeight;
    checkpointRecomputeRef.current?.();
  }, [scrollEl, chatId, restoreToPosition, restoreToBottom]);

  // ── Save on scroll ──────────────────────────────────────
  const captureCurrentPosition = useCallback(
    (el: HTMLElement, force = false) => {
      if (!chatId) return;
      if (
        !shouldCaptureChatScroll({
          force,
          surfaceActive: surfaceActiveRef.current,
          restoreInProgress: restoreInProgressRef.current,
          connected: el.isConnected,
          clientHeight: el.clientHeight,
          pendingHydrate: pendingHydrateRestoreRef.current !== null,
        })
      ) {
        return;
      }
      const pos: ChatScrollPosition = {
        top: el.scrollTop,
        ...(captureScrollAnchor(el) ?? {}),
      };
      const spacer = checkpointSpacerPxRef.current;
      // A checkpoint spacer is deliberate blank navigation room. Being at its
      // max scroll is still "reading this checkpoint", not following latest.
      if (
        isAtChatContentBottom({
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          clientHeight: el.clientHeight,
          bottomInset: spacer,
        })
      ) {
        pos.atBottom = true;
      }
      lastScrollPositionRef.current = pos;
      setScrollPosition(chatId, pos);
    },
    [chatId, setScrollPosition],
  );

  // rAF-coalesced: the anchor capture reads turn rects (cheap — turns are
  // containment boundaries, skipped ones measure their placeholder box),
  // but once per frame is still the right cadence, and the trailing frame
  // records the final resting position. Gates, in order: hidden surface
  // (collapse clamp events are never a reading position), detached /
  // zero-height scroller (same, belt-and-braces), pending cold-boot
  // restore (the pre-hydrate clamp must not overwrite the saved target).
  useEffect(() => {
    if (!scrollEl || !chatId) return;
    let raf = 0;
    const capture = () => {
      raf = 0;
      captureCurrentPosition(scrollEl);
    };
    const onScroll = () => {
      if (restoreInProgressRef.current || !surfaceActiveRef.current) return;
      if (!raf) raf = requestAnimationFrame(capture);
    };
    // The reader taking over before the hydrate lands wins: drop the pending
    // target so their scrolling is saved normally instead of being yanked
    // back when messages arrive.
    const onUserGesture = () => {
      pendingHydrateRestoreRef.current = null;
      settleCancelRef.current();
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    scrollEl.addEventListener("wheel", onUserGesture, { passive: true });
    scrollEl.addEventListener("touchstart", onUserGesture, { passive: true });
    scrollEl.addEventListener("pointerdown", onUserGesture, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scrollEl.removeEventListener("scroll", onScroll);
      scrollEl.removeEventListener("wheel", onUserGesture);
      scrollEl.removeEventListener("touchstart", onUserGesture);
      scrollEl.removeEventListener("pointerdown", onUserGesture);
    };
  }, [scrollEl, chatId, captureCurrentPosition]);

  // Checkpoint bottom spacer (2026-07-16) — extra scroll room injected
  // at the tail of the content column so clicking a LATE checkpoint
  // (usually the last one) can still land its prompt at the TOP of the
  // viewport even when the content below it is shorter than a screen.
  // Owned and sized exclusively by CheckpointRail (it grows the spacer
  // on click — to the EXACT shortfall, no slack — and shrinks/removes
  // it as streaming content fills the gap or once it scrolls out of
  // view); it merely RENDERS here because it has to live inside the
  // scroll content for scrollHeight to include it. Declared above
  // useStickyBottom because the hook needs it as bottomInsetPx.
  const [checkpointSpacerPx, setCheckpointSpacerPx] = useState(0);
  checkpointSpacerPxRef.current = checkpointSpacerPx;

  // Sticky-bottom auto-scroll with unstick-on-user-scroll. Replaces
  // the Phase 0 "snap to bottom on every change" reflex. See
  // use-sticky-bottom.ts for the rationale. The hook skips its first
  // content-run so the restore effect above takes precedence on mount.
  // bottomInsetPx: the checkpoint spacer is blank scroll room, not
  // content — while it's active the auto-snap pauses (the rail owns
  // viewport stability there), "at bottom" means the CONTENT bottom
  // (so the jump pill doesn't appear over the deliberate blank tail —
  // 2026-07-16 user report), and jumpToBottom targets the content
  // bottom instead of the blank.
  // Seed the sticky hook's at-bottom state from the SAVED position, read
  // once at mount. A chat prepared/mounted hidden is never measured until
  // reveal — with the default `true` seed, a mid-transcript restore would
  // read as a tail-follower and snap to the bottom on the first content
  // change after reveal.
  const initialAtBottomRef = useRef<boolean | null>(null);
  if (initialAtBottomRef.current === null) {
    const saved = chatId
      ? useSessionsStore.getState().scrollPositions[chatId]
      : undefined;
    initialAtBottomRef.current = saved ? saved.atBottom === true : true;
  }
  const { isAtBottom, jumpToBottom } = useStickyBottom(
    scrollEl,
    [session.messages, session.pendingPermission, session.status],
    // enabled: measurement + auto-snap FREEZE while this chat is a hidden
    // retained layer — the content-visibility collapse otherwise clamps
    // scrollTop and the resulting events would mark every hidden chat
    // "at bottom", poisoning both the jump pill and the reattach restore.
    {
      bottomInsetPx: checkpointSpacerPx,
      enabled: surfaceActive,
      initialAtBottom: initialAtBottomRef.current,
    },
  );
  // Honor the cold-boot saved position once the SQLite hydrate lands.
  // Declared AFTER useStickyBottom on purpose: the hook's own layout effect
  // fires first on this same messages change and may snap to bottom (it
  // measured the pre-hydrate empty transcript as "at bottom"); running
  // after it, this re-applies the real target inside the same commit, so
  // the reader never sees either intermediate frame.
  useLayoutEffect(() => {
    const pending = pendingHydrateRestoreRef.current;
    if (pending === null || !scrollEl) return;
    if (session.messages.length === 0) return;
    pendingHydrateRestoreRef.current = null;
    if (pending.atBottom) restoreToBottom(scrollEl);
    else restoreToPosition(scrollEl, pending);
  }, [session.messages, scrollEl, restoreToPosition, restoreToBottom]);

  // A Home/repository/settings round-trip keeps the pane host connected, so
  // ChatPane's reattach callback does not run. Restore on every hidden→active
  // transition as well; this layout effect runs after the layer's visibility
  // mutation and before paint. It also covers an intent-prepared chat that was
  // first mounted off-screen.
  const previousSurfaceActiveRef = useRef(surfaceActive);
  useLayoutEffect(() => {
    const wasActive = previousSurfaceActiveRef.current;
    previousSurfaceActiveRef.current = surfaceActive;
    if (wasActive || !surfaceActive || !scrollEl) return;
    const saved =
      lastScrollPositionRef.current ??
      (chatId
        ? useSessionsStore.getState().scrollPositions[chatId]
        : undefined);
    if (saved?.atBottom || !saved) restoreToBottom(scrollEl);
    else restoreToPosition(scrollEl, saved);
  }, [surfaceActive, scrollEl, chatId, restoreToPosition, restoreToBottom]);

  // Reattach restoration. A workspace switch detaches the pane host (the
  // store-owned node parks outside the document — see column2-pane-stores),
  // and Chromium zeroes every scroller in a detached subtree even though
  // the DOM survives. ChatPane calls restoreScrollWithin(host) right after
  // reparenting; this callback puts the transcript back — the anchor turn
  // returns to its saved viewport offset for a mid-transcript reader, or
  // the (possibly newer) bottom for a tail-follower, so a chat that kept
  // streaming while hidden resumes following instead of landing on a stale
  // offset. Capture is registered alongside restore so ChatPane can flush the
  // final compositor position synchronously before it removes the old host.
  useEffect(() => {
    if (!scrollEl) return;
    return registerScrollRestore(
      scrollEl,
      () => {
        const saved =
          lastScrollPositionRef.current ??
          (chatId
            ? useSessionsStore.getState().scrollPositions[chatId]
            : undefined);
        if (saved?.atBottom || !saved) {
          restoreToBottom(scrollEl);
          return;
        }
        restoreToPosition(scrollEl, saved);
      },
      () => captureCurrentPosition(scrollEl, true),
    );
  }, [
    scrollEl,
    chatId,
    captureCurrentPosition,
    restoreToPosition,
    restoreToBottom,
  ]);

  // Phase 2 §2.11.4, reworked 2026-07-06 (user spec: no "Load older"
  // pill — scrolling back should just show everything, invisibly).
  // The Phase 0 hydrate pulls the most-recent 200 messages on chat
  // open; older transcript sits on disk and auto-pages in as the user
  // scrolls toward the top. loadOlder preserves the viewport (scrollTop
  // is bumped by the prepend's height delta), so paging never yanks the
  // content the user is reading.
  const LOAD_OLDER_PAGE = 200;
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Whether more older messages might exist on disk. Phase 2 chat
  // overhaul (2026-05-07): default to FALSE on chat mount and probe
  // SQLite once with a single-row read so a brand-new chat with zero
  // on-disk history never triggers a pointless load.
  const [hasOlder, setHasOlder] = useState(false);
  // Auto-load fires when the user scrolls within NEAR_TOP_PX of the
  // top — far enough out that the next page is usually in place before
  // they hit the edge, close enough that a chat parked mid-transcript
  // never pages in history nobody asked for.
  const NEAR_TOP_PX = 600;
  const [nearTop, setNearTop] = useState(false);
  useEffect(() => {
    if (!scrollEl || !surfaceActive) return;
    const onScroll = () => {
      if (!surfaceActiveRef.current || restoreInProgressRef.current) return;
      setNearTop(scrollEl.scrollTop <= NEAR_TOP_PX);
    };
    setNearTop(scrollEl.scrollTop <= NEAR_TOP_PX);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl, surfaceActive]);

  // Chat scrollbar — reveal ONLY while actively scrolling (the macOS overlay-
  // scrollbar feel), not merely while the pane is hovered. Flags the scroll
  // element with `data-scrolling` during scroll, clearing it ~700ms after the
  // last scroll event. Direct DOM (no React state) so the high-frequency scroll
  // stream never re-renders the transcript; globals.css keys the
  // `.zeros-agent-scrollbar` thumb visibility off this attribute.
  useEffect(() => {
    if (!scrollEl) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (!surfaceActiveRef.current || restoreInProgressRef.current) return;
      scrollEl.dataset.scrolling = "true";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        delete scrollEl.dataset.scrolling;
      }, 700);
    };
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
      delete scrollEl.dataset.scrolling;
    };
  }, [scrollEl]);

  // Trigger the probe on chat-id change, on hydrate (empty → non-empty),
  // AND whenever the OLDEST message id changes — that catches in-memory
  // reorderings (e.g. rebuild-and-retry inserts a resume marker BEFORE
  // the user prompt, which changes which message holds index 0).
  // Without that re-run the probe's hasOlder state would persist with
  // a stale answer.
  const hasAnyMessages = session.messages.length > 0;
  const oldestMsgId = session.messages[0]?.id;
  useEffect(() => {
    if (!chatId || !hasAnyMessages) {
      setHasOlder(false);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      const slot = useSessionsStore.getState().sessions[chatId];
      const oldest = slot?.messages[0];
      if (!oldest) {
        if (!cancelled) setHasOlder(false);
        return;
      }
      try {
        const rows = await ipcWindowOlderMessages(chatId, 1, oldest.id);
        if (cancelled) return;
        if (rows.length === 0) {
          setHasOlder(false);
          return;
        }
        // Phase D3 (2026-05-08): dedup against the current in-memory
        // tail. SQLite's `ord` is arrival-order, but in-memory order
        // can drift when we visually reorder messages (e.g. inserting
        // a resume-boundary marker BEFORE the user prompt after a
        // session rebuild). The probe would otherwise return the user
        // message as "older than the marker" — true by ord, but it's
        // already in memory, so the affordance would be a lie.
        const present = new Set(slot.messages.map((m) => m.id));
        const hasGenuineOlder = rows.some((r) => !present.has(r.id));
        setHasOlder(hasGenuineOlder);
      } catch {
        // SQLite/IPC unavailable (browser harness) — leave hasOlder
        // at false; loadOlder is a no-op there anyway.
        if (!cancelled) setHasOlder(false);
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, [chatId, hasAnyMessages, oldestMsgId]);
  const loadOlder = useCallback(async () => {
    if (!chatId) return;
    if (loadingOlder) return;
    const slot = useSessionsStore.getState().sessions[chatId];
    const oldest = slot?.messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const older = await ipcWindowOlderMessages(
        chatId,
        LOAD_OLDER_PAGE,
        oldest.id,
      );
      if (older.length === 0) {
        setHasOlder(false);
        return;
      }
      // Dedup against the in-memory tail in case of overlap.
      const present = new Set(slot.messages.map((m) => m.id));
      const fresh = older.filter((m) => !present.has(m.id));
      if (fresh.length === 0) {
        // SQLite returned only messages already in memory — treat as no-more.
        setHasOlder(false);
        return;
      }
      // Preserve viewport position: the prepend grows scrollHeight; we
      // add the delta to scrollTop so the user sees the same content
      // they were reading rather than getting yanked to the new top.
      const heightBefore = scrollEl?.scrollHeight ?? 0;
      const topBefore = scrollEl?.scrollTop ?? 0;
      useSessionsStore.getState().patchSession(chatId, {
        messages: [...fresh, ...slot.messages],
        // Suspend the live-append trim (MAX_MESSAGES_PER_CHAT) while the
        // reader holds expanded history — see the re-arm effect below.
        historyExpanded: true,
      });
      requestAnimationFrame(() => {
        if (
          !scrollEl ||
          !surfaceActiveRef.current ||
          restoreInProgressRef.current
        ) {
          return;
        }
        const heightAfter = scrollEl.scrollHeight;
        const delta = heightAfter - heightBefore;
        if (delta > 0) scrollEl.scrollTop = topBefore + delta;
      });
      // If the page wasn't full, no point offering another load.
      if (older.length < LOAD_OLDER_PAGE) setHasOlder(false);
    } catch (err) {
      console.warn("[Zeros] load-older failed:", err);
    } finally {
      setLoadingOlder(false);
    }
  }, [chatId, loadingOlder, scrollEl]);
  // Auto-page older history while the user is near the top. Each load
  // prepends a page and pushes the viewport down by the same height, so
  // the post-load scroll event re-evaluates `nearTop` — if the user keeps
  // pulling up, the next page chains; if they stop, so does the loading.
  // Exhausting disk history flips `hasOlder` off and ends the cycle.
  useEffect(() => {
    if (
      !surfaceActive ||
      !scrollEl ||
      restoreInProgressRef.current ||
      scrollEl.scrollTop > NEAR_TOP_PX ||
      !nearTop ||
      !hasOlder ||
      loadingOlder
    ) {
      return;
    }
    void loadOlder();
  }, [surfaceActive, scrollEl, nearTop, hasOlder, loadingOlder, loadOlder]);
  // Re-arm the message cap once the reader is back at the bottom: trim to
  // the usual live window in one shot (they can't be reading the trimmed
  // rows from down there) and clear historyExpanded so streaming appends
  // cap normally again. Disk stays the source of truth — scrolling up
  // just auto-pages the trimmed rows back in.
  useEffect(() => {
    if (!chatId || !isAtBottom) return;
    const slot = useSessionsStore.getState().sessions[chatId];
    if (!slot?.historyExpanded) return;
    useSessionsStore.getState().patchSession(chatId, {
      historyExpanded: false,
      messages:
        slot.messages.length > MAX_MESSAGES_PER_CHAT
          ? slot.messages.slice(-MAX_MESSAGES_PER_CHAT)
          : slot.messages,
    });
  }, [chatId, isAtBottom]);

  // Group flat message list into turns for the §2.5.1 per-turn
  // structure. Each turn = user prompt + subsequent events until
  // the next user prompt. Memoized so unrelated state changes
  // (composer typing, etc.) don't re-group.
  // The mode_switch kind was removed entirely (2026-07-06 — the active mode
  // already shows on the composer pills), but chats persisted by older builds
  // can still hydrate such rows; drop them before grouping so they neither
  // render as an unknown-kind row nor form an empty leading turn.
  const stableTurnsRef = useRef<ReturnType<typeof groupMessagesIntoTurns>>([]);
  const turns = useMemo(
    () =>
      stabilizeTurns(
        stableTurnsRef.current,
        groupMessagesIntoTurns(
          visibleMessages.filter((m) => (m.kind as string) !== "mode_switch"),
        ),
      ),
    [visibleMessages],
  );
  // Only a committed render becomes the baseline. Mutating this ref inside
  // useMemo lets an abandoned concurrent render influence the next pass.
  useLayoutEffect(() => {
    stableTurnsRef.current = turns;
  }, [turns]);

  // Checkpoint list for the left-edge rail — one entry per user prompt,
  // transcript order. Ids match the data-checkpoint-id TurnContainer
  // stamps on each turn's wrapper (the rail measures those wrappers).
  //
  // Referentially stabilized: `turns` is rebuilt on every streamed chunk
  // (visibleMessages grows as assistant content appends), which would
  // otherwise hand `checkpoints` a fresh array each chunk even though no
  // user prompt changed — defeating CheckpointRail's memo and re-firing
  // its `[checkpoints]` effect, whose recompute() reads every
  // checkpoint's rectangle (O(checkpoints) layout per chunk in a long
  // streaming chat). Hold the PREVIOUS array while the prompts are
  // unchanged (same ids + preview text); a real prompt add / edit /
  // truncate still yields a new reference the rail reacts to.
  const stableCheckpointsRef = useRef<Checkpoint[]>([]);
  const checkpoints = useMemo(() => {
    const next = turns.flatMap((t) =>
      t.userPrompt ? [{ id: t.userPrompt.id, text: t.userPrompt.text }] : [],
    );
    if (sameCheckpoints(stableCheckpointsRef.current, next)) {
      return stableCheckpointsRef.current;
    }
    stableCheckpointsRef.current = next;
    return next;
  }, [turns]);

  // Send-jump (2026-07-17 user spec, replacing the 2026-07-16
  // send-follow): sending never re-frames the sent prompt to the top
  // of the viewport — that framing is exclusively the checkpoint
  // rail's click behavior. A send only guarantees the message is SEEN:
  // when the new turn renders OUT of view (the reader had scrolled
  // up), the chat scrolls down to the bottom — the standard chat
  // pattern — and sticky-bottom takes over from there. A reader
  // already at (or near) the bottom needs nothing: sticky-bottom's
  // layout effect runs before this passive effect and has snapped the
  // prompt into the viewport, so the geometric check below finds it on
  // screen and this no-ops.
  //
  // The send handlers arm the count; the effect fires when the LAST
  // checkpoint id changes (the new turn rendered — covers direct
  // sends, queued sends at dispatch time, and edit-and-resubmit, which
  // truncates and appends a fresh id). Keyed on the last ID, not the
  // list length: history paging PREPENDS (last id unchanged) and must
  // never consume the count, while an edit of the latest prompt can
  // change the id without changing the count. Consumes ONE pending
  // send per last-id change so a burst of queued sends — which
  // dispatch one per turn, each producing its own new last id — each
  // get their own visibility check in turn.
  const prevLastCheckpointIdRef = useRef<string | null>(null);
  useEffect(() => {
    const lastId =
      checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].id : null;
    const prevLastId = prevLastCheckpointIdRef.current;
    prevLastCheckpointIdRef.current = lastId;
    if (pendingSendScrollCountRef.current <= 0) return;
    if (lastId === null || lastId === prevLastId) return;
    pendingSendScrollCountRef.current -= 1;
    const el = scrollRef.current;
    if (!el) return;
    // Any meaningful sliver (>32px, past layout-rounding + edge
    // slivers) of the prompt inside the viewport counts as "the user
    // can see their message" — including a pasted wall of text whose
    // top edge sits above the viewport while its tail is on screen.
    const turnEl = el.querySelector<HTMLElement>(
      `[data-checkpoint-id="${CSS.escape(lastId)}"]`,
    );
    if (turnEl) {
      const containerTop = el.getBoundingClientRect().top;
      const rect = turnEl.getBoundingClientRect();
      const top = rect.top - containerTop;
      const bottom = rect.bottom - containerTop;
      if (top < el.clientHeight - 32 && bottom > 32) return;
    }
    jumpToBottom(true);
  }, [checkpoints, jumpToBottom]);

  // Callback ref factory for the scroll container — sets both the
  // state-tracked element (for hooks that need re-render on mount)
  // and the legacy imperative ref (read by the keybind handler).
  const setScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollEl(node);
  }, []);

  // ⌘K — focus the composer from anywhere in the app. Cursor-style
  // shortcut; scoped to avoid clobbering ⌘K inside native inputs.
  // ⌘↑ / ⌘↓ — jump-by-text-message: walks user prompts and final
  // assistant text, skipping tool-call + thinking chunks. Solves the
  // "where did I ask?" problem during long Claude runs (roadmap §2.5.7).
  // ⌘Home / ⌘End — first/last message. All gated on the textarea
  // not being focused so plain typing keeps native behavior.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!surfaceActive) return;
      if (!(e.metaKey || e.ctrlKey)) return;

      // Remaining bindings need plain ⌘ (no shift/alt).
      if (e.shiftKey || e.altKey) return;

      // Split panes (2026-07-17): multiple AgentChat instances can be
      // mounted at once. Only the FOCUSED pane's chat (the global
      // active chat) owns these app-wide bindings — otherwise ⌘K would
      // focus every composer and ⌘↑/↓ would scroll every pane. Chats
      // mounted without a chatId (picker/beta flows) keep them.
      if (chatId) {
        const workspaceState = useWorkspaceStore.getState();
        if (
          workspaceState.activePage !== "workspace" ||
          workspaceState.activeChatId !== chatId
        ) {
          return;
        }
      }

      // ⌘K is composer-focus; allowed even when in an input
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        composerFocusRef.current();
        return;
      }

      // Skip jump-by-message bindings while typing — preserves
      // native cursor/selection behavior in the textarea.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;

      const el = scrollRef.current;
      if (!el) return;

      if (e.key === "ArrowUp") {
        const top = nextTextMessageTarget(el, { direction: "up" });
        if (top !== null) {
          e.preventDefault();
          el.scrollTo({ top, behavior: "smooth" });
        }
        return;
      }
      if (e.key === "ArrowDown") {
        const top = nextTextMessageTarget(el, { direction: "down" });
        if (top !== null) {
          e.preventDefault();
          el.scrollTo({ top, behavior: "smooth" });
        }
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        el.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chatId, surfaceActive]);

  // File picker for the "+" → "Add attachment" menu (routes through the
  // editor's insertFiles, same as drag-drop / paste).
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Wire the messageCtx forward-ref so user-bubble image clicks reuse the
  // composer's lightbox.
  openPreviewRef.current = openPreview;
  // Live-draft mirror: the editor's onChange snapshots the composer into
  // composerLiveRef (read synchronously by the sidebar's "+ New Agent") and
  // into the module-level ref. Store persistence happens when the retained
  // surface is parked and again on bounded eviction/unmount.
  const updateLiveDraft = useCallback(() => {
    if (!chatId) return;
    const s = serializeComposerState();
    if (!s || s.isEmpty) {
      composerLiveRef.current = { text: "", attachments: [], json: null };
      setLiveChatDraft(chatId, null);
      return;
    }
    const draft = {
      text: s.displayText,
      attachments: s.attachments,
      json: s.json,
    };
    composerLiveRef.current = draft;
    setLiveChatDraft(chatId, { ...draft });
  }, [chatId, serializeComposerState]);
  updateLiveDraftRef.current = updateLiveDraft;
  const persistComposerDraft = useCallback(() => {
    if (!chatId) return;
    const { text, attachments: atts, json } = composerLiveRef.current;
    if (text.trim() === "" && atts.length === 0) {
      dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
      return;
    }
    dispatch({
      type: "SET_CHAT_DRAFT",
      chatId,
      draft: { text, attachments: atts, json },
    });
  }, [chatId, dispatch]);
  useEffect(() => {
    return () => {
      if (!chatId) return;
      setLiveChatDraft(chatId, null);
      persistComposerDraft();
    };
  }, [chatId, persistComposerDraft]);

  // The error states `failed` / `auth-required` no longer lock the composer
  // (2026-07-10, see canSend below) — sending IS the retry affordance. This
  // flag now only drives the error-feedback surfaces: the toast effect below
  // and the Send button's "error" tint.
  const isErrorState =
    session.status === "failed" || session.status === "auth-required";

  // 01u (2026-05-20): error feedback moved to the toast surface.
  // 01w (2026-05-20): toast now leads with the agent name so the
  // user sees "Claude Code: …" instead of "Error: …". Also fires the
  // session.failure.message as the description for context (e.g.
  // "CLI exited with code 143 signal=null"). Inline error banners are gone;
  // reset is a settings/menu affordance.
  const lastErrorLabelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!surfaceActive) {
      lastErrorLabelRef.current = null;
      return;
    }
    if (!isErrorState) {
      lastErrorLabelRef.current = null;
      return;
    }
    const label = labelForFailure(session.failure, session.status);
    if (lastErrorLabelRef.current === label) return;
    lastErrorLabelRef.current = label;
    const agentLabel = session.agentName ?? session.agentId ?? "Agent";
    const detail = session.failure?.message ?? session.error ?? undefined;
    // Defense in depth — even if a future code path forgets to route a
    // recoverable error through classifyRpcError + statusForFailure,
    // the toast itself should not surface transport-layer noise as a
    // hard agent error. `isTransportShaped` is shared with the
    // classifier so both call sites use the same definition.
    if (isTransportShaped(detail)) {
      return;
    }
    // The technical detail is for logs, never for the toast (UI-indication
    // consolidation, 2026-07-10): the user can't act on "cursor-sdk
    // newSession failed: …exited unexpectedly…" — they only need to know
    // WHICH agent errored. Full detail stays greppable here + in the engine
    // log for support/diagnosis.
    if (detail) console.warn(`[agent] ${agentLabel} failure: ${detail}`);
    // One indication per failure, not two (type-2 pill vs type-4 toast): a
    // PROMPT-stage failure already surfaces inside the chat as the turn
    // footer's full-stop pill (AGENT EXITED / SESSION EXPIRED / SIGN IN
    // REQUIRED / …) directly under the message that failed — a toast on top
    // double-signals the same event. Toasts are reserved for failures with
    // NO in-chat surface (initialize / newSession / loadSession — the chat
    // has no turn to pin a pill on). Exceptions: auth-required keeps its
    // toast at every stage, and so does any failure carrying `advice` (e.g.
    // the cursor host crash-loop guard) — both name the one actionable next
    // step, which the pill's generic label can't.
    const isAuth =
      session.status === "auth-required" ||
      session.failure?.kind === "auth-required";
    // `advice` is user-facing by contract (AgentFailure.advice) — unlike
    // `message` it's written for the toast, not the log.
    const advice = session.failure?.advice;
    const pillAlreadyShows =
      session.failure?.stage === "prompt" && !isAuth && !advice;
    if (!pillAlreadyShows) {
      toast.error(`${agentLabel}: ${label}`, {
        // De-dup: repeats of the same chat's error REPLACE the toast
        // instead of stacking identical copies (field report 2026-07-10).
        id: `agent-error-${chatId ?? agentLabel}`,
        description: isAuth
          ? `Open Settings → Agent providers to sign in to ${agentLabel}.`
          : advice,
      });
    }
    // Auth probe is a heuristic (file-existence on ~/.codex/auth.json
    // and friends). When the actual CLI rejects on spawn the engine
    // throws auth-required and gateway.markAuthFailed flips its
    // runtimeAuthFailed map — but the renderer's agents-cache won't
    // see that change until something triggers a re-fetch. Force one
    // here on any prompt failure: the gateway's gate is also widened
    // to mark auth-failed on prompt-stage protocol errors (most often
    // "no events" because the CLI isn't signed in), and we want both
    // sides to converge on the same authoritative state without
    // requiring the user to alt-tab away and back.
    if (session.status === "auth-required" || session.status === "failed") {
      invalidateAgentsCache();
      void refreshAgents((force) => agentSessions.listAgents(force)).catch(
        () => {
          /* surfaced by the cache via toast */
        },
      );
    }
  }, [
    isErrorState,
    session.failure,
    session.status,
    session.error,
    session.agentName,
    session.agentId,
    agentSessions,
    chatId,
    surfaceActive,
  ]);
  // ── Plan review (Claude's ExitPlanMode) ─────────────────────────────────
  // Plan review is NOT a permission gate. A regular Allow/Deny REPLACES the
  // composer (see <PermissionCard>); a pending plan keeps the composer LIVE so
  // the user can Approve, Copy, or type a follow-up to refine it. Detection
  // lives in isPlanReviewRequest (plan-body.ts) — shared with the sidebar/tab
  // awaiting-kind selectors: ExitPlanMode title or a `plan` body, NOT kind
  // (Claude sends kind="other"; Codex's bodiless "Expand permissions"
  // escalation is kind=switch_mode but a real gate → the permission card).
  const planReview = useMemo(() => {
    const p = session.pendingPermission;
    if (!p) return null;
    return isPlanReviewRequest(p.request) ? p : null;
  }, [session.pendingPermission]);

  // Approve the plan → allow the gate, then leave Plan mode (else the Plan pill
  // stays stuck on and the next turn re-plans instead of executing).
  const approvePlan = useCallback(() => {
    const p = session.pendingPermission;
    if (!p) return;
    const opt =
      p.request.options.find((o) => o.kind === "allow_once") ??
      p.request.options.find((o) => o.kind === "allow_always");
    if (!opt) return;
    respondToPermission({
      outcome: { outcome: "selected", optionId: opt.optionId },
    });
    exitPlanMode();
  }, [session.pendingPermission, respondToPermission, exitPlanMode]);

  // Typing a follow-up during plan review = "don't approve as-is." Deny the
  // gate WITHOUT interrupt (the adapter keeps Claude planning, doesn't kill the
  // turn), so the follow-up handleSend queues next lands as revision context.
  const denyPlanReview = useCallback(() => {
    const p = session.pendingPermission;
    if (!p) return;
    const opt =
      p.request.options.find((o) => o.kind === "reject_once") ??
      p.request.options.find((o) => o.kind === "reject_always");
    respondToPermission(
      opt
        ? { outcome: { outcome: "selected", optionId: opt.optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
  }, [session.pendingPermission, respondToPermission]);

  // During plan review the turn is PAUSED on the user, so the composer reads as
  // idle (Send a follow-up / Approve) rather than streaming (Stop).
  const composerStreaming = session.status === "streaming" && !planReview;

  // Mid-turn steering (queued-card "Send now" while running): advertised by
  // the adapter at session creation. Claude/Codex support it; Cursor doesn't
  // — its arrow disables with a tooltip while a turn is in flight.
  const steeringSupported =
    session.initialize?.agentCapabilities?.steering === true;
  const steeringAgentName =
    session.agentName ??
    chatThread?.agentName ??
    session.agentId ??
    "This agent";

  // Context gauge (§3.5): the ring + breakdown popover beside Send. Cursor's
  // SDK reports no token usage and has no compaction call — its ring renders
  // disabled with an honest popover note (user decision 2026-07-12) instead
  // of an invented number. Compact-now: ONE path for every agent —
  // compactContext → AGENT_COMPACT (Codex: thread/compact/start RPC; Claude:
  // "/compact" fed turnless into the SDK stream). No user bubble; the
  // standalone compaction row is the feedback.
  const gaugeFamily = agentFamily(chatThread?.agentId ?? session.agentId);
  const contextUnavailableReason =
    gaugeFamily === "cursor"
      ? "Context usage is unavailable for Cursor."
      : undefined;
  const handleCompactNow = useCallback(() => {
    if (gaugeFamily === "claude" || gaugeFamily === "codex") {
      void session.compactContext?.();
    }
  }, [gaugeFamily, session]);
  const supportsCompactNow =
    gaugeFamily === "claude" || gaugeFamily === "codex";

  // ONE permission card takes the composer's slot for a pending Allow/Deny —
  // EXCEPT Claude's plan review, which keeps the composer live (planReview →
  // <PlanReviewCard>). Codex's bodiless switch_mode escalation is a real gate,
  // so it still routes here.
  const permissionCardActive = !!session.pendingPermission && !planReview;

  // Blocking user-input question at the queue head. Precedence: a permission
  // (harder gate) shows first; the question surfaces once it's answered. Like
  // the permission card, an active question REPLACES the composer.
  const pendingQuestion = session.pendingQuestions?.[0] ?? null;
  const questionCardActive = !!pendingQuestion && !permissionCardActive;

  // While either card holds the composer's slot, the composer card below is
  // display:none — NOT unmounted, so the typed draft + inline attachment
  // pills survive the interruption. Everything anchored to the concealed
  // composer must close: popover content portals to <body>, so once the
  // trigger loses its layout box Radix's popper has a zero-rect anchor and
  // re-parks the still-open popover at the viewport's top-left corner. The
  // "+" menu closes via plusMenuOpen below; the ModelPill popover via
  // ComposerConcealedContext (composer-pills.tsx).
  const composerConcealed =
    !surfaceActive || permissionCardActive || questionCardActive;
  // Live mirror for the always-focus guardian's document listener, so it can
  // read the current concealment without re-subscribing on every card toggle.
  const composerConcealedRef = useRef(composerConcealed);
  composerConcealedRef.current = composerConcealed;
  useEffect(() => {
    if (composerConcealed) setPlusMenuOpen(false);
  }, [composerConcealed]);

  // Auto-focus this chat's composer whenever it becomes the single active
  // ("focused") chat window. Creating a new tab, switching tabs, clicking into
  // another split pane, and opening a chat from History ALL set this chat as
  // the global activeChatId, so one effect covers every "the composer should be
  // focused" case the product asks for. It also SUBSUMES the old "hand focus
  // back when a permission/question card resolves" behavior — composerOwnsFocus
  // folds in !composerConcealed, so answering a card that returns the composer
  // re-focuses too. Gated on activeChatId===chatId so exactly ONE composer ever
  // pulls focus: a split mounts several AgentChats that are all surfaceActive at
  // once, but only the focused window's chat is the global active chat. The
  // held-elsewhere guard means a pane/tab click (focus lands on <body> or a tab
  // button) focuses, while clicking straight into another input/menu/dialog —
  // or into column 3 (Files/Changes/Review/Terminal), which lives OUTSIDE this
  // window's pane — is left alone, so a card resolving in the background can't
  // yank focus off the surface the user moved to. See composer-focus.ts for the
  // pure, unit-tested rules.
  const acquiredComposerFocusRef = useRef(false);
  useEffect(() => {
    const action = nextComposerFocusAction({
      owns: composerOwnsFocus({ chatId, activeChatId, composerConcealed }),
      hasAcquired: acquiredComposerFocusRef.current,
      editorReady: !!composerEditor,
    });
    if (action === "release") {
      // Lost ownership (switched away / a card took the slot) — clear the latch
      // so returning to this chat focuses again.
      acquiredComposerFocusRef.current = false;
      return;
    }
    if (action !== "focus") return;
    acquiredComposerFocusRef.current = true;
    // Defer one microtask: a just-revealed retained layer clears its `inert`
    // this commit, and a pane/tab click blurs the previous composer as its
    // default action — both must settle before we read document.activeElement
    // and move focus.
    queueMicrotask(() => {
      // A fast re-switch may have moved on since the effect ran.
      if (chatId && useWorkspaceStore.getState().activeChatId !== chatId)
        return;
      const paneRoot =
        composerEditor?.view.dom.closest("[data-pane-root]") ?? null;
      if (
        isFocusHeldElsewhere({
          activeElement: document.activeElement,
          paneRoot,
        })
      )
        return;
      composerFocusRef.current();
    });
  }, [chatId, activeChatId, composerConcealed, composerEditor]);

  // ── "Composer always focused in the chat column" guardian ────────────────
  // The rising-edge effect above focuses the composer when this chat BECOMES
  // the active window (new tab, tab switch, pane switch, card resolve). But a
  // click WITHIN the already-active window — reading the transcript, scrolling,
  // hitting a message action button, clicking empty space — blurs the composer
  // to <body> WITHOUT changing activeChatId or composerConcealed, so that effect
  // never re-runs and focus stayed lost until the next window switch. That gap
  // is the "auto-focus doesn't work all the time" report (2026-07-22).
  //
  // This guardian closes it: a real pointer click anywhere inside the active
  // window returns focus to its composer, so the user can always just type. It
  // stands down for column 3 (Files/Changes/Review/Terminal — clicks there land
  // OUTSIDE this window's pane), other panes, transcript text selection, and
  // real inputs/menus/dialogs (see shouldReclaimComposerFocus). Capture phase
  // means we observe every click (even ones a child stops from bubbling).
  //
  // The re-check is deferred with setTimeout(0) — a MACROTASK — not a
  // microtask. A microtask checkpoint runs the moment the CAPTURE listener
  // returns, BEFORE the event has even propagated to the click target's own
  // handlers: a queueMicrotask defer therefore read the world as it was
  // before the click did anything, and reclaiming focus at that instant
  // raced Radix triggers mid-open — the composer's model dropdown flashed
  // open and instantly closed (2026-07-24 report). A macrotask runs after
  // the full dispatch AND React's synchronous commit, so a popover the click
  // opened is mounted (see hasOpenOverlay below) and focus reads are stable.
  // Attached while this pane is on screen; the live owns-check gates it to the
  // single active window, and self-focus can't loop (it fires no click).
  useEffect(() => {
    if (!surfaceActive || !composerEditor) return;
    const composerDom = composerEditor.view.dom as HTMLElement;
    const onClick = (e: MouseEvent) => {
      // Keyboard/programmatic clicks (detail 0) don't yank focus — keyboard
      // users keep the tab-nav target they deliberately moved to.
      if (e.detail === 0) return;
      const target = e.target as Element | null;
      const paneRoot = composerDom.closest("[data-pane-root]");
      const interactionInsidePane =
        !!paneRoot && !!target && paneRoot.contains(target);
      // Cheap early-out before scheduling: a click outside this window is never
      // ours (column 3, another pane, the top bar).
      if (!interactionInsidePane) return;
      setTimeout(() => {
        if (!surfaceActiveRef.current) return;
        const selection = window.getSelection();
        if (
          shouldReclaimComposerFocus({
            owns: composerOwnsFocus({
              chatId,
              activeChatId: useWorkspaceStore.getState().activeChatId,
              composerConcealed: composerConcealedRef.current,
            }),
            interactionInsidePane,
            composerHasFocus: composerDom.contains(document.activeElement),
            hasTextSelection:
              !!selection && selection.rangeCount > 0 && !selection.isCollapsed,
            // A just-opened popover/menu/dialog mounts synchronously during
            // the click dispatch, but receives FOCUS only after this
            // microtask — probe the DOM, not activeElement, or the reclaim
            // rips focus out of the opening overlay and Radix dismisses it
            // (the "model dropdown can't open" bug, 2026-07-24).
            hasOpenOverlay: !!document.querySelector(OPEN_OVERLAY_SELECTOR),
            activeElement: document.activeElement,
            paneRoot,
          })
        ) {
          composerFocusRef.current();
        }
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [surfaceActive, composerEditor, chatId]);

  // 2026-07-10: `failed` / `auth-required` no longer disable Send. With the
  // inline error banners gone (01u — errors are toasts), a disabled composer
  // made a failed chat a DEAD END: the toast said "retry / send again" but
  // there was nothing to click (field report: cursor host crash-loop → chat
  // permanently locked). Sending from an error state is the retry affordance:
  // handleSend rebuilds the session via startSession — one attempt per
  // explicit user send, never an automatic loop. The Send button keeps its
  // "error" tint (PromptInputSubmit status) so the state still reads.
  const canSend =
    !composerStreaming &&
    !permissionCardActive &&
    !questionCardActive &&
    !composerEmpty;

  // Phase D2 (2026-05-07) iter 3: image attachments are universal —
  // vision-capable agents (Claude) get the inline ImageContent block;
  // everyone else gets the bytes persisted to <cwd>/.context/attachments/…
  // and a text block referencing the path (their models still Read the
  // file). End of "silent drop" era. Shared by handleSend and the
  // queued-message edit save, so an edited queued send re-encodes its
  // attachments exactly like a fresh one.
  //
  // 2026-07-30: the loop moved to encode-attachments.ts, shared with
  // editAndResubmit. It used to be a second, divergent copy with no
  // `kind === "text"` branch and no validation.ok guard — see that module's
  // header for what that cost.
  const encodeComposerAttachments = (localAttachments: ComposerAttachment[]) =>
    encodeAttachments(localAttachments, {
      supportsImage:
        session.initialize?.agentCapabilities?.promptCapabilities?.image !==
        false,
      cwd: chatThread?.folder || null,
      chatId: chatId ?? null,
      agentId: session.agentId ?? chatThread?.agentId ?? null,
    });

  const handleSend = async (
    override?: string,
    extras?: {
      /** Phase D2: inline summary imports from prior chats. Serialized
       *  into <from_previous_chat> text blocks and prepended to the
       *  prompt so the agent reads them as opening context. Used by
       *  the EmptyComposer hand-off path. */
      imports?: import("../store/store").SummaryImport[];
      /** Pre-built ContentBlocks (e.g. image attachments queued in the
       *  EmptyComposer). Appended after the local attachments array
       *  so both sources ride along on the same send. */
      extraAttachments?: ContentBlock[];
      /** Phase D2 iter 4: metadata for the user-bubble chip row.
       *  When the EmptyComposer hands off a new chat, it has already
       *  computed the thumbnails / disk paths for staged files and
       *  passes them here so the seeded message renders the chips
       *  identically to what the user saw in the composer. */
      bubbleAttachments?: import("./use-agent-session").AgentTextMessageAttachment[];
      /** Ordered bubble segments (text + inline pills) for the EmptyComposer
       *  hand-off path; the direct-send path derives them from the editor. */
      bubbleSegments?: MessageContentSegment[];
    },
  ) => {
    // A transcript click starts an engine read and returns immediately (Rule
    // 11), so a cold-cache click followed by a fast Enter would snapshot the
    // composer BEFORE the chip lands: the prompt goes without the transcript,
    // and the read then stages the chip into the freshly-cleared composer,
    // where it silently rides the user's NEXT message. Wait for the reads the
    // user explicitly asked for before snapshotting. Normally a no-op — the
    // hover warmed it, so the set is already empty by the time Enter lands.
    // This is not the forbidden "click handler awaits I/O": Send is the
    // commit, and a commit must include what the user staged.
    if (transcriptAttachesRef.current.size > 0) {
      await Promise.allSettled([...transcriptAttachesRef.current]);
    }
    // Normal send → snapshot the editor (text + inline pills); the hand-off
    // path (override) supplies the text + pre-built blocks directly.
    const snapshot = override === undefined ? serializeComposerState() : null;
    const localAttachments: ComposerAttachment[] = snapshot?.attachments ?? [];
    const rawText = override ?? snapshot?.displayText ?? "";
    const displayText = rawText.trim();
    if (session.pendingPermission) {
      // A non-plan permission is a hard gate — nothing sends until it's
      // answered on the card. Plan review is different: a typed follow-up means
      // "revise the plan," so deny the gate (Claude keeps planning) and fall
      // through — the send below rides as the next prompt. denyPlanReview
      // clears pendingPermission synchronously, so this stays in sync.
      if (!planReview) return;
      denyPlanReview();
    }
    // Inline slash-command actions: a bare `/plan`, `/fast`, `/ultracode` or
    // `/compact` runs the action instead of being sent as a prompt; a terminal
    // command (`/mcp`, `/login`, …) opens the embedded terminal. (The picker
    // path handles the same on select; this covers type-and-Enter.)
    const bareCommand = displayText.match(/^\/([A-Za-z0-9_-]+)$/);
    if (bareCommand && runInlineSlashCommand(bareCommand[1])) {
      if (override === undefined) {
        clearComposer();
        if (chatId) dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
      }
      return;
    }
    const importCount = extras?.imports?.length ?? 0;
    const extraAttachCount = extras?.extraAttachments?.length ?? 0;
    if (
      displayText.length === 0 &&
      localAttachments.length === 0 &&
      importCount === 0 &&
      extraAttachCount === 0
    ) {
      return;
    }
    // A prepared worktree has a complete semantic identity but no usable cwd
    // yet. Keep the TipTap document intact, persist its exact rich snapshot,
    // and enqueue only this chat. Many rapid workspace creates can therefore
    // accept independent first messages without spawning into missing paths or
    // letting the newest request overwrite an older one.
    if (workspaceProvisioning && chatId && override === undefined && snapshot) {
      const draft = {
        text: snapshot.displayText,
        attachments: snapshot.attachments,
        json: snapshot.json,
      };
      composerLiveRef.current = draft;
      dispatch({ type: "SET_CHAT_DRAFT", chatId, draft });
      const alreadyQueued =
        useWorkspaceStore.getState().pendingAutoSend[chatId] === true;
      if (!alreadyQueued) {
        dispatch({ type: "REQUEST_AUTO_SEND", chatId });
        toast.info("Message queued", {
          description:
            "It will send as soon as this workspace finishes setting up.",
          id: `workspace-message-queued-${chatId}`,
        });
      }
      return;
    }
    // Terminal-backed slash commands need the same real-cwd guarantee as an
    // agent turn. During provisioning they were queued above; once the path is
    // published, execute the action instead of sending its literal text.
    if (bareCommand && openTerminalCommand(bareCommand[1])) {
      if (override === undefined) {
        clearComposer();
        if (chatId) dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
      }
      return;
    }
    // Pre-flight auth check. The agent's registry snapshot already
    // tracks installed + authenticated; we read it here so a not-yet-
    // signed-in agent never reaches sendPrompt and produces a confusing
    // "no events" error. Skipped when the snapshot hasn't loaded yet
    // (agentsList === null) so a cold start can't false-positive.
    if (agentsList) {
      const targetAgentId = session.agentId ?? chatThread?.agentId;
      const targetAgent = targetAgentId
        ? agentsList.find((a) => a.id === targetAgentId)
        : undefined;
      if (targetAgentId && !targetAgent) {
        // Registry is loaded (agentsList truthy) but doesn't know this
        // id — the adapter was removed from the product (e.g. the retired
        // `gemini` CLI). Don't fall through to a doomed spawn; the chat
        // view's AgentRemovedPanel offers the switch-agent route.
        toast.error(`${targetAgentId}: Agent no longer available`, {
          description:
            "This agent was removed from Zeros. Switch this chat to an available agent to continue.",
        });
        return;
      }
      if (targetAgent && !isRunnableAgent(targetAgent)) {
        const agentLabel = targetAgent.name ?? targetAgent.id;
        if (!targetAgent.installed) {
          toast.error(`${agentLabel}: Not installed`, {
            description: `Open Settings → Agent providers to install ${agentLabel}.`,
          });
        } else {
          toast.error(`${agentLabel}: Sign in required`, {
            description: `Open Settings → Agent providers to sign in to ${agentLabel}.`,
          });
        }
        return;
      }
    }
    // If the session bounced to warming / reconnecting / failed /
    // auth-required, kick a fresh ensureSession and wait for it before
    // sending. Both error states are recoverable BY EXPLICIT SEND:
    // `auth-required` — the user just fixed their key in Settings →
    // Providers and the error copy says "then send again"; the live session
    // cached the REJECTED key at spawn, so a rebuild re-derives env from the
    // keychain. `failed` (2026-07-10) — e.g. the cursor host crash-loop
    // guard went terminal; the user fixed the environment and sends again,
    // which rebuilds (the host respawns half-open after its hold-off).
    // Either way: if the rebuild fails again we land back here — no retry
    // loop, one attempt per explicit user send.
    if (session.status !== "ready") {
      const targetAgentId = session.agentId ?? chatThread?.agentId;
      if (!targetAgentId) return;
      try {
        // No `force` needed: ensureSession already counts auth-required as
        // "not healthy" and rebuilds (keeping its concurrent-send de-dup);
        // it only early-returns for healthy ready/streaming sessions. cwd
        // resolution rides ensureSession's resolveSpawnCwd (slot + chat
        // store fallback), same as the pre-existing warming path.
        await session.startSession(targetAgentId);
      } catch {
        return;
      }
    }
    // Phase D2: serialize each summary import into a <from_previous_chat>
    // block. The block lives in the wire text only — the user's visible
    // bubble shows just what they typed, so imports are silent context.
    const importPrefix =
      extras?.imports && extras.imports.length > 0
        ? extras.imports
            .map((s) => {
              const nameAttr = (s.title || "prior chat").replace(/"/g, "'");
              const agentAttr = s.agentId ? ` agent="${s.agentId}"` : "";
              return `<from_previous_chat name="${nameAttr}"${agentAttr}>\n${s.summary}\n</from_previous_chat>`;
            })
            .join("\n\n") + "\n\n"
        : "";
    const wireText =
      importPrefix + expandMentionsInText(displayText, browserPickerSelection);
    const {
      blocks: localImageBlocks,
      bubbleAttachments: localBubbleAttachments,
      skipped: skippedAttachments,
    } = await encodeComposerAttachments(localAttachments);
    // Anything the encoder excluded is about to be invisible: the sent bubble
    // renders every staged segment regardless, so a dropped attachment looks
    // exactly like one that arrived. Say so. This is the general guard behind
    // several individually-narrow holes — a verdict stamped under one model
    // and sent under another, a body the edit path can't reconstruct, a disk
    // write that failed — all of which used to end in the agent quietly
    // getting nothing.
    for (const s of skippedAttachments) {
      toast.warning(`"${s.name}" wasn't sent — ${s.reason}.`);
    }
    const extraBlocks: ContentBlock[] = [
      ...localImageBlocks,
      ...((extras?.extraAttachments as ContentBlock[] | undefined) ?? []),
    ];
    const bubbleAttachments = [
      ...localBubbleAttachments,
      ...(extras?.bubbleAttachments ?? []),
    ];
    // Ordered segments for the sent-bubble inline render. Direct send → map
    // the editor's segments (attaching image thumbnails); hand-off → reuse the
    // segments the EmptyComposer already computed.
    const messageSegments: MessageContentSegment[] | undefined =
      override === undefined && snapshot
        ? toMessageSegments(snapshot.segments, localAttachments)
        : extras?.bubbleSegments;
    // Auto-title from the first user message. Only runs once per chat: the
    // tab keeps the seeded default ("Untitled"; "New chat" on legacy
    // persisted chats) until a hidden background one-shot to the chat-title
    // model (Settings → Models → "Custom models") returns a 2–3 word AI
    // title. Deliberately NO instant prompt-snippet stage (removed per the
    // 2026-07-10 spec — slow is fine, the prompt text is not a title). The
    // swap is compare-and-swap against the seeded default, so a manual
    // rename while it generates always wins, and a failed call simply
    // leaves "Untitled".
    if (
      chatId &&
      chatThread &&
      (chatThread.title === "Untitled" || chatThread.title === "New chat") &&
      displayText
    ) {
      requestAiChatTitle({
        chatId,
        agentId: chatThread.agentId ?? session.agentId ?? null,
        prompt: displayText,
        expectedTitle: chatThread.title,
        dispatch,
      });
    }
    if (override === undefined) {
      clearComposer();
    }
    // Phase D3 (2026-05-08): drop any stashed draft for this chat —
    // the user just sent it. Defensive against the cleanup-on-unmount
    // path racing the post-send empty state.
    if (chatId) {
      dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
    }
    // Send-jump: scroll this prompt into view (bottom) once its turn
    // renders, if it landed off screen (see the last-checkpoint-changed
    // effect). Armed after every early-return above so slash-commands /
    // empty sends / auth bounces never leave a stale count; a queued
    // send consumes one at dispatch time, when the message actually
    // enters the transcript. Increment (not set): back-to-back queued
    // sends each get their own visibility check as they dispatch one
    // per turn.
    pendingSendScrollCountRef.current += 1;
    session
      .sendPrompt(
        wireText,
        displayText,
        extraBlocks,
        bubbleAttachments.length > 0 ? bubbleAttachments : undefined,
        messageSegments && messageSegments.length > 0
          ? messageSegments
          : undefined,
      )
      .catch(() => {
        /* error surfaces via session.error */
      });
  };
  // ── Queued-messages card actions ─────────────────────────
  // (Part of the queued-messages redesign — see QueuedMessagesCard.)

  /** Leave queued-edit mode. Restores the stashed pre-edit draft, releases
   *  the provider-side queue hold, and hands focus back to the composer. */
  const exitQueuedEdit = () => {
    if (editingQueuedRef.current == null) return;
    setEditingQueuedId(null);
    setQueueSelectedId(null);
    setComposerContent(
      queueStashRef.current ?? { json: null, attachments: [] },
    );
    queueStashRef.current = null;
    session.releaseQueue?.();
    // setContent doesn't emit an editor change — re-sync the live draft to
    // the restored content explicitly.
    updateLiveDraftRef.current();
    if (surfaceActive) queueMicrotask(() => focusComposer());
  };

  /** Load a queued message into the composer for editing ("Editing queued
   *  message" banner + tick-save). Stashes the current draft; holds the
   *  queue so a settling turn can't flush the edit target mid-edit. */
  const startQueuedEdit = (id: string) => {
    const target = queuedMessages.find((m) => m.id === id);
    if (!target || target.queuedEditable === false) return;
    if (editingQueuedRef.current === id) return;
    if (editingQueuedRef.current == null) {
      // First entry into edit mode — stash the in-progress draft. Switching
      // targets mid-edit keeps the ORIGINAL stash (the queued text in the
      // editor is never worth stashing).
      const s = serializeComposerState();
      queueStashRef.current =
        s && !s.isEmpty ? { json: s.json, attachments: s.attachments } : null;
      session.holdQueue?.();
    }
    setEditingQueuedId(id);
    setQueueSelectedId(id);
    setQueueCollapsed(false);
    setComposerContent(
      messageToEditorContent({
        text: target.text,
        segments: target.segments,
        attachments: target.attachments,
      }),
    );
    queueMicrotask(() => focusComposer());
  };

  /** Persist the composer's content back onto the queued entry (Enter /
   *  tick). Runs the SAME pipeline as a fresh send — mention expansion +
   *  attachment encoding — so nothing degrades through an edit. */
  const saveQueuedEdit = async () => {
    const id = editingQueuedRef.current;
    if (!id || queueSaveInFlightRef.current) return;
    const s = serializeComposerState();
    const displayText = (s?.displayText ?? "").trim();
    const localAttachments = s?.attachments ?? [];
    // Nothing to save — the tick is disabled; Esc cancels, Delete removes.
    if (displayText.length === 0 && localAttachments.length === 0) return;
    queueSaveInFlightRef.current = true;
    try {
      const wireText = expandMentionsInText(
        displayText,
        browserPickerSelection,
      );
      const { blocks, bubbleAttachments } =
        await encodeComposerAttachments(localAttachments);
      const segments = toMessageSegments(s?.segments ?? [], localAttachments);
      session.editQueued?.(id, {
        text: wireText,
        displayText,
        attachments: blocks.length > 0 ? blocks : undefined,
        bubbleAttachments:
          bubbleAttachments.length > 0 ? bubbleAttachments : undefined,
        segments: segments.length > 0 ? segments : undefined,
      });
    } finally {
      queueSaveInFlightRef.current = false;
    }
    exitQueuedEdit();
  };

  const deleteQueued = (id: string) => {
    const idx = queuedMessages.findIndex((m) => m.id === id);
    if (editingQueuedRef.current === id) exitQueuedEdit();
    session.removeQueued?.(id);
    // Keyboard flow: keep the selection on the neighbouring row so repeated
    // ⌫ walks the list; deleting the last row returns to the composer.
    if (queueSelectedRef.current === id) {
      const next =
        queuedMessages[idx + 1]?.id ?? queuedMessages[idx - 1]?.id ?? null;
      setQueueSelectedId(next === id ? null : next);
    }
  };

  /** "Send now": steer the running turn (Claude/Codex), or flush immediately
   *  when idle. Sending the row that's being edited saves the edit first, so
   *  what's dispatched is what the user sees in the composer. */
  const sendNowQueued = async (id: string) => {
    if (editingQueuedRef.current === id) await saveQueuedEdit();
    const ok = await session.steerQueued?.(id);
    if (ok === false) {
      toast.error("Couldn't send now", {
        description:
          "The message stays queued and will send when the current turn finishes.",
      });
    }
    if (queueSelectedRef.current === id) setQueueSelectedId(null);
  };

  // ↑/↓/⌫/⌘↵/Esc from inside the editor — the queued card's virtual
  // selection. Reassigned every render so the once-built keymap always sees
  // fresh state through queueKeysRef.
  queueKeysRef.current = {
    arrowUp: () => {
      if (editingQueuedRef.current) return false;
      if (queuedMessages.length === 0) return false;
      const selected = queueSelectedRef.current;
      if (selected == null) {
        // Capture ↑ only when the caret has nowhere further up to go —
        // multi-line drafts keep native line navigation.
        const ed = composerEditor;
        if (!ed) return false;
        const sel = ed.state.selection;
        if (!sel.empty || sel.from > 1) return false;
        setQueueCollapsed(false);
        setQueueSelectedId(queuedMessages[queuedMessages.length - 1].id);
        return true;
      }
      const idx = queuedMessages.findIndex((m) => m.id === selected);
      if (idx > 0) setQueueSelectedId(queuedMessages[idx - 1].id);
      return true;
    },
    arrowDown: () => {
      if (editingQueuedRef.current) return false;
      const selected = queueSelectedRef.current;
      if (selected == null) return false;
      const idx = queuedMessages.findIndex((m) => m.id === selected);
      if (idx === -1 || idx === queuedMessages.length - 1) {
        setQueueSelectedId(null);
      } else {
        setQueueSelectedId(queuedMessages[idx + 1].id);
      }
      return true;
    },
    deleteKey: () => {
      if (editingQueuedRef.current) return false;
      const selected = queueSelectedRef.current;
      if (selected == null) return false;
      deleteQueued(selected);
      return true;
    },
    modEnter: () => {
      if (editingQueuedRef.current) return false;
      const selected = queueSelectedRef.current;
      if (selected == null) return false;
      void sendNowQueued(selected);
      return true;
    },
    escape: () => {
      if (editingQueuedRef.current) {
        exitQueuedEdit();
        return true;
      }
      if (queueSelectedRef.current) {
        setQueueSelectedId(null);
        return true;
      }
      return false;
    },
  };

  // The edit target / selection can vanish underneath the card — Stop
  // discards the queue, a remote surface removes the message. Exit edit
  // mode (restoring the stashed draft) and drop the dangling selection.
  useEffect(() => {
    if (
      editingQueuedId &&
      !queuedMessages.some((m) => m.id === editingQueuedId)
    ) {
      exitQueuedEdit();
    } else if (
      queueSelectedId &&
      !queuedMessages.some((m) => m.id === queueSelectedId)
    ) {
      setQueueSelectedId(null);
    }
    // exitQueuedEdit is a per-render closure by design (it reaches current
    // composer/session state); the ids + list are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedMessages, editingQueuedId, queueSelectedId]);

  // A retained chat no longer unmounts on every switch. Leaving its surface
  // must still exit queued-edit mode and release the provider hold; otherwise
  // an invisible editor could park that provider queue indefinitely.
  const releaseQueueRef = useRef<(() => void) | undefined>(undefined);
  releaseQueueRef.current = session.releaseQueue;
  const exitQueuedEditRef = useRef(exitQueuedEdit);
  exitQueuedEditRef.current = exitQueuedEdit;
  const wasSurfaceActiveRef = useRef(surfaceActive);
  useEffect(() => {
    const wasActive = wasSurfaceActiveRef.current;
    wasSurfaceActiveRef.current = surfaceActive;
    // Intent pre-rendering mounts a chat inactive. Only a real visible→parked
    // transition owns queue release/draft persistence; otherwise a hover would
    // publish a redundant global store write before the user even selects it.
    if (surfaceActive || !wasActive) return;
    if (editingQueuedRef.current != null) exitQueuedEditRef.current();
    else releaseQueueRef.current?.();
    // exitQueuedEdit restores the pre-edit stash synchronously; persist only
    // afterward so a parked chat can never save queued-message text as its
    // ordinary composer draft.
    persistComposerDraft();
  }, [persistComposerDraft, surfaceActive]);
  // Bounded-deck eviction and application shutdown retain the old unmount
  // guarantee as a final idempotent safety net.
  useEffect(() => {
    return () => releaseQueueRef.current?.();
  }, []);

  // The editor's Enter keymap calls this through a ref (handleSend is defined
  // after the editor hook). Enter routes by mode: save the queued edit →
  // open the selected queued row → send the draft.
  submitRef.current = () => {
    if (editingQueuedRef.current) {
      void saveQueuedEdit();
      return;
    }
    const selected = queueSelectedRef.current;
    if (selected) {
      startQueuedEdit(selected);
      return;
    }
    void handleSend();
  };

  // (Previous local queue flush effect removed — EmptyComposer now
  // sends via a speculative session that is ready at submit time,
  // so there's nothing to flush locally.)

  // Phase 2-B handoff: InlineEdit, feedback pill, and the empty-state
  // composer all funnel AI requests through the agent chat now. When the
  // pending submission targets this chat (or we're the only live one)
  // and the session is ready, send it and clear the queue.
  const pendingSub = pendingChatSubmission;
  useEffect(() => {
    if (!surfaceActive) return;
    if (!pendingSub) return;
    if (!chatId) return;
    // Only the active chat consumes the pending submission. The store
    // already routes by activeChatId at enqueue time; this guard is a
    // belt-and-suspenders check against double-sends if two chats are
    // ever mounted simultaneously.
    if (activeChatId !== chatId) return;
    if (session.status !== "ready" || session.pendingPermission) return;
    // Phase D2: thread the EmptyComposer's summary imports + image
    // attachments + bubble metadata through to the first send. Without
    // this, the user's imported context chips were dropped on the way
    // to the new chat AND the user-bubble's chip row was missing on
    // the seeded message.
    handleSend(pendingSub.text, {
      imports: pendingSub.imports,
      extraAttachments: pendingSub.attachments as ContentBlock[] | undefined,
      bubbleAttachments: pendingSub.bubbleAttachments as
        | import("./use-agent-session").AgentTextMessageAttachment[]
        | undefined,
      bubbleSegments: pendingSub.segments as
        | MessageContentSegment[]
        | undefined,
    });
    dispatch({ type: "CONSUME_CHAT_SUBMISSION", id: pendingSub.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pendingSub,
    session.status,
    session.pendingPermission,
    chatId,
    activeChatId,
    surfaceActive,
  ]);

  // If a user queues a first turn and then deliberately clears the composer
  // before setup finishes, cancel that exact intent. The "seen content" latch
  // avoids mistaking the editor's initial seed tick for a user clear.
  const queuedContentSeenRef = useRef(false);
  useEffect(() => {
    if (!chatId || !pendingAutoSend) {
      queuedContentSeenRef.current = false;
      return;
    }
    if (!composerEmpty) {
      queuedContentSeenRef.current = true;
      return;
    }
    if (queuedContentSeenRef.current) {
      dispatch({ type: "CONSUME_AUTO_SEND", chatId });
      queuedContentSeenRef.current = false;
    }
  }, [chatId, composerEmpty, dispatch, pendingAutoSend]);

  // Prepared-workspace hand-off: the dispatcher can seed this composer, or the
  // user can type and press Send while checkout is still running. Once the
  // exact lifecycle publishes and this exact chat's session is ready, submit
  // its own rich editor document. This is intentionally independent of current
  // route/surface: rapid create→create navigation still drains every queued
  // chat, while the exact id prevents another mounted pane from consuming it.
  useEffect(() => {
    if (!chatId || !pendingAutoSend || workspaceProvisioning) return;
    if (session.status !== "ready" || session.pendingPermission) return;
    if (composerEmpty) return;
    // Consume first so React Strict effects and unrelated store notifications
    // cannot dispatch the same first turn twice while handleSend is awaiting.
    dispatch({ type: "CONSUME_AUTO_SEND", chatId });
    submitRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pendingAutoSend,
    workspaceProvisioning,
    session.status,
    session.pendingPermission,
    chatId,
    composerEmpty,
  ]);

  // Roadmap 03b Phase 4.5: ⌥+click in the browser-tab element picker
  // appends element context to this chat's composer WITHOUT firing.
  // The user can keep typing around it and submit when ready.
  // Distinct from pendingChatSubmission above, which auto-fires.
  const pendingAppend = pendingComposerAppend;
  useEffect(() => {
    if (!pendingAppend) return;
    if (!chatId) return;
    // Append only targets this chat. (chatId null = EmptyComposer
    // case, handled separately in EmptyComposer.tsx.)
    if (pendingAppend.chatId !== chatId) return;
    // Append element context at the end as plain text; the user keeps editing.
    appendComposerText(`\n\n${pendingAppend.text}`);
    dispatch({ type: "CONSUME_COMPOSER_APPEND", id: pendingAppend.id });
    if (surfaceActive) queueMicrotask(() => focusComposer());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAppend, chatId, surfaceActive]);

  const handleAttachFiles = () => fileInputRef.current?.click();
  // The editor owns the file-read + validation pipeline (insertFiles); this
  // wrapper just resets the file input so the same file can be re-picked.
  const handleFileInput = async (files: FileList | null) => {
    await addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Roadmap 03a UI Phase 1C (2026-05-21): the inline agent name + status
  // subtitle ("Claude · streaming…") used to live in the chat
  // header. The Column 2 tab strip now carries chat identity per session,
  // so the subtitle was redundant and made the header noisy. Streaming /
  // auth-required / stop-reason signals are already surfaced through the
  // composer state chip + toast layer.

  return (
    <div className="zeros-agent-surface text-fg1 [container-type:inline-size] flex h-full min-h-0 flex-col bg-transparent text-sm">
      {/* Roadmap 03a UI Phase 1C (2026-05-21): the Zeros Foundation-aligned chat
          header is suppressed when the caller passes any `headerActions`
          (truthy or an empty fragment). The Column 2 path always passes
          `<></>` so the entire header — title, agent chip, project
          context chip — collapses, since the Column 2 top bar +
          chat-tabs strip already convey identity. The legacy agent-mode
          surface (no `headerActions` prop) still gets the original
          h-11 header with the back button. */}
      {headerActions === undefined && (
        <header className="border-border1 flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <Tooltip label="Back to agents">
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={onBack}
              aria-label="Back to agents"
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </Tooltip>
          <Bot className="text-fg2 size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <div className="text-fg1 truncate text-sm font-medium tracking-tight">
              {chatThread?.title ??
                session.agentName ??
                session.agentId ??
                "Agent"}
            </div>
          </div>
          <ProjectContextChip
            agentId={session.agentId ?? chatThread?.agentId ?? null}
            cwd={chatFolder ?? null}
          />
        </header>
      )}

      {/* 01w (2026-05-20) — inline ErrorCard removed. Agent errors now
          surface ONLY through the toast surface (with agent name) per
          /zeros-foundation toast rule. The Reset session affordance moves to the
          settings/menu surface — the user explicitly said the inline
          banner "disturbs the flow". The useEffect higher up fires
          toast.error("Claude Code: …") on every status transition. */}

      {/* 2026-05-21: SummaryHandoffPill removed. The "Add chat
          summaries:" pill rendered above a fresh chat when the user
          arrived via in-chat agent-switch (sourceChatId set). The
          agent-switch flow itself was retired when AgentPill came
          out of the chat surface — sourceChatId is no longer set
          anywhere — so this pill became dead UI. */}

      {/* Wave 4 (2026-05-16): the turn list now lives inside the
          canonical AI Elements <Conversation><ConversationContent>
          shell. Conversation owns the flex-1/min-h-0 relative-position
          container; ConversationContent is the actual scrolling viewport
          (so `setScrollContainer` hangs off it — sticky-bottom,
          scroll-restoration, jump-by-message all read .scrollTop /
          .scrollHeight from this element). The legacy
          .zeros-agent-body / .zeros-agent-messages class names ride
          through so app-shell.css selectors still bind during the
          transition. JumpPills stays a sibling of the scroll content
          (it's positioned absolutely against the conversation surface),
          so it sits inside <Conversation> but outside the scroll
          viewport. */}
      {/* 01m: scroll on the OUTER Conversation again (so scrollbar
          pins flush to col 2's right border at every column width),
          inner ConversationContent is overflow-visible and centered.
          2026-06-18 (final): max-w-[1152px] is the SINGLE source of the
          chat's responsive width — the roomy envelope the user wants for
          tool cards / diffs / wide tables. It is a MAX, not a fixed
          width: the band only reaches 1152 when col 2 is that wide; when
          col 2 is narrower the band shrinks to the window (mx-auto adds
          NO gutters below the cap). This 1152 band is the OUTER
          envelope (scroll container + content column); the answer lane
          inside it is separately capped at 768px (turn-event-list.tsx,
          `max-w-[768px]`) so prose reads at a comfortable measure rather
          than stretching the full band. A same-day experiment instead
          capped the answer lane at 80% — reverted, because a proportional
          cap reserved a fixed ~20% right gutter at EVERY width, so the
          column never "fit in" when shrunk (the user's report). The side
          gap must appear ONLY once content hits the 1152 cap, never
          before. To retune: THIS value sets the outer band (mirror it on
          the composer + permission caps below); the inner reading measure
          is the 768 cap in turn-event-list.tsx.
          History: 846px (01s, 2026-05-20) was the older, tighter reading
          measure; widened to 1152 per the user. Outer column drag-resizes
          up to min(2400px, 70vw) via Column2Workspace; this band centres
          inside that. Markdown tables fill the band (display:table +
          width:100% in globals.css) and wrap wider tables in a
          horizontal-scroll div (markdown.ts > wrapTablesInScroller).
          Thin scrollbar styling in globals.css. */}
      {/* Relative shell around the scroll container so the top-mask (below)
          can sit OUTSIDE the scroller and stay pinned to the viewport top
          regardless of scroll position. Grows like the scroller did. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Conversation
          ref={setScrollContainer}
          className="zeros-agent-body zeros-agent-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-transparent"
          style={{ position: "relative" }}
        >
          <ConversationContent
            // flex-none is LOAD-BEARING: the ConversationContent primitive
            // ships `flex-1`, which (inside the flex-col scroller) pins this
            // box to the scroller's height. With `overflow-visible`, the
            // messages then spill PAST the padding box — so `pb` lands above
            // the overflowing content and never reaches the real bottom (no
            // `pb` value produced a gap; only a spacer outside the scroller
            // did). `flex-none` lets the box grow to its content height, so
            // pb-8 sits at the true bottom and creates the gap on scrollHeight.
            // pt-3: matches the sticky user-prompt's `top-3` offset so the
            // first prompt sits at the same 12px gap below the tab strip
            // whether pinned or at rest (no jump on scroll).
            // pb-8 (32px): the gap lives HERE (content bottom padding), not a
            // non-scrolling spacer — so it shows ONLY once the transcript is
            // scrolled to the bottom. Mid-scroll the content runs flush up to
            // the composer; reaching the end reveals the gap. (Auto-scroll
            // lands at the bottom, so a live run keeps the gap above the tail.)
            // px-7 (28px, 2026-07-16 user spec): one flat side gutter at every
            // column width — replaced the px-3/@520:px-5/@680:px-8 ramp. Keeps
            // the transcript clear of the checkpoint rail's ticks (left-1 +
            // 20px hit zone = 28px) at all widths. Mirror any change on the
            // composer column below (lock-step alignment).
            className="zeros-agent-messages mx-auto flex w-full max-w-[1152px] min-w-0 flex-none flex-col gap-5 overflow-visible px-7 pt-3 pb-8"
          >
            {/* Older history auto-pages in via the nearTop effect above —
              no visible affordance (2026-07-06 user spec: scrolling back
              should just show everything). */}
            {/* Reconnecting state is surfaced by the "Reconnecting…" card
              directly above the composer (see the composer banner stack) —
              keep the message area empty so the user can still see the
              transcript area. */}
            {/* Empty transcript → state what this workspace IS (created /
              branched from / setup script), not what the session is doing.
              2026-07-29: replaced "Session ready. Ask the agent anything."
              Deliberately NOT gated on session.status: the old line was, so
              every respawn flipped it warming→ready and the text blinked out
              and back (see the respawn fix in column2-chat-view.tsx). This
              block describes the workspace, which a session rebuild doesn't
              change, so it stays put. Still hidden on `error` — a failed
              session shows its own failure UI and provenance would read as
              reassurance the user shouldn't take. */}
            {session.messages.length === 0 && !session.error && (
              <ChatProvenance
                folder={chatThread?.folder}
                hasTranscripts={hasTranscripts}
              >
                {/* The transcript pill row rides INSIDE the provenance block,
                  keeping one left edge, one type size and one icon column.
                  2026-07-30: it REPLACES the three workspace rows rather than
                  following them — when there is a transcript to offer, it is
                  the whole block (see provenanceBlockShape).
                  Gated on the same messages.length === 0 as the block, so it
                  is gone after the first send — the composer "+" menu is what
                  covers "three turns in, I realise the agent needs the other
                  chat's history". */}
                <ChatTranscriptPills
                  summaries={transcriptSummaries}
                  attachedChatIds={attachedTranscriptChatIds}
                  pendingChatIds={pendingTranscriptIds}
                  onAttach={attachTranscript}
                  onRemove={removeTranscript}
                  onCancel={cancelTranscriptAttach}
                  onOpenChat={openTranscriptChat}
                />
              </ChatProvenance>
            )}
            {turns.map((turn, i) => {
              const isActive = i === turns.length - 1;
              return (
                <React.Fragment key={turnKey(turn)}>
                  <TurnContainer turn={turn} isActive={isActive}>
                    {/* Still-pending queued sends do NOT render here — they
                        live in the QueuedMessagesCard docked above the
                        composer (2026-07-06 queue redesign), so every
                        userPrompt reaching this point is a dispatched turn. */}
                    {turn.userPrompt && (
                      // Phase 2 chat overhaul (2026-05-07): every turn's user
                      // prompt is sticky (Cursor-style stacking) — as the
                      // user scrolls up through history each turn's prompt
                      // pins until the next turn's prompt arrives at the top
                      // and pushes it off. Previously only the active turn
                      // pinned, so scrolling back up lost the "what did I
                      // ask?" anchor that long sessions need.
                      //
                      // Click-to-edit is enabled for ALL turns including the
                      // active one ("regenerate this prompt with a tweak").
                      // For the active turn, editAndResubmit cancels the
                      // in-flight stream before truncating + resending.
                      <TurnPromptHeader
                        chatId={chatId}
                        messageId={turn.userPrompt.id}
                        createdAt={turn.userPrompt.createdAt}
                        // Keep-alive deck (column2-chat-deck.tsx) keeps hidden
                        // chats mounted, so the prompt's "More"-expanded state
                        // needs the surfacing signal to collapse on tab switch.
                        surfaceActive={surfaceActive}
                        editingMessageId={editingMessageId}
                        onRequestEdit={setEditingMessageId}
                        originalText={turn.userPrompt.text}
                        originalAttachments={turn.userPrompt.attachments}
                        originalSegments={turn.userPrompt.segments}
                        autoAction={turn.userPrompt.autoAction}
                        // Auto-sent messages (PR island / Create PR) are
                        // copy-only: the bubble shows a short label while the
                        // wire text is a generated brief, so an inline edit
                        // can't round-trip. No onEdit → no Edit affordance.
                        onEdit={
                          turn.userPrompt.autoAction
                            ? undefined
                            : (editedText, attachments, segments) => {
                                editAndResubmit(
                                  turn.userPrompt!.id,
                                  editedText,
                                  attachments,
                                  segments,
                                );
                              }
                        }
                        editToolbarPills={editToolbarPills}
                        editAgentContext={
                          chatThread
                            ? {
                                agentId: chatThread.agentId,
                                agentName: chatThread.agentName,
                                agentSupportsImage:
                                  session.initialize?.agentCapabilities
                                    ?.promptCapabilities?.image !== false,
                                modelId: chatThread.model,
                                availableCommands: session.availableCommands,
                                cwd: session.cwd ?? chatThread.folder ?? null,
                                originUrl: composerOriginUrl,
                              }
                            : undefined
                        }
                      >
                        <div ref={isActive ? setActivePromptEl : null}>
                          {/* The user prompt renders as a right-aligned,
                        fit-to-content bubble (Cursor / iMessage pattern).
                        TurnPromptHeader paints the bg-highlighted-bg +
                        border chrome and the hover edit/copy/age row; the
                        inner TextMessage flips its <MessageContent> to
                        variant="flat" when role === "user" so it
                        contributes just the text. (No longer sticky — the
                        prompt scrolls with the transcript.) */}
                          <MessageView
                            message={turn.userPrompt}
                            ctx={messageCtx}
                          />
                        </div>
                      </TurnPromptHeader>
                    )}
                    {/* No plan/task card renders here (or anywhere): the plan
                    dock was removed 2026-07-02 as too agent-dependent to trust. */}
                    {/* Per-turn footer (run time, copy output, "…" Reset to this
                    point, authored file pills) renders INSIDE TurnEventList's
                    768 lane so it hugs the answer instead of inheriting the
                    TurnContainer's gap-4. Only turns with a user prompt (the
                    turn id) get one — the rare leading "system turn" has nothing
                    to reset to. */}
                    {/* A turn counts as IN FLIGHT while streaming — and also
                    while the session is "warming" with the turn still empty:
                    that's a send pending session (re)creation (Cursor's
                    newSession takes seconds; engine-respawn rebuilds too).
                    Without the warming clause the just-sent turn flashed as
                    SETTLED — a "0s ⧉ …" footer, no shimmer — until the first
                    event arrived (user report 2026-07-04). Scoped to empty
                    turns so REOPENING a chat (also "warming") never repaints
                    its last completed turn as live. */}
                    <TurnEventList
                      events={turn.events}
                      isActive={isActive}
                      isStreaming={
                        session.status === "streaming" ||
                        (session.status === "warming" &&
                          turn.events.length === 0)
                      }
                      ctx={messageCtx}
                      footer={
                        turn.userPrompt && chatId ? (
                          <TurnFooter
                            chatId={chatId}
                            turnId={turn.userPrompt.id}
                            events={turn.events}
                            startedAt={turn.userPrompt.createdAt}
                            live={
                              isActive &&
                              (session.status === "streaming" ||
                                (session.status === "warming" &&
                                  turn.events.length === 0))
                            }
                            fallbackStopReason={
                              isActive && session.status !== "streaming"
                                ? session.lastStopReason
                                : null
                            }
                            fallbackStatusLabel={
                              isActive && session.status !== "streaming"
                                ? footerLabelForFailure(session.failure)
                                : null
                            }
                            retrying={
                              isActive &&
                              (session.status === "warming" ||
                                session.status === "reconnecting")
                            }
                            isLastTurn={isActive}
                            // §3.6 R5/R3 — one-click resume after a token-cap /
                            // budget stop: functionally the user typing
                            // "Continue" and hitting send (same session, full
                            // context). The stop pill / budget card stays on
                            // this turn as history.
                            onContinue={() => void handleSend("Continue")}
                            // Auth-required + Claude/Codex: the SIGN IN
                            // REQUIRED pill becomes a live Sign-in button
                            // (background CLI login → browser).
                            signInPhase={
                              isActive &&
                              nativeReady &&
                              session.status !== "streaming" &&
                              supportsBackgroundSignIn(signInAgentId) &&
                              footerLabelForFailure(session.failure) ===
                                "SIGN IN REQUIRED"
                                ? signInState.phase
                                : null
                            }
                            onSignIn={nativeReady ? handleSignIn : undefined}
                          />
                        ) : null
                      }
                    />
                  </TurnContainer>
                </React.Fragment>
              );
            })}
            {/* Checkpoint bottom spacer — see the state comment above.
              -mt-5 cancels the column's gap-5 so the div contributes
              EXACTLY `height` px to scrollHeight (the rail's reach math
              assumes that); it sits above pb-8, which stays the visual
              rest gap. aria-hidden + empty: pure scroll room. */}
            {checkpointSpacerPx > 0 && (
              <div
                aria-hidden="true"
                className="-mt-5 flex-none"
                style={{ height: checkpointSpacerPx }}
              />
            )}
          </ConversationContent>
          <JumpToPromptPill scrollEl={scrollEl} promptEl={activePromptEl} />
        </Conversation>
        {/* Top scroll mask — a soft pane-bg→transparent gradient (--pane-bg =
          the chat-window fill this chat is portaled onto: bg1 in the active
          window, bg0 in an inactive one) that lets content pass continuously
          under the chat strip (the Cursor / iOS edge-fade pattern). It is
          stable chrome, present from the first paint instead of being
          inferred from a later scroll event; a workspace restore can
          therefore never make the mask pop in after the transcript. It lives
          outside the scroller, below the jump pill, and never eats clicks. */}
        <div
          aria-hidden="true"
          // h-6 (24px) keeps it subtle — about one line. The via stop feathers
          // the lower edge so it dissolves without a visible seam.
          className="pointer-events-none absolute inset-x-0 top-0 z-[6] h-6 bg-gradient-to-b from-(--pane-bg) via-(--pane-bg)/40 to-transparent"
        />
        {/* Checkpoint rail (2026-07-15) — Claude Code-style left-edge
          minimap: one tick per user message, the bright tick tracks the
          checkpoint region the viewport is in, hover opens the full
          user-message list, click scrolls that prompt to the top. Lives
          in this relative shell (a SIBLING of the scroll container) so
          it stays pinned while the transcript scrolls; z-[8] paints
          above the top fade mask (z-[6]). */}
        <CheckpointRail
          active={surfaceActive}
          scrollEl={scrollEl}
          checkpoints={checkpoints}
          bottomSpacerPx={checkpointSpacerPx}
          onBottomSpacerChange={setCheckpointSpacerPx}
          recomputeRef={checkpointRecomputeRef}
        />
      </div>

      {/* Permission surface consolidated 2026-07-02: the old global
          PermissionBar (fallback) and the inline cluster are gone. There is
          now ONE permission card, rendered in the composer's slot below (see
          <PermissionCard>). */}

      {/* 01e Phase 5: the ActivityHUD pill is gone. The shimmer now
          mounts at the tail of the active turn's event list (see
          turn-event-list.tsx), so it flows with the work rather than
          floating fixed above the composer. */}

      {/* Composer wrapper — transparent background sits on the column's
          surface-floor. The visible card is the inner composer-card
          (surface-1, raised) which pops above the canvas in both
          dark + light themes.
          01o: wrap the composer in a `relative` outer so JumpPills
          can anchor to the composer's top edge — `absolute -top-N
          left-1/2` lives in the non-scrolling chrome, not inside
          the scroll container. The button now stays put as the
          user scrolls. */}
      <div className="relative shrink-0">
        <JumpToLatestButton
          isAtBottom={isAtBottom}
          jumpToBottom={jumpToBottom}
        />
        {/* Composer dock padding (2026-05-21): pt-0 so the composer
          hugs the top when nothing's above it; pb-4 (16px) bottom for
          breathing room; gap-4 between children so when a Plan /
          permission / task card lands above the composer (PromptInput
          isn't the only flex child here), the gap between that card
          and the composer matches the 16px bottom padding.
          2026-06-18: max-w-[1152px], kept in lock-step with the
          `.zeros-agent-messages` cap above so the composer stays aligned
          with the centered conversation column (the user's Cursor-pattern
          ask). Like the messages band it's a MAX: on a 2000px col-2 the
          composer sits in the 1152px centred measure; when col 2 is
          narrower it shrinks to the window. */}
        {/* gap-0.5 (2px): above-composer cards (Reconnecting, permission, plan
          review, embedded terminal) sit ~flush to the composer — user spec.
          The message list is a separate container, so its spacing is unaffected. */}
        {/* px-7 (28px, 2026-07-16): kept in lock-step with the transcript
          column's flat 28px gutter above so the composer's edges align with
          the message bubbles at every width. */}
        <div className="mx-auto box-border flex w-full max-w-[1152px] min-w-0 shrink-0 flex-col gap-0.5 border-t-0 bg-transparent px-7 pt-0 pb-4">
          {/* 01u (2026-05-20): inline composer error pill removed; the
            "Error: <label>" surfaces as a toast.error from a useEffect
            higher up. Unified toast surface — see /zeros-foundation skill + docs §6.
            2026-07-10: the composer no longer disables on isErrorState —
            sending from an error state is the retry affordance (see canSend);
            only the Send button keeps its "error" tint. */}
          {/* Embedded-terminal command (Claude /mcp, /login, …): a banner →
            inline ephemeral PTY mounted directly above the composer. Only
            present while a terminal command is active; requires a cwd. */}
          {terminalCommand && terminalCwd && terminalAgentId && (
            <EmbeddedTerminalCommand
              // Key by command so switching to a different command (e.g. /mcp →
              // /login) remounts fresh — the old instance's unmount effect reaps
              // its ephemeral PTY rather than stranding it under a stale label.
              key={terminalCommand}
              command={terminalCommand}
              cwd={terminalCwd}
              agentId={terminalAgentId}
              onClose={() => setTerminalCommand(null)}
            />
          )}
          {/* Composer task dock (<Plan>) REMOVED 2026-07-02: the plan/todo
            card was too agent-dependent to be trustworthy — it works for Codex
            (native plan), but is unpredictable for Claude/Cursor (they drive it
            through different task tools with partial/absent status), so it
            could sit stuck at all-pending. Rather than show an inconsistent
            card we don't surface it at all. */}
          {/* Reconnecting card — this chat's agent session dropped (a child
            crash, or an engine respawn) so it's marked `reconnecting`. Per
            session: it shows ONLY on the affected chat, not every chat on the
            agent. A plain text card above the composer (no spinner, by
            request); the chat silently re-creates its session on the next
            send. Matches the embedded-terminal banner styling. */}
          {session.status === "reconnecting" && (
            <div className="border-border1 bg-bg1 flex items-center gap-2 rounded-lg border px-3.5 py-2.5">
              {/* Type-3 indication (UI consolidation 2026-07-10): reconnect
                states carry a LOADING affordance — the Orbit shimmer, same
                as the api_retry "Reconnecting agent" row — so the user
                reads "still trying", not a settled error. */}
              <ZerosSpinner
                size={16}
                label="Reconnecting"
                className="shrink-0"
              />
              <span className="text-fg2 min-w-0 flex-1 truncate text-sm">
                Reconnecting…
              </span>
            </div>
          )}
          {/* Queued messages (2026-07-06 redesign): sends typed mid-turn dock
            here as a card tucked under the NEXT composer-slot surface (the composer, or the permission/question card that replaces it) — NOT greyed
            transcript bubbles. Rows offer Edit (loads into the composer
            below), Delete, and Send now (steers the running turn on
            Claude/Codex). ↑ from the composer walks the list. */}
          <QueuedMessagesCard
            messages={queuedMessages}
            selectedId={queueSelectedId}
            editingId={editingQueuedId}
            collapsed={queueCollapsed}
            onToggleCollapsed={() => setQueueCollapsed((c) => !c)}
            onSelect={setQueueSelectedId}
            onEdit={startQueuedEdit}
            onSaveEdit={() => void saveQueuedEdit()}
            saveDisabled={composerEmpty}
            onDelete={deleteQueued}
            onSendNow={(id) => void sendNowQueued(id)}
            steeringSupported={steeringSupported}
            streaming={composerStreaming}
            agentName={steeringAgentName}
          />
          {/* Permission card (2026-07-02): the ONE permission gate. While a
            decision is pending it REPLACES the composer (hidden below) — no
            inline card, no fallback bar. Claude's plan review is the ONE
            exception (planReview → <PlanReviewCard>): it's not a gate, so it
            keeps the composer live for follow-ups instead of routing here. */}
          {permissionCardActive && (
            <PermissionCard
              request={session.pendingPermission!.request}
              onRespond={(response) => session.respondToPermission(response)}
              onRecordPolicy={messageCtx.recordPolicy}
              chatId={chatId}
              cwd={session.cwd ?? chatThread?.folder ?? null}
            />
          )}
          {/* Blocking user-input question — takes the composer slot (below is
            hidden). The interactive ONE card; answering resolves the parked
            engine turn (no queued next-turn prompt). Serialized after any
            pending permission via questionCardActive. */}
          {questionCardActive && pendingQuestion && (
            <QuestionCard
              key={pendingQuestion.questionId}
              request={pendingQuestion.request}
              onRespond={(response) => session.respondToQuestion(response)}
            />
          )}
          {/* Plan review (Claude's ExitPlanMode): a standalone card above the
            still-live composer (same island recipe as the Reconnecting card),
            NOT a bar fused into the composer. Approve allows the gate + exits
            Plan mode; typing a follow-up below refines the plan (see
            handleSend's plan-review branch). */}
          {planReview && (
            <PlanReviewCard
              planText={readPlan(planReview.request.toolCall.rawInput)}
              onApprove={approvePlan}
              onReject={denyPlanReview}
            />
          )}
          {/* Wave 4 (2026-05-16): canonical AI Elements PromptInput
            recipe replaces ComposerShell + ComposerTextarea +
            ComposerToolbar. PromptInput is a `<form>` element; the
            drag-drop handlers (typed for HTMLDivElement by
            useComposerAttachments) hang off a thin div wrapper so the
            form's submit semantics + the dropzone overlay coexist
            cleanly. onSubmit funnels both Enter (handled by
            handleKeyDown) and the visible send button through
            handleSend. The legacy `zeros-agent-composer-card` +
            `is-drag-active` classes ride through so the existing
            dropzone overlay + drag styling still bind. Submit status
            flips to "ready"/"error" so PromptInputSubmit renders the
            canonical CornerDownLeftIcon — replacing the old custom
            ArrowUp button. The streaming-state Stop button stays a
            plain destructive Button (labeled, not icon-only) per the
            existing UX call. */}
          {/* Provider (not a DOM wrapper): tells popover-bearing pills inside
            the card (ModelPill) to close while the composer is concealed —
            their portaled content would otherwise strand at the viewport
            origin once this card goes display:none. */}
          <ComposerConcealedContext.Provider value={composerConcealed}>
            <div
              className={cn(
                "border-border1 bg-bg2 focus-within:border-border2 relative flex w-full min-w-0 flex-col rounded-lg border px-3.5 py-3 shadow-xs transition-[border-color,background,box-shadow] duration-150 ease-out",
                // Drag border: subtle (border2), not near-white --highlighted-bright; `!`
                // beats the higher-specificity focus-within:border-border2 so the drag
                // state looks identical whether or not the composer is focused.
                dragActive &&
                  "!border-border2 ring-highlighted-bright/30 border-dashed ring-2",
                // Guarded modes (Claude Plan / Codex Ask / Cursor Ask): hide the
                // solid border; the SVG dotted frame below provides the visible
                // edge (spaced round dots, --border4).
                composerGuarded && !dragActive && "!border-transparent",
                // Hidden while the permission OR question card takes the
                // composer's slot — one interactive surface at a time. hidden
                // (not unmount) so the typed draft + attachments survive.
                composerConcealed && "hidden",
              )}
              {...(dragHandlers ?? {})}
            >
              {/* Guarded-mode dotted frame (spaced round dots) — overlays the
              card edge; anchors to this relative card. */}
              {composerGuarded && !dragActive && <PlanModeFrame />}
              {/* Slash / @ / # pickers anchor to THIS card (position: relative)
              so the popover matches the composer width (user spec 2026-06-08),
              not the full-width wrapper above. */}
              {composerSuggestionPopup}
              {dragActive && (
                <div
                  className="bg-bg3/75 text-fg2 pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-1.5 rounded-lg p-3 text-xs"
                  aria-hidden="true"
                >
                  <Upload size={20} />
                  <span>Drop files to attach</span>
                </div>
              )}
              <PromptInput
                onSubmit={(e) => {
                  e.preventDefault();
                  // During plan review the turn is paused on the user, so the
                  // button is Send (a follow-up), not Stop. Everywhere else,
                  // submitting mid-stream cancels the turn. (Enter routes
                  // through the editor keymap → submitRef, so this fires only
                  // for the visible button — Stop keeps priority over an
                  // in-progress queued edit.)
                  if (composerStreaming) {
                    void session.cancel();
                    return;
                  }
                  if (editingQueuedId) {
                    void saveQueuedEdit();
                    return;
                  }
                  handleSend();
                }}
              >
                <PromptInputBody className="items-stretch rounded-none border-0 bg-transparent p-0 shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
                  {/* Queued-edit banner: the composer is temporarily holding a
                  QUEUED message (see startQueuedEdit). Cancel restores the
                  stashed draft; Enter / the tick below saves back onto the
                  queue entry. */}
                  {editingQueuedId && (
                    <div className="bg-bg2-hover/60 text-fg1 mb-1 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm">
                      <span>Editing queued message</span>
                      <button
                        type="button"
                        onClick={exitQueuedEdit}
                        className="text-fg2 hover:text-fg1 shrink-0 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {/* `/add-dir` context pills — extra directories Claude can access
                  beyond the cwd. INSIDE the card (bg-bg1 chips); renders
                  nothing when there are none. */}
                  {chatThread && (
                    <AddedDirectories
                      dirs={chatThread.additionalDirectories ?? []}
                      onRemove={removeDirectory}
                    />
                  )}
                  {/* TipTap editor — text + inline mention/attachment/image pills
                  at the caret (the separate attachment chip row is gone;
                  everything lives in the text flow). Linked workspaces remain
                  in the AddedDirectories row above. */}
                  {composerEditorContent}
                  <PromptInputToolbar className="min-w-0 gap-1.5 pt-1 pr-0 pb-1 pl-0">
                    {/* gap-0.5: exactly 2px between the + / model / fast /
                    effort / permission pills (2026-07-10 user spec). */}
                    <PromptInputTools className="gap-0.5">
                      {/* "+" menu — add an attachment or link a workspace/folder
                      (the latter opens WorkspaceDirectoryPicker). Both actions
                      are deferred past the menu close so the file dialog /
                      modal don't fight Radix's focus-restore. */}
                      <DropdownMenu
                        // Controlled + derived-closed: `&& !composerConcealed`
                        // closes it in the SAME render the composer hides (no
                        // one-frame strand of the open menu at the viewport
                        // origin); the composerConcealed effect above resets the
                        // state so the menu doesn't spring back open when the
                        // composer returns.
                        open={plusMenuOpen && !composerConcealed}
                        onOpenChange={setPlusMenuOpen}
                      >
                        <Tooltip label="Attach or link">
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              type="button"
                              aria-label="Add attachment or link a workspace"
                              className="rounded-sm"
                            >
                              <Plus size={14} />
                            </Button>
                          </DropdownMenuTrigger>
                        </Tooltip>
                        <DropdownMenuContent align="start" side="top">
                          <DropdownMenuItem
                            onSelect={() =>
                              window.setTimeout(handleAttachFiles, 0)
                            }
                          >
                            <Paperclip size={14} />
                            Add attachment
                          </DropdownMenuItem>
                          {/* The pill row is gated on an empty transcript, so
                            it is gone after the first send. That is right for
                            the row and wrong as the feature's only door:
                            "three turns in, I realise the agent needs the
                            other chat's history" is at least as common as
                            knowing it up front. Same picker, concise only —
                            there is no pill to right-click from here, and a
                            user reaching this from a menu mid-chat is not the
                            one who wants archaeology. */}
                          <DropdownMenuItem
                            onSelect={() =>
                              window.setTimeout(
                                () => setTranscriptPickerOpen(true),
                                0,
                              )
                            }
                          >
                            <MessageSquareText size={14} />
                            Attach chat transcript
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              window.setTimeout(
                                () => setWorkspacePickerOpen(true),
                                0,
                              )
                            }
                          >
                            <FolderInput size={14} />
                            Link workspaces
                          </DropdownMenuItem>
                          {/* Permission modes moved OUT of this menu (2026-07-10):
                          they're cycled by the PermissionToggle in the pill row. */}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={COMPOSER_FILE_ACCEPT}
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => void handleFileInput(e.target.files)}
                      />
                      {/* Model · Fast · Effort · Plan · Permissions — the
                      single shared pill block (also used in the edit
                      composer). Renders null when chatThread is absent. */}
                      {editToolbarPills}
                    </PromptInputTools>
                    {/* Right cluster: [context ring] [send] (+ save tick while
                    editing a queued message). Grouped so the toolbar's
                    justify-between keeps tools left / actions right. */}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* §3.5 context gauge — the ring + breakdown popover.
                      ALWAYS present: empty ring + "Send a message to see
                      context usage." before the first turn, disabled ring +
                      honest note for Cursor (no usage in its SDK). */}
                      <ContextGauge
                        usage={session.usage}
                        unavailableReason={contextUnavailableReason}
                        onCompactNow={
                          supportsCompactNow ? handleCompactNow : undefined
                        }
                        compactDisabled={composerStreaming || !canSend}
                      />
                      {/* 01e Phase 1: unified send/stop. PromptInputSubmit renders
                    Send (CornerDownLeft) when ready, Square (outlined, not
                    filled) when streaming. The form's onSubmit handler
                    above already calls session.cancel() when streaming, so
                    clicking the same button while in flight halts the
                    agent — no separate destructive button. Title swaps so
                    the affordance still reads. */}
                      <Tooltip
                        label={
                          composerStreaming
                            ? "Stop agent"
                            : editingQueuedId
                              ? "Save message"
                              : "Send"
                        }
                        shortcut={composerStreaming ? undefined : "↵"}
                      >
                        <PromptInputSubmit
                          status={
                            isErrorState
                              ? "error"
                              : composerStreaming
                                ? "streaming"
                                : "ready"
                          }
                          disabled={
                            composerStreaming
                              ? false
                              : editingQueuedId
                                ? composerEmpty
                                : !canSend
                          }
                          className="disabled:bg-bg2-hover disabled:text-fg2 size-8 disabled:opacity-100"
                        >
                          {composerStreaming ? (
                            <Square className="size-3" />
                          ) : undefined}
                        </PromptInputSubmit>
                      </Tooltip>
                      {/* Queued-edit save tick — sits beside Stop while the
                    agent runs (the screenshot-spec layout), so saving the
                    edit and stopping the turn stay separate, unambiguous
                    targets. When idle the main submit doubles as Save; the
                    tick stays for a consistent affordance. */}
                      {editingQueuedId && (
                        <Tooltip label="Save message" shortcut="↵">
                          <Button
                            type="button"
                            onClick={() => void saveQueuedEdit()}
                            disabled={composerEmpty}
                            aria-label="Save queued message"
                            className="disabled:bg-bg2-hover disabled:text-fg2 size-8 shrink-0 rounded-sm p-0 disabled:opacity-100"
                          >
                            <Check className="size-4" />
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                  </PromptInputToolbar>
                </PromptInputBody>
              </PromptInput>
            </div>
          </ComposerConcealedContext.Provider>
          {/* 2026-05-21: the bottom pill row (AgentPill + folder label +
            ContextPill) was removed per user direction. Agent switching
            now lives in the "+" menu's Chat submenu; folder context is
            shown in the Column 2 top bar; ContextPill / token-usage
            UI returns when the redesigned settings / status surfaces
            land. The container below kept the same height so the
            chrome doesn't jump when toggling between AgentChat and
            EmptyComposer. */}
        </div>
      </div>
      {/* Phase D2 (2026-05-07) iter 4: full-screen image preview
          overlay. Triggered by clicking an image attachment chip in
          the composer's chip row. Same component the EmptyComposer
          uses; the hook scopes its open/close state per surface. */}
      {imagePreviewOverlay}
      {/* `/add-dir` + "+" → "Link workspaces": pick a worktree or browse a
          folder to grant Claude extra access. Controlled modal; gated on a
          live chat so cwd / linked dirs are available. */}
      {chatThread && (
        <WorkspaceDirectoryPicker
          open={workspacePickerOpen}
          onOpenChange={setWorkspacePickerOpen}
          linkedDirs={chatThread.additionalDirectories ?? []}
          cwd={chatThread.folder}
          onLink={linkDirectory}
          onUnlink={removeDirectory}
        />
      )}
      {/* The always-available door to the same picker the "N more" pill opens
          (composer "+" → Attach chat transcript). */}
      <TranscriptPickerDialog
        open={transcriptPickerOpen}
        onOpenChange={setTranscriptPickerOpen}
        summaries={transcriptSummaries}
        attachedChatIds={attachedTranscriptChatIds}
        onAttach={attachTranscript}
        onRemove={removeTranscript}
        onClose={() => setTranscriptPickerOpen(false)}
      />
    </div>
  );
}

// ── Design-audits pill — collapsed quick-launch for a11y/token audits

// PermissionBar + friendlyOptionLabel removed 2026-07-02 — the global
// fallback permission bar is gone. The single <PermissionCard> (permission-
// card.tsx), rendered in the composer slot, is now the only permission surface.
