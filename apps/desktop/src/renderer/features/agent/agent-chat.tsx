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
import { useOpenChatFileInWorkbench } from "@/renderer/shell/workbench/use-open-file";
import { chatFileOpenCwd } from "@/renderer/shell/workbench/direct-file-open";
import {
  materializeScrollGeometryWithin,
  registerScrollRestore,
} from "@/renderer/shell/scroll-memory";
import {
  captureScrollAnchor,
  isAtChatContentBottom,
  restoreTargetTop,
  shouldCaptureChatScroll,
  type ChatScrollPosition,
} from "./chat-scroll-anchor";
import { useOpenPrUrlInReviewTab } from "@/renderer/shell/pr/use-open-review-tab";
import { warmWorkspaceFiles } from "@/renderer/shell/workspace-files-cache";
import { nativeInvoke, useNativeRuntime } from "@/renderer/platform/runtime";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import {
  useWorkspaceStore,
  useWorkspaceDispatch,
  recordWorkspaceActivity,
  useActiveChatId,
  useChatById,
  useBrowserPickerSelection,
  usePendingChatSubmission,
  usePendingAutoSend,
  usePendingAutoSendAt,
  usePendingComposerAppend,
  type ChatThread,
} from "../../state/store";
import { newChatId } from "../../state/chat-id";
import { expandMentionsInText } from "./mentions";
import {
  useComposerEditor,
  textToDoc,
  toMessageSegments,
  messageToEditorContent,
  type ComposerInitialContent,
  type ComposerSegment,
} from "./composer-editor";
import { QueuedMessagesCard } from "./queued-messages-card";
import {
  BackgroundTasksCard,
  BackgroundTasksWaitingLine,
  shouldKeepTurnLiveForBackgroundTasks,
  shouldShowBackgroundTasksCard,
} from "./background-tasks-card";
import { EmbeddedTerminalCommand } from "./embedded-terminal-command";
import { AddedDirectories } from "./added-directories";
import { PermissionCard } from "./permission-card";
import {
  browserConfirmationShouldTakeComposer,
  browserConfirmationToPermissionRequest,
  respondToBrowserConfirmation,
  useBrowserConfirmation,
} from "../browser/browser-confirmation-store";
import { PlanReviewCard } from "./plan-review-card";
import { GoalCard } from "./goal-card";
import { QuestionCard } from "./question-card";
import { readPlan, isPlanReviewRequest } from "./renderers/plan-body";
import { WorkspaceDirectoryPicker } from "./workspace-directory-picker";
import { useProjects } from "../../state/use-projects";
import { findProjectForFolder } from "../../state/workspace-resolution";
import { Bot, Square, ArrowLeft, Upload, Check } from "lucide-react";
import {
  encodeAttachments,
  reportSkippedAttachments,
} from "./encode-attachments";
import type { ComposerAttachment } from "./composer-attachments";
// Wave 4 (2026-05-16): the composer card is now built on the canonical
// AI Elements PromptInput recipe (form-shaped InputGroup with a
// block-end addon toolbar). Only COMPOSER_FILE_ACCEPT survives here
// (the file input still uses the same accept list) — the textarea
// autosize was removed with the textarea, and the visual shell moved
// off ComposerShell/ComposerTextarea/ComposerToolbar.
import { COMPOSER_FILE_ACCEPT } from "./composer-shell";
import { ComposerAttachmentMenu } from "./composer-attachment-menu";
import {
  Conversation,
  ConversationContent,
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
  toast,
} from "@/renderer/shared/ui/primitives/elements";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  getLiveChatDraft,
  registerLiveChatDraftRestorer,
  setLiveChatDraft,
} from "./composer-live-drafts";
import {
  deliverTextAttachmentToChat,
  hasPendingTextAttachmentDelivery,
  registerLiveChatTextAttachmentStager,
  trackPendingTextAttachmentDelivery,
  waitForPendingTextAttachmentDeliveries,
} from "./composer-text-attachment-delivery";
import { buildForkTranscriptAttachment, createForkedChat } from "./fork-chat";
import { resolveComposerPlaceholder } from "./composer-placeholder";
import {
  composerOwnsFocus,
  isFocusHeldElsewhere,
  nextComposerFocusAction,
  OPEN_OVERLAY_SELECTOR,
  shouldReclaimComposerFocus,
} from "./composer-focus";
import { costBumpToastShown, markCostBumpToastShown } from "./device-local";
import {
  bareInlineSlashCommand,
  slashCommandKind,
} from "../../platform/bridge/agent-events";
import type { ContentBlock } from "../../platform/bridge/agent-events";
import {
  isTransportShaped,
  type AgentFailure,
} from "../../platform/bridge/failure";
import type {
  AgentSessionControls,
  AgentSessionState,
  AgentTextMessage,
  MessageContentSegment,
} from "./use-agent-session";
import { MessageView, type RendererContext } from "./renderers";
import { computeEditBaselines } from "./renderers/tool-edit";
import { Button, cn } from "../../shared/ui";
import {
  ModelPill,
  PermissionToggle,
  PlanModeFrame,
  ComposerConcealedContext,
} from "./composer-pills";
import { ContextGauge } from "./context-gauge";
import { BoundaryPortsPill } from "./boundary-ports";
import { BoundaryStatusPill } from "./boundary-status";
import type { ExecutionBoundaryPortStatus } from "@zeros/protocol/containment";
import { createBrowserTab } from "@/renderer/shell/workbench/tab-model";
import {
  clearPreviewRuntimeForTab,
  stagePreviewNavigation,
} from "@/renderer/features/browser/preview-navigation";
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
import {
  useChatTranscriptSummaries,
  warmChatTranscriptSummaries,
} from "./use-chat-transcript-summaries";
import type { ChatSummaryWire } from "./agent-history-client";
import type { TranscriptMode } from "./transcript-format";
import {
  agentFamily,
  agentHasPermissionMenu,
  agentModeForPermission,
  coerceModeIdForModel,
  envForChat,
  permissionForAgentMode,
  permissionModeShowsFrame,
  staticModesForAgent,
} from "./model-catalog";
import {
  QUEUED_FIRST_TURN_MAX_WAIT_MS,
  queuedFirstTurnAction,
  sendSessionRecoveryMode,
  unreadableTranscriptSendAction,
} from "./session-reload-lifecycle";
import { requestAiChatTitle, settledFirstPromptForTitle } from "./chat-title";
import {
  newChatBornDefaults,
  rememberModelConfiguration,
  rememberPermissionMode,
} from "./new-chat-defaults";
import { resolveModelConfiguration } from "./model-preferences";
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
  isProviderTurnTail,
  isTailProviderTurnSegment,
  turnKey,
} from "./turn-container";
import { TurnEventList } from "./turn-event-list";
import { tailTurnInFlight } from "./tail-indicators";
import { pickActiveWorkflow } from "./workflow-activity";
import { stabilizeTurns } from "./stable-turns";
import { TurnFooter } from "./turn-footer";
import { JumpToLatestButton, JumpToPromptPill } from "./jump-pills";
import {
  CheckpointRail,
  sameCheckpoints,
  type Checkpoint,
} from "./checkpoint-rail";
import {
  MAX_MESSAGES_PER_CHAT,
  usePendingLocalTurnId,
  useSessionsStore,
} from "./sessions-store";
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

/** Map an AgentFailure (or the bare status
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
      case "rate-limited":
        return "Rate limited";
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
    case "rate-limited":
      return "RATE LIMITED";
    case "protocol-error":
      return "AGENT RESPONSE FAILURE";
    default:
      return null;
  }
}

interface AgentChatProps {
  session: AgentSessionState &
    AgentSessionControls & { hydrateChat(): Promise<void> };
  onBack: () => void;
  /** Optional right-aligned header slot (e.g. a "+ new chat" picker).
   *  When provided the default back button is hidden and the slot
   *  takes over header actions. Keeps the component reusable between
   *  the AgentMode picker flow (needs "back") and the Conversation pane chat
   *  flow (needs "+ new"). */
  headerActions?: React.ReactNode;
  /** When this chat is backed by a ChatThread in the store (Conversation pane
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
  // Hoisted so the
  // composer-draft seeding below can read state.chatComposerDrafts on
  // first render via the lazy useState initializer.
  const dispatch = useWorkspaceDispatch();
  const activeChatId = useActiveChatId();
  const browserPickerSelection = useBrowserPickerSelection();
  const pendingChatSubmission = usePendingChatSubmission();
  const pendingAutoSend = usePendingAutoSend(chatId);
  // The stamp, not just the flag: the park's release site bounds its own wait
  // (see queuedFirstTurnAction).
  const pendingAutoSendAt = usePendingAutoSendAt(chatId);
  const pendingComposerAppend = usePendingComposerAppend();
  // Chat-owned settings are needed by both the turn lifecycle and composer.
  // In particular, background continuation chrome is an Ultracode-only aid.
  const chatThread = useChatById(chatId);
  const titleRequestRef = useRef<{
    chatId: string;
    messageId: string;
  } | null>(null);
  const browserConfirmation = useBrowserConfirmation(chatId);
  const workflows = session.workflows;
  const activeWorkflow = useMemo(
    () => pickActiveWorkflow(workflows),
    [workflows],
  );
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
  const submitRef = useRef<(recordActivity?: boolean) => void>(() => {});
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
  // row. (The old "+N more changes" mergeKey collapse was removed
  // 2026-06-20: it folded edits to the same path across the whole session
  // into one card, which surprised users who saw an unexpected dropdown on a
  // file they'd edited in an earlier turn. `mergeKey` is still emitted by the
  // adapters but no longer consumed here.)
  const { visibleMessages, subagentChildren, editBaselines, queuedMessages } =
    useMemo(() => {
      const shadowed = new Set<string>();
      // Group child events of in-flight subagents under
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
  const foregroundStreaming = session.status === "streaming";
  const backgroundTaskOptions = {
    agentId: session.agentId,
    effort: chatThread?.effort ?? null,
    foregroundStreaming,
    taskCount: session.backgroundTasks.length,
  };
  const showBackgroundTasksCard = shouldShowBackgroundTasksCard(
    backgroundTaskOptions,
  );
  const backgroundContinuationActive = shouldKeepTurnLiveForBackgroundTasks(
    backgroundTaskOptions,
  );
  useEffect(() => {
    if (
      !chatId ||
      !chatThread ||
      backgroundContinuationActive ||
      (chatThread.title !== "Untitled" && chatThread.title !== "New chat")
    )
      return;
    const candidate = settledFirstPromptForTitle({
      status: session.status,
      messages: session.messages,
    });
    if (!candidate) return;
    const prior = titleRequestRef.current;
    if (prior?.chatId === chatId && prior.messageId === candidate.messageId) {
      return;
    }
    const launched = requestAiChatTitle({
      chatId,
      agentId: chatThread.agentId ?? session.agentId ?? null,
      prompt: candidate.prompt,
      expectedTitle: chatThread.title,
      dispatch,
    });
    if (launched) {
      titleRequestRef.current = { chatId, messageId: candidate.messageId };
    }
  }, [
    backgroundContinuationActive,
    chatId,
    chatThread,
    dispatch,
    session.agentId,
    session.messages,
    session.status,
  ]);
  // A quiet Claude background continuation is still part of the active turn:
  // keep its working stripe/shimmer and withhold the final answer/footer until
  // the provider's authoritative active-task set becomes empty.
  const isStreaming = foregroundStreaming || backgroundContinuationActive;
  // QuestionCard's submit hook routes through session.sendPrompt (see the
  // RendererContext contract).
  const respondToQuestion = useCallback(
    (text: string) => {
      if (chatThread?.folder) recordWorkspaceActivity(chatThread.folder);
      session.sendPrompt(text, text).catch(() => {
        /* error surfaces via session.error */
      });
    },
    [chatThread?.folder, session],
  );
  // pendingPermission is threaded into ctx so the matching
  // tool card can render its inline Allow/Deny cluster. respondToPermission
  // is the same call as the global PermissionBar; both surfaces share it.
  const respondToPermission = useCallback(
    (
      response: import("../../platform/bridge/agent-events").RequestPermissionResponse,
    ) => {
      if (chatThread?.folder) recordWorkspaceActivity(chatThread.folder);
      session.respondToPermission(response);
    },
    [chatThread?.folder, session],
  );
  // Sticky-policy mutators are bound to the active chatId so
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
  // Surface the session's setMode through ctx so the
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

  // Click-to-edit on past user messages. Truncate in-memory + SQLite at the
  // edited message
  // (inclusive), then dispatch editedText as a fresh prompt. We do
  // not revert files on disk. Editing transcript history and reverting working
  // tree state are deliberately separate operations.
  const editAndResubmit = useCallback(
    async (
      messageId: string,
      editedText: string,
      // ALL staged attachments (reconstructed originals + new), inline.
      attachments: ComposerAttachment[],
      segments?: ComposerSegment[],
    ) => {
      const trimmed = editedText.trim();
      if (!chatId) return;
      if (trimmed.length === 0 && attachments.length === 0) {
        return;
      }
      // The edit is accepted now; record before cancellation/attachment/SQLite
      // awaits so a slow resubmit cannot later leapfrog another workspace.
      if (chatThread?.folder) recordWorkspaceActivity(chatThread.folder);
      // If the user edits the
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
      // support) + bubble metadata. A reconstructed chip carries only its
      // durable context-graph reference (legacy image rows may still carry a
      // data URL), so the encoder resolves BOTH image bytes and text bodies
      // back out of the graph for this send alone — neither is ever copied
      // into the message or the composer document.
      //
      // Same encoder as the live send path (2026-07-30) — these were two
      // copies and only this one was right.
      const {
        blocks: newBlocks,
        bubbleAttachments: newBubbleMeta,
        bubbleAttachmentById,
        skipped: skippedOnEdit,
      } = await encodeAttachments(attachments, {
        supportsImage:
          session.initialize?.agentCapabilities?.promptCapabilities?.image !==
          false,
        cwd: session.cwd || null,
        chatId,
        agentId: session.agentId,
      });
      // This path is the one that can drop an attachment for a reason the
      // user never caused, so it can least afford to stay quiet: a
      // reconstructed chip holds no bytes of its own, and the encoder's
      // recovery read fails whenever the graph record was deleted, moved out
      // of the workspace, or is unreachable. Before that report existed the
      // chip simply vanished from the resubmitted bubble and the agent
      // received nothing, with no explanation anywhere.
      reportSkippedAttachments(skippedOnEdit, toast.warning);
      const mergedBubble = newBubbleMeta;
      const messageSegments = toMessageSegments(
        segments ?? [],
        attachments,
        bubbleAttachmentById,
      );
      // Truncate in-memory FIRST so the UI reflects the edit immediately.
      useSessionsStore
        .getState()
        .truncateMessagesFromInMemory(chatId, messageId);
      // Await the SQLite
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
          messageSegments.length > 0 ? messageSegments : undefined,
        )
        .catch(() => {
          /* error surfaces via session.error */
        });
    },
    [chatId, chatThread?.folder, session],
  );

  // Forward-ref to the composer hook's
  // openPreview. messageCtx is declared above the hook call so we
  // can't read it directly; the ref is populated after the hook
  // returns, and a stable wrapper reads through it. Result: clicking
  // a sent-bubble image opens the same lightbox the composer uses.
  const openPreviewRef = useRef<((src: string) => void) | null>(null);
  const previewImageThroughRef = useCallback((src: string) => {
    openPreviewRef.current?.(src);
  }, []);
  // Clickable file paths in agent output open in workbench as their own tab. The
  // chat's cwd isn't known until chatThread resolves below, and the open
  // helper's identity changes with the workbench tab list — both are read through
  // refs so messageCtx (and every message renderer) stays stable.
  const chatCwdRef = useRef<string | undefined>(undefined);
  const openChatFile = useOpenChatFileInWorkbench();
  const openChatFileRef = useRef(openChatFile);
  useEffect(() => {
    openChatFileRef.current = openChatFile;
  }, [openChatFile]);
  const openFileThroughRef = useCallback((path: string) => {
    openChatFileRef.current(chatCwdRef.current, path);
  }, []);
  // A clicked link to the ACTIVE workspace's PR focuses workbench's Review tab
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
  const retrySafetyReviewRef = useRef(session.retrySafetyReview);
  retrySafetyReviewRef.current = session.retrySafetyReview;
  const retrySafetyReviewThroughRef = useCallback((retryId: string) => {
    const retry = retrySafetyReviewRef.current;
    return retry
      ? retry(retryId)
      : Promise.reject(new Error("Safety retry is unavailable."));
  }, []);
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
      retrySafetyReview: retrySafetyReviewThroughRef,
      safetyReviewRetries: session.safetyReviewRetries,
      recordPolicy,
      chatId: chatId ?? null,
      setMode: setModeForCtx,
      editAndResubmit,
      previewImage: previewImageThroughRef,
      attachmentCwd: chatThread?.folder ?? session.cwd ?? null,
      attachmentImagesActive: surfaceActive,
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
      retrySafetyReviewThroughRef,
      session.safetyReviewRetries,
      recordPolicy,
      chatId,
      setModeForCtx,
      editAndResubmit,
      previewImageThroughRef,
      chatThread?.folder,
      session.cwd,
      surfaceActive,
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
  // Store selectors and dispatch are hoisted to the top of AgentChat so
  // composer-draft seeding can read on
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
          description: `${res.error ?? "Unknown error."} You can also sign in from Settings → Agents.`,
        });
      }
    });
  }, [nativeReady, signInAgentId, session]);
  // Keep the ref the chat file-open closure reads in sync with the chat's
  // workspace owner. The session cwd is only a pre-hydration fallback: if an
  // engine ever reports a nested cwd, its file link still belongs to the
  // Workbench slice keyed by the chat's bound folder.
  useEffect(() => {
    const cwd = chatFileOpenCwd(chatThread?.folder, session.cwd);
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

  // Single source of truth for "which past
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
      rememberPermissionMode(chatAgentId, planAgentModeId);
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
    rememberPermissionMode(chatAgentId, backId);
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
      rememberPermissionMode(chatAgentId, modeId);
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
    session.boundary,
  );

  // Show the composer permission toggle when the agent has a native-mode
  // vocabulary. Includes Cursor (Ask/Edit).
  const showPermissionToggle = agentHasPermissionMenu(
    chatAgentId,
    chatThread?.model ?? null,
  );

  // Dashed composer frame for the guarded "propose, don't act" modes — Claude
  // Plan, Codex Ask for approval, and Cursor Ask.
  const composerGuarded = permissionModeShowsFrame(
    chatAgentId,
    currentPermissionModeId,
  );

  // Has this chat's conversation STARTED (first prompt sent)? Reactive twin
  // of the click-time `pristine` check below: in-memory messages OR the
  // promoted title (the durable tell that survives an engine respawn while
  // disk history hydrates). Drives the dropdown's ↗ redirect arrows — a
  // fresh chat switches agents freely; a started chat IS its agent's
  // session, so other agents' models open a new tab.
  const hasSessionMessages = useSessionsStore((s) => {
    if (!chatId) return false;
    const slot = s.sessions[chatId];
    return !!slot && (slot.hasTranscript || slot.messages.length > 0);
  });
  const transcriptKnown = useSessionsStore((s) =>
    chatId
      ? (s.sessions[chatId]?.transcriptState ?? "resident") === "resident"
      : true,
  );
  // Which turn (if any) this renderer has an unsettled prompt for. The tail's
  // liveness is derived from this rather than from session status, so a chat
  // being REOPENED — a tab switch, a workspace switch, an app reload, all of
  // which warm a session — never repaints a finished turn as working.
  const pendingLocalTurnId = usePendingLocalTurnId(chatId);
  const conversationStarted =
    hasSessionMessages ||
    !transcriptKnown ||
    (chatThread ? chatThread.title !== "Untitled" : false);

  // One-time-per-WORKSPACE cost heads-up, shown as a toast and scoped per
  // workspace rather than per chat. The prompt cache is keyed by model AND
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

  // Cross-agent pick from the unified model dropdown. The ModelPill lists
  // EVERY agent's models behind a logo rail. Two paths:
  //
  //   FRESH chat (nothing sent yet) → switch IN PLACE, same tab, same strip
  //   position. Recreating the chat would move the tab to the end of the strip.
  //   Switching in place is safe because nothing agent-specific exists yet:
  //   closeSession tears down a live warm session (and drops its slot) so
  //   ChatView's warmup effect — re-fired by the agentId change —
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
      // Exact-key restoration: a model always gets its own last effort/Fast
      // pair. Never carry the source model's configuration across this switch.
      const { effort, fast } = resolveModelConfiguration(
        sel.agentId,
        sel.model,
        null,
      );
      // Pristine = nothing sent yet. Both signals must agree: zero in-memory
      // messages AND the never-promoted "Untitled" title — after an engine
      // respawn the sessions slot is empty while disk history hydrates, and
      // the title is the durable tell that a first message ever happened.
      const currentSlot = useSessionsStore.getState().sessions[chatId];
      const pristine =
        (currentSlot?.transcriptState ?? "resident") === "resident" &&
        !currentSlot?.hasTranscript &&
        (currentSlot?.messages.length ?? 0) === 0 &&
        chatThread.title === "Untitled";
      if (pristine) {
        agentSessions.closeSession(chatId);
        updateChatSettings({
          agentId: sel.agentId,
          agentName: sel.agentName || null,
          model: sel.model,
          effort,
          fast,
          permissionMode: born.permissionMode,
          lastModeId: born.lastModeId,
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
        ...(born.lastModeId ? { lastModeId: born.lastModeId } : {}),
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
      dispatch({
        type: "ADD_CHAT",
        chat: fresh,
        recordWorkspaceActivity: true,
      });
    },
    [chatThread, chatId, dispatch, agentSessions, updateChatSettings],
  );

  // The toolbar pills the main composer
  // renders, ALSO reused in TurnPromptHeader's edit mode so editing a past
  // prompt has the same configured-model / permissions affordances. Effort and
  // Fast remain editable inside ModelPill's popover and are summarized in its
  // one visible label instead of consuming separate toolbar controls.
  const editToolbarPills = useMemo(() => {
    if (!chatThread) return null;
    return (
      <>
        <ModelPill
          agentId={chatThread.agentId}
          initialize={session.initialize}
          value={chatThread.model}
          effort={chatThread.effort}
          fast={!!chatThread.fast}
          onSelectAgentModel={switchAgentModel}
          redirectCrossAgent={conversationStarted}
          onConfigure={({ effort, fast }) => {
            const effortChanged = effort !== chatThread.effort;
            updateChatSettings({ effort, fast });
            session.updateConfig?.();
            if (effortChanged) maybeShowCostBumpToast("effort");
          }}
          onChange={(v) => {
            const configuration = resolveModelConfiguration(
              chatThread.agentId,
              v,
              session.initialize,
            );
            updateChatSettings({ model: v, ...configuration });
            // Apply to the LIVE session too, so the change takes effect on the
            // next turn instead of only on a rebuild.
            if (v) session.setModel?.(v);
            // updateConfig as well, and deliberately AFTER setModel: it pushes
            // the WHOLE composer env, so it also carries the effortReset /
            // fastReset above (which setModel alone would strand on the live
            // session), and it is what stamps appliedChatEnvKey so sendPrompt's
            // drift reconcile doesn't respawn for a change already applied.
            session.updateConfig?.();
            // Once per chat, a mid-conversation model change is a
            // cache miss on the next reply (slower + more tokens).
            if (v && v !== chatThread.model) maybeShowCostBumpToast("model");
          }}
        />
        {showPermissionToggle && (
          // The permission toggle sits where the Plan pill
          // used to — icon-only, cycles the agent's native modes on click,
          // names the current mode on hover. Replaces the "+" → Permissions
          // submenu (removed) as THE mode selector.
          <PermissionToggle
            agentId={chatAgentId}
            model={chatThread.model}
            boundary={session.boundary}
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
    session.boundary,
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

  const openBoundaryPort = session.openBoundaryPort;
  const openBoundaryPreview = useCallback(
    (port: ExecutionBoundaryPortStatus) => {
      void (async () => {
        try {
          if (!openBoundaryPort) {
            throw new Error("preview opening is unavailable");
          }
          const opened = await openBoundaryPort(port.id);
          const tab = createBrowserTab({
            url: opened.url,
            title: `localhost:${port.port}`,
            ...(chatId ? { previewSource: { chatId, port: port.port } } : {}),
          });
          const staged = stagePreviewNavigation(tab.id, opened);
          if (nativeReady && staged.volatileOrigin) {
            try {
              const authorized = await nativeInvoke<{ ok: boolean }>(
                "browser:authorize-preview-origin",
                {
                  frameName: `zeros-browser-${tab.id}`,
                  origin: staged.runtimeOrigin,
                  expiresAt: staged.expiresAt,
                },
              );
              if (!authorized.ok) {
                throw new Error("preview origin was not authorized");
              }
            } catch (error) {
              clearPreviewRuntimeForTab(tab.id);
              throw error;
            }
          }
          dispatch({
            type: "ADD_WORKBENCH_TAB",
            ...(chatThread?.folder ? { scope: chatThread.folder } : {}),
            tab,
          });
        } catch {
          toast.error("Preview could not be opened", {
            description: "Restart the server or session, then try again.",
          });
        }
      })();
    },
    [chatId, chatThread?.folder, dispatch, nativeReady, openBoundaryPort],
  );

  // 2026-05-21: handleAgentSwitch + folderLabel removed. The old
  // SummaryHandoffPill went with that UI. `sourceChatId` now records only
  // Zeros-native fork lineage; the fork action stages its transcript directly
  // in the destination composer instead of rendering a second handoff pill.

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
  // The composer "+" → "Attach chat transcript" picker. Ephemeral: it is a
  // transient dialog, not a durable selection.
  const [transcriptPickerOpen, setTranscriptPickerOpen] = useState(false);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);

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
          if (isPlanMode) exitPlanMode();
          else enterPlan();
          return true;
        }
        case "fast": {
          const fast = !chatThread.fast;
          rememberModelConfiguration(chatThread.agentId, chatThread.model, {
            fast,
          });
          updateChatSettings({ fast });
          // Apply to the LIVE session too (Claude SDK), so the change takes
          // effect on the next turn instead of only on a rebuild.
          session.updateConfig?.();
          return true;
        }
        case "ultracode":
          rememberModelConfiguration(chatThread.agentId, chatThread.model, {
            effort: "ultracode",
          });
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
          // Real compaction uses one path for every agent —
          // AGENT_COMPACT → adapter.compactContext (Codex: the
          // thread/compact/start RPC; Claude: the CLI-intercepted "/compact"
          // fed turnless into the SDK stream). Deliberately NOT a sendPrompt:
          // no "/compact" user bubble ever lands in the transcript — the
          // compaction narrates itself as a standalone agent-output row
          // ("Compacting.." → "Context compacted").
          void session.compactContext?.();
          return true;
        case "goal":
          setGoalEditorOpen(true);
          return true;
        case "clear": {
          // Close THIS chat and open a fresh one bound to the same
          // agent/model/workspace, then navigate to it. As with tab close,
          // closeSession stops and reaps the old execution. Its transcript stays
          // on disk and ARCHIVE_CHAT only removes it from the open strip — it
          // remains reopenable from History.
          // (chatThread is non-null per the guard above, so
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
            lastModeId: chatThread.lastModeId,
            prePlanModeId: chatThread.prePlanModeId,
            title: "Untitled",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          // ADD_CHAT also sets the new chat active → navigation. Archiving the
          // old chat AFTERWARD leaves it non-active, so focus stays on the new
          // one (no replacement-neighbor selection like the tab-close path).
          dispatch({
            type: "ADD_CHAT",
            chat: fresh,
            recordWorkspaceActivity: true,
          });
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
      enterPlan,
      exitPlanMode,
      dispatch,
      agentSessions,
      updateChatSettings,
      isPlanMode,
    ],
  );

  const saveGoal = useCallback(
    async (objective: string) => {
      if (!session.setGoal) throw new Error("Goals are unavailable.");
      try {
        await session.setGoal({ objective });
      } catch (error) {
        toast.error("Couldn't save the goal", {
          description: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [session],
  );

  const setGoalStatus = useCallback(
    async (status: "active" | "paused") => {
      if (!session.setGoal) throw new Error("Goals are unavailable.");
      try {
        await session.setGoal({ status });
      } catch (error) {
        toast.error(
          `Couldn't ${status === "paused" ? "pause" : "resume"} the goal`,
          {
            description: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
    },
    [session],
  );

  const deleteGoal = useCallback(async () => {
    if (!session.clearGoal) throw new Error("Goals are unavailable.");
    try {
      await session.clearGoal();
      setGoalEditorOpen(false);
    } catch (error) {
      toast.error("Couldn't delete the goal", {
        description: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }, [session]);

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
    attachmentImagesActive: surfaceActive,
    originUrl: composerOriginUrl,
    availableCommands: session.availableCommands,
    placeholder: resolveComposerPlaceholder(conversationStarted),
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

  // A fork publishes its new tab before the transcript read settles. Register
  // only while THIS retained surface is active: insertTextAttachment focuses
  // the editor, so a hidden destination must queue the chip instead of stealing
  // focus from whichever chat the user moved to meanwhile.
  useEffect(() => {
    if (!chatId || !surfaceActive || !composerEditor) return;
    return registerLiveChatTextAttachmentStager(chatId, (input) => {
      const staged = stageTextAttachment(input);
      if (staged && !staged.ok) {
        toast.warning(
          `Attached "${input.name}", but it won't be sent — ${staged.reason ?? "it exceeds this model's attachment budget"}.`,
        );
      }
      return staged !== null;
    });
  }, [chatId, composerEditor, surfaceActive, stageTextAttachment]);

  // ── attach another chat's transcript ──
  //
  // The read is gated three ways. `surfaceActive` because retained background
  // chats keep this component mounted, and without it every hidden tab
  // re-pulls the folder's chat list on every DB_CHANGED tick (AGENTS.md:
  // hidden surfaces are inert). The other two are the surfaces that consume
  // it: the row (empty chat only) and the "+" picker (any time). The small menu
  // calls warmChatTranscriptSummaries on pointer/focus intent, so it can stay
  // locally stateful and the dialog still opens from the exact-key cache.
  const transcriptRowLive =
    session.transcriptState === "resident" &&
    session.messages.length === 0 &&
    !session.error &&
    !!chatThread?.folder;
  const [showTranscriptLoading, setShowTranscriptLoading] = useState(false);
  useEffect(() => {
    if (session.transcriptState === "resident") {
      setShowTranscriptLoading(false);
      return;
    }
    // Genuine cold DB load. Delay the indicator so normal local reads do not
    // flash; this is not masking a waterfall—the retained deck already warms
    // likely destinations and the composer stays intact while the exact read
    // completes.
    const timer = window.setTimeout(() => setShowTranscriptLoading(true), 180);
    return () => window.clearTimeout(timer);
  }, [session.transcriptState]);
  const { summaries: transcriptSummaries, loaded: transcriptsLoaded } =
    useChatTranscriptSummaries(
      chatThread?.folder,
      chatId,
      surfaceActive && (transcriptRowLive || transcriptPickerOpen),
    );
  const warmTranscriptPicker = useCallback(() => {
    warmChatTranscriptSummaries(chatThread?.folder, chatId);
  }, [chatThread?.folder, chatId]);
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
  // True while a send is being PREPARED — from the first keystroke-triggered
  // submit until the composer is cleared and the prompt has been handed to the
  // provider. Every stretch in there can be re-entered with the composer still
  // full (a cold transcript read, a session rebuild), and each re-entry
  // snapshots the same composer and sends it again. See handleSend.
  const sendInFlightRef = useRef(false);
  // The rendered half of the same fact, for the ONE stretch a user can actually
  // notice: a send parked on a cold transcript read or a session rebuild, which
  // on a cold provider host takes tens of seconds. The submit button shows the
  // spinner ("submitted") for it, so a composer that still holds the text reads
  // as "working on it" instead of an unresponsive button.
  const [sendPreparing, setSendPreparing] = useState(false);

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
      // Fire-and-forget: the click handler must not await I/O. The
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

  const readForkTranscript = useCallback(
    (throughMessageId: string, promptFallback: string) => {
      if (!chatId || !chatThread) return null;
      const sourceLabel = transcriptPillLabel({
        title: chatThread.title,
        summary: promptFallback,
      });
      return {
        sourceLabel,
        promise: loadTranscriptSnapshot({
          chatId,
          mode: "concise",
          lastMessageAt: chatThread.updatedAt,
          throughMessageId,
          meta: { title: sourceLabel, folder: chatThread.folder },
        }),
      };
    },
    [chatId, chatThread],
  );

  /** Menu hover/focus pays the exact-key transcript read ahead of the click.
   * Preview errors stay silent; selecting the action is the point at which a
   * real read failure becomes user-visible. */
  const warmForkToNewTab = useCallback(
    (throughMessageId: string, promptFallback: string) => {
      void readForkTranscript(throughMessageId, promptFallback)?.promise.catch(
        () => {},
      );
    },
    [readForkTranscript],
  );

  const forkToNewTab = useCallback(
    (throughMessageId: string, promptFallback: string) => {
      if (!chatThread) return;
      const transcript = readForkTranscript(throughMessageId, promptFallback);
      if (!transcript) return;

      // Route + destination publish in one synchronous transition. The native
      // provider binding, execution id, messages, queues, and drafts are not
      // copied; only Zeros-owned chat settings and source lineage cross.
      const fresh = createForkedChat(chatThread);
      dispatch({ type: "ADD_CHAT", chat: fresh });

      const delivery = transcript.promise
        .then((snapshot) => {
          // The user may permanently delete the destination while the bounded
          // history walk is in flight. Do not retain an orphan delivery.
          if (
            !useWorkspaceStore
              .getState()
              .chats.some((candidate) => candidate.id === fresh.id)
          ) {
            return;
          }
          if (snapshot.count === 0) {
            throw new Error("The selected turn has no concise transcript.");
          }
          deliverTextAttachmentToChat(
            fresh.id,
            buildForkTranscriptAttachment({
              sourceChatId: chatThread.id,
              sourceLabel: transcript.sourceLabel,
              text: snapshot.text,
              complete: snapshot.complete,
            }),
          );
        })
        .catch((error) => {
          if (
            !useWorkspaceStore
              .getState()
              .chats.some((candidate) => candidate.id === fresh.id)
          ) {
            return;
          }
          console.error("[Zeros] conversation fork transcript failed:", error);
          toast.error("Couldn't attach the fork transcript — try again.");
        });
      trackPendingTextAttachmentDelivery(fresh.id, delivery);
    },
    [chatThread, dispatch, readForkTranscript],
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
   *  there is nothing to show — and then conversation/pane-layout' selection keeper sees
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

  // Per-chat scroll memory is anchor-based so layout changes do not drift it.
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

  // Sticky-bottom auto-scroll with unstick-on-user-scroll replaces the former
  // "snap to bottom on every change" behavior. See
  // use-sticky-bottom.ts for the rationale. The hook skips its first
  // content-run so the restore effect above takes precedence on mount.
  // bottomInsetPx: the checkpoint spacer is blank scroll room, not
  // content — while it's active the auto-snap pauses (the rail owns
  // viewport stability there), "at bottom" means the CONTENT bottom
  // (so the jump pill doesn't appear over the deliberate blank tail), and
  // jumpToBottom targets the content
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
  // store-owned node parks outside the document — see conversation/pane-portal-store),
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

  // There is no "Load older" pill; scrolling back should show everything
  // without a separate affordance.
  // Hydration pulls the most-recent 200 messages on chat
  // open; older transcript sits on disk and auto-pages in as the user
  // scrolls toward the top. loadOlder preserves the viewport (scrollTop
  // is bumped by the prepend's height delta), so paging never yanks the
  // content the user is reading.
  const LOAD_OLDER_PAGE = 200;
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Whether more older messages might exist on disk. Default to false on chat
  // mount and probe
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
  // stream never re-renders the transcript; styles/global/runtime-content.css keys the
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
        // Deduplicate against the current in-memory
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

  // Group the flat message list into turns for per-turn
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

  // Send-jump: sending never re-frames the sent prompt to the top
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

  // ⌘K — focus the composer from anywhere in the app; scoped to avoid
  // clobbering ⌘K inside native inputs.
  // ⌘↑ / ⌘↓ — jump-by-text-message: walks user prompts and final
  // assistant text, skipping tool-call + thinking chunks. Solves the
  // need to find the initiating prompt during long runs.
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
    if (!chatId) return;
    return registerLiveChatDraftRestorer(chatId, (draft) => {
      // A queued-message edit or newer typing owns the editor now. The live
      // draft coordinator also checks its keystroke-fresh mirror, while this
      // final editor read covers imperative content that deliberately paused
      // live persistence.
      if (editingQueuedRef.current) return false;
      const current = serializeComposerState();
      if (current && !current.isEmpty) return false;
      setComposerContent({
        json: draft.json ?? (draft.text.trim() ? textToDoc(draft.text) : null),
        attachments: draft.attachments,
      });
      composerLiveRef.current = {
        text: draft.text,
        attachments: draft.attachments,
        json: draft.json ?? null,
      };
      return true;
    });
  }, [chatId, serializeComposerState, setComposerContent]);
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
        // instead of stacking identical copies.
        id: `agent-error-${chatId ?? agentLabel}`,
        description: isAuth
          ? `Open Settings → Agents to sign in to ${agentLabel}.`
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

  // Context gauge: the ring + breakdown popover beside Send. Cursor's
  // SDK reports no token usage and has no compaction call — its ring renders
  // disabled with an honest popover note instead
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
  const browserPermissionCardActive = browserConfirmationShouldTakeComposer({
    browserPending: Boolean(browserConfirmation),
    providerPermissionPending: Boolean(session.pendingPermission),
    providerIsPlanReview: Boolean(planReview),
  });
  const providerPermissionCardActive =
    !!session.pendingPermission && !planReview && !browserPermissionCardActive;
  // Browser confirmations are main-process gates owned by the exact chat that
  // started the browser session. They reuse this existing card instead of a
  // global dialog. A provider-native hard permission remains ahead of them;
  // non-blocking plan review yields so asynchronous browser work cannot stall
  // with no visible decision surface.
  const permissionCardActive =
    providerPermissionCardActive || browserPermissionCardActive;
  const permissionRequest = useMemo(
    () =>
      browserPermissionCardActive && browserConfirmation
        ? browserConfirmationToPermissionRequest(browserConfirmation)
        : (session.pendingPermission?.request ?? null),
    [
      browserConfirmation,
      browserPermissionCardActive,
      session.pendingPermission,
    ],
  );
  const respondToVisiblePermission = useCallback(
    (
      response: import("../../platform/bridge/agent-events").RequestPermissionResponse,
    ) => {
      if (browserPermissionCardActive && browserConfirmation) {
        void respondToBrowserConfirmation(browserConfirmation, response).catch(
          () => {
            toast.error("Couldn't respond to the browser permission request.");
          },
        );
        return;
      }
      if (session.pendingPermission) session.respondToPermission(response);
    },
    [browserConfirmation, browserPermissionCardActive, session],
  );

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
  // local ComposerAttachmentMenu and ModelPill both derive closed from this
  // value in the same render.
  const composerConcealed =
    !surfaceActive || permissionCardActive || questionCardActive;
  // Live mirror for the always-focus guardian's document listener, so it can
  // read the current concealment without re-subscribing on every card toggle.
  const composerConcealedRef = useRef(composerConcealed);
  composerConcealedRef.current = composerConcealed;

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
  // or into workbench (Files/Changes/Review/Terminal), which lives OUTSIDE this
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
  // never re-runs and focus stayed lost until the next window switch.
  //
  // This guardian closes it: a real pointer click anywhere inside the active
  // window returns focus to its composer, so the user can always just type. It
  // stands down for workbench (Files/Changes/Review/Terminal — clicks there land
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
  // open and instantly closed. A macrotask runs after
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
      // ours (workbench, another pane, the top bar).
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
            // rips focus out of the opening overlay and Radix dismisses it.
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

  // `failed` / `auth-required` do not disable Send. With the
  // inline error banners gone (01u — errors are toasts), a disabled composer
  // made a failed chat a DEAD END: the toast said "retry / send again" but
  // there was nothing to click. Sending from an error state is the retry affordance:
  // handleSend rebuilds the session via startSession — one attempt per
  // explicit user send, never an automatic loop. The Send button keeps its
  // "error" tint (PromptInputSubmit status) so the state still reads.
  const canSend =
    session.transcriptState === "resident" &&
    !composerStreaming &&
    !permissionCardActive &&
    !questionCardActive &&
    !composerEmpty;

  // Image attachments are universal —
  // every image is persisted to
  // <cwd>/.context-graph/<scope>/attachments/…; vision-capable agents also get
  // the transient inline ImageContent block, while everyone else gets a text
  // block referencing the path (their models still Read the file). Transcript
  // payloads retain only that path, never the full-resolution base64.
  // Shared by handleSend and the queued-message edit save, so an edited
  // queued send re-encodes its attachments exactly like a fresh one.
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

  /** The chat whose send is already parked on an unreadable transcript. One
   *  automatic retry: the drain re-enters runSend, which re-hydrates, and if
   *  the read fails AGAIN there is no point cycling park → drain → park at
   *  hydrate-RPC speed. Cleared whenever the transcript reads normally, so a
   *  later disconnect gets its own retry. */
  const transcriptParkedChatRef = useRef<string | null>(null);

  /** Park a send that arrived while this chat's transcript could not be read
   *  (engine respawning, transport dropped, a cold read that failed). Same
   *  mechanism as the provisioning park: keep the exact TipTap document as the
   *  chat's draft, arm its one-shot auto-send, and let the readiness drain
   *  dispatch it. Says so either way — the one thing this must never do again
   *  is nothing. */
  const parkUnreadableTranscriptSend = (
    parkChatId: string,
    override?: string,
  ): void => {
    const snapshot = override === undefined ? serializeComposerState() : null;
    const action = unreadableTranscriptSendAction({
      hasPayload: snapshot
        ? !snapshot.isEmpty
        : (override ?? "").trim().length > 0,
      payloadInComposer: snapshot !== null,
      alreadyRetried: transcriptParkedChatRef.current === parkChatId,
      status: session.status,
    });
    if (action === "ignore") return;
    const alreadyArmed =
      useWorkspaceStore.getState().pendingAutoSend[parkChatId] !== undefined;
    if (action === "report" || !snapshot) {
      if (!alreadyArmed) {
        toast.warning("Couldn’t send yet", {
          description:
            "This chat is still reconnecting. Your message is in the composer — send it again in a moment.",
          id: `chat-send-transcript-unavailable-${parkChatId}`,
        });
      }
      return;
    }
    transcriptParkedChatRef.current = parkChatId;
    const draft = {
      text: snapshot.displayText,
      attachments: snapshot.attachments,
      json: snapshot.json,
    };
    composerLiveRef.current = draft;
    dispatch({ type: "SET_CHAT_DRAFT", chatId: parkChatId, draft });
    if (alreadyArmed) return;
    dispatch({ type: "REQUEST_AUTO_SEND", chatId: parkChatId });
    toast.info("Message queued", {
      description: "It will send as soon as this chat reconnects.",
      id: `workspace-message-queued-${parkChatId}`,
    });
  };

  const runSend = async (
    override?: string,
    extras?: {
      /** Inline summary imports from prior chats. Serialized
       *  into <from_previous_chat> text blocks and prepended to the
       *  prompt so the agent reads them as opening context. Used by
       *  the EmptyComposer hand-off path. */
      imports?: import("../../state/store").SummaryImport[];
      /** Attachments handed in from another surface (browser capture). They
       *  still pass through encodeAttachments here so disk persistence and
       *  transcript metadata are identical to paste/drop. */
      stagedAttachments?: ComposerAttachment[];
      /** Pre-built ContentBlocks (e.g. image attachments queued in the
       *  EmptyComposer). Appended after the local attachments array
       *  so both sources ride along on the same send. */
      extraAttachments?: ContentBlock[];
      /** Metadata for the user-bubble chip row.
       *  When the EmptyComposer hands off a new chat, it has already
       *  computed the thumbnails / disk paths for staged files and
       *  passes them here so the seeded message renders the chips
       *  identically to what the user saw in the composer. */
      bubbleAttachments?: import("./use-agent-session").AgentTextMessageAttachment[];
      /** Ordered bubble segments (text + inline pills) for the EmptyComposer
       *  hand-off path; the direct-send path derives them from the editor. */
      bubbleSegments?: MessageContentSegment[];
    },
    recordActivity = true,
  ) => {
    // A transcript click starts an engine read and returns immediately (Rule
    // 11), so a cold-cache click followed by a fast Enter would snapshot the
    // composer BEFORE the chip lands: the prompt goes without the transcript,
    // and the read then stages the chip into the freshly-cleared composer,
    // where it silently rides the user's next message. Wait for explicitly
    // staged reads before snapshotting. Normally a no-op — the
    // hover warmed it, so the set is already empty by the time Enter lands.
    // This is not the forbidden "click handler awaits I/O": Send is the
    // commit, and a commit must include what the user staged.
    //
    // handleSend's single-flight guard is what makes that await safe: everything
    // that stops this composer being sent twice — clearComposer, the empty check
    // — happens further down, so awaiting here (or at the session rebuild below)
    // opens a window in which a second Enter re-enters, snapshots the same
    // composer state, and sends it again.
    const hydrateNeeded = session.transcriptState !== "resident";
    const forkAttachmentPending = chatId
      ? hasPendingTextAttachmentDelivery(chatId)
      : false;
    if (
      hydrateNeeded ||
      transcriptAttachesRef.current.size > 0 ||
      forkAttachmentPending
    ) {
      setSendPreparing(true);
      try {
        if (hydrateNeeded) await session.hydrateChat();
        await Promise.allSettled([...transcriptAttachesRef.current]);
        if (chatId) await waitForPendingTextAttachmentDeliveries(chatId);
      } finally {
        setSendPreparing(false);
      }
    }
    // A disconnected/failed cold read deliberately leaves the composer intact.
    // Never append a new user bubble to an empty partial transcript — reconnect
    // will retry the exact hydrate and the same draft can then be sent.
    //
    // A chat with NO slot at all is different from a partial cold read: a
    // provisioning workspace never hydrates (chat-view returns before
    // hydrateChat), so bailing here would silently swallow the send BEFORE the
    // provisioning branch below could queue it and say so. Let that one case
    // fall through — the provisioning branch keeps the draft and queues an
    // auto-send.
    //
    // Every OTHER unreadable state used to `return` here and say NOTHING: the
    // composer kept the text, no bubble appeared, no toast, and pressing Enter
    // again did the same nothing. That is the second half of the reported
    // "I sent it before the workspace was ready and it never went" — an engine
    // respawn or a dropped transport is exactly when the hydrate above fails,
    // and it is the same pre-ready window the provisioning park already
    // covers. So park it the same way and let the reconnect drain it.
    {
      const storeTranscriptState = chatId
        ? useSessionsStore.getState().sessions[chatId]?.transcriptState
        : "resident";
      if (
        chatId &&
        storeTranscriptState !== "resident" &&
        !(storeTranscriptState === undefined && workspaceProvisioning)
      ) {
        parkUnreadableTranscriptSend(chatId, override);
        return;
      }
      // Readable again — re-arm the single automatic retry above.
      transcriptParkedChatRef.current = null;
    }
    // Normal send → snapshot the editor (text + inline pills); the hand-off
    // path (override) supplies the text + pre-built blocks directly.
    const snapshot = override === undefined ? serializeComposerState() : null;
    const localAttachments: ComposerAttachment[] = snapshot?.attachments ?? [];
    const attachmentsToEncode = [
      ...localAttachments,
      ...(extras?.stagedAttachments ?? []),
    ];
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
    const importCount = extras?.imports?.length ?? 0;
    const extraAttachCount =
      (extras?.extraAttachments?.length ?? 0) +
      (extras?.stagedAttachments?.length ?? 0);
    const commandHasAttachments =
      localAttachments.length > 0 || importCount > 0 || extraAttachCount > 0;
    const bareCommand = displayText.match(/^\/([A-Za-z0-9_-]+)$/);
    const inlineCommand = bareInlineSlashCommand(
      session.agentId ?? chatThread?.agentId,
      displayText,
      commandHasAttachments,
    );
    if (inlineCommand && runInlineSlashCommand(inlineCommand)) {
      if (override === undefined) {
        clearComposer();
        if (chatId) dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
      }
      return;
    }
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
      if (recordActivity && chatThread?.folder) {
        recordWorkspaceActivity(chatThread.folder);
      }
      const draft = {
        text: snapshot.displayText,
        attachments: snapshot.attachments,
        json: snapshot.json,
      };
      composerLiveRef.current = draft;
      dispatch({ type: "SET_CHAT_DRAFT", chatId, draft });
      const alreadyQueued =
        useWorkspaceStore.getState().pendingAutoSend[chatId] !== undefined;
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
    if (
      bareCommand &&
      !commandHasAttachments &&
      openTerminalCommand(bareCommand[1])
    ) {
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
            description: `Open Settings → Agents to install ${agentLabel}.`,
          });
        } else {
          toast.error(`${agentLabel}: Sign in required`, {
            description: `Open Settings → Agents to sign in to ${agentLabel}.`,
          });
        }
        return;
      }
    }
    // A validated prompt is a deliberate workspace action. Record it before
    // any admission/attachment await so a slow send cannot jump ahead of work
    // the user performs elsewhere in the meantime. Provisioning sends record
    // above when they are accepted into the exact-chat queue.
    if (recordActivity && chatThread?.folder) {
      recordWorkspaceActivity(chatThread.folder);
    }
    // If the session bounced to reconnecting / failed / auth-required (or never
    // spawned), kick a fresh ensureSession and wait for it before sending. Both
    // error states are recoverable BY EXPLICIT SEND:
    // `auth-required` — the user just fixed their key in Settings →
    // Providers and the error copy says "then send again"; the live session
    // cached the REJECTED key at spawn, so a rebuild re-derives env from the
    // keychain. `failed` (2026-07-10) — e.g. the cursor host crash-loop
    // guard went terminal; the user fixed the environment and sends again,
    // which rebuilds (the host respawns half-open after its hold-off).
    // Either way: if the rebuild fails again we land back here — no retry
    // loop, one attempt per explicit user send.
    //
    // `warming` is deliberately NOT one of them (see sendNeedsSessionRecovery):
    // a spawn is already in flight, so awaiting it here only held the composer
    // hostage — text intact, no bubble, nothing to read as progress — for the
    // whole spawn. The provider parks the send instead (visible immediately in
    // the queued card) and dispatches it when the session lands.
    //
    // 2026-08-17 (§5.0 "a send is always accepted instantly"): only a chat that
    // ENDED BADLY still blocks here. A chat that merely has no session yet
    // (`idle` — first send, engine respawn — or `reconnecting`) starts its
    // session in the BACKGROUND and falls straight through to sendPrompt, which
    // sees the synchronous `warming` flip and parks the message in the queued
    // card. Same queue UX the user already knows, but the composer clears at
    // once and no send ever watches a spinner, whatever admission costs.
    const recoveryMode = sendSessionRecoveryMode(session.status);
    if (recoveryMode === "park") {
      const targetAgentId = session.agentId ?? chatThread?.agentId;
      if (!targetAgentId) return;
      // Deliberately NOT awaited. ensureSession publishes `warming` before its
      // first await, so the sendPrompt below already sees a warming chat.
      // Failures are published on the slot (and release the parked queue), so
      // there is nothing to catch here that the chat does not already show.
      void session
        .startSession(targetAgentId, {
          env: chatThread
            ? envForChat(chatThread, session.initialize)
            : undefined,
        })
        .catch(() => {
          /* surfaces via session.error / the queued-card release */
        });
    } else if (recoveryMode === "await") {
      const targetAgentId = session.agentId ?? chatThread?.agentId;
      if (!targetAgentId) return;
      setSendPreparing(true);
      try {
        // No `force` needed: ensureSession already counts auth-required as
        // "not healthy" and rebuilds (keeping its concurrent-send de-dup);
        // it only early-returns for healthy ready/streaming sessions. cwd
        // resolution rides ensureSession's resolveSpawnCwd (slot + chat
        // store fallback).
        //
        // The chat's composer env MUST ride along. Without it the rebuilt
        // session is stamped with an empty applied-env key, so sendPrompt's
        // settings-drift reconcile immediately force-respawns it AGAIN — two
        // cold spawns for one send (and on Cursor, two host boots) before the
        // prompt goes anywhere. It also runs the provider's default model for
        // the window in between, contradicting the pill.
        await session.startSession(targetAgentId, {
          env: chatThread
            ? envForChat(chatThread, session.initialize)
            : undefined,
        });
      } catch {
        return;
      } finally {
        setSendPreparing(false);
      }
    }
    // Serialize each summary import into a <from_previous_chat>
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
      bubbleAttachmentById: localBubbleAttachmentById,
      skipped: skippedAttachments,
    } = await encodeComposerAttachments(attachmentsToEncode);
    // Anything the encoder excluded is about to be invisible: the sent bubble
    // renders every staged segment regardless, so a dropped attachment looks
    // exactly like one that arrived. Say so. This is the general guard behind
    // several individually-narrow holes — a verdict stamped under one model
    // and sent under another, a body the edit path can't reconstruct, a disk
    // write that failed — all of which used to end in the agent quietly
    // getting nothing.
    reportSkippedAttachments(skippedAttachments, toast.warning);
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
        ? toMessageSegments(
            snapshot.segments,
            localAttachments,
            localBubbleAttachmentById,
          )
        : extras?.bubbleSegments;
    if (override === undefined) {
      clearComposer();
    }
    // Drop any stashed draft for this chat —
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

  /** Single-flight entry point for every send (button, Enter keymap, "Continue",
   *  the EmptyComposer hand-off, the provisioning auto-send).
   *
   *  runSend clears the composer only at its END, and the stretches before that
   *  can await real I/O: a cold transcript read, and — the one that made this
   *  visible — a session rebuild, which on a cold provider host runs for tens of
   *  seconds. A composer sitting visibly untouched is exactly when someone
   *  presses Enter again, and every re-entry snapshotted the same text and sent
   *  it again: the reported "nothing happens, so I keep pressing Enter, and then
   *  the same message shows up several times, all queued".
   *
   *  Dropping a re-entry is safe by construction — the composer has not been
   *  touched, so it is the very message the in-flight call is already sending. */
  const handleSend = async (
    override?: string,
    extras?: Parameters<typeof runSend>[1],
    recordActivity = true,
  ): Promise<void> => {
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      await runSend(override, extras, recordActivity);
    } finally {
      sendInFlightRef.current = false;
    }
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
      const { blocks, bubbleAttachments, bubbleAttachmentById, skipped } =
        await encodeComposerAttachments(localAttachments);
      // Same reason as the live send: the queued row keeps rendering every
      // segment, so an excluded attachment is indistinguishable from one that
      // made it. The queued message has not been dispatched yet, which makes
      // this the LAST moment the user can act on it.
      reportSkippedAttachments(skipped, toast.warning);
      const segments = toMessageSegments(
        s?.segments ?? [],
        localAttachments,
        bubbleAttachmentById,
      );
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
    // The row's staged files deliberately STAY in the context graph — the
    // graph is append-only (context-graph-staging.ts): deleting the message
    // withdraws the prompt, not the workspace's record of its files. Only
    // the user deleting them on disk removes them.
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
  submitRef.current = (recordActivity = true) => {
    if (editingQueuedRef.current) {
      void saveQueuedEdit();
      return;
    }
    const selected = queueSelectedRef.current;
    if (selected) {
      startQueuedEdit(selected);
      return;
    }
    void handleSend(undefined, undefined, recordActivity);
  };

  // (Previous local queue flush effect removed — EmptyComposer now
  // sends via a speculative session that is ready at submit time,
  // so there's nothing to flush locally.)

  // InlineEdit, the feedback pill, and the empty-state
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
    // A send is already being prepared, so handleSend would drop this one — and
    // the consume below would still retire it, losing the submission. Wait: this
    // effect re-runs when `sendPreparing` clears.
    if (sendInFlightRef.current) return;
    // Thread the EmptyComposer's summary imports + image
    // attachments + bubble metadata through to the first send. Without
    // this, the user's imported context chips were dropped on the way
    // to the new chat AND the user-bubble's chip row was missing on
    // the seeded message.
    handleSend(pendingSub.text, {
      imports: pendingSub.imports,
      stagedAttachments: pendingSub.composerAttachments as
        | ComposerAttachment[]
        | undefined,
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
    // Re-arm once a send that was being prepared has finished, so a submission
    // that arrived during that window still goes out.
    sendPreparing,
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
  //
  // It is also the park's RELEASE site (queuedFirstTurnAction): a spawn that
  // ends terminally, or a wait that outlasts the bound, hands the message back
  // and says so instead of holding it silently — the reported "I sent it
  // before the workspace was ready and it just sat there".
  useEffect(() => {
    if (!chatId || pendingAutoSendAt === null) return;
    const decide = (): "wait" | "send" | "release" =>
      queuedFirstTurnAction({
        status: session.status,
        provisioning: workspaceProvisioning,
        hasPermissionGate: !!session.pendingPermission,
        composerEmpty,
        // Don't retire the intent into a send that handleSend would drop
        // because another one is mid-preparation; this effect re-runs when
        // that clears.
        sendInFlight: sendInFlightRef.current,
        armedForMs: Date.now() - pendingAutoSendAt,
      });
    const apply = (action: "wait" | "send" | "release"): void => {
      if (action === "wait") return;
      // Consume first so React Strict effects and unrelated store
      // notifications cannot dispatch the same first turn twice while
      // handleSend is awaiting.
      dispatch({ type: "CONSUME_AUTO_SEND", chatId });
      if (action === "release") {
        toast.warning("A queued message wasn’t sent", {
          description:
            "This chat couldn’t start, so your message is still in the composer — send it again once the chat is ready.",
          id: `workspace-message-queued-released-${chatId}`,
        });
        return;
      }
      // The original click was already recorded when this exact send was
      // queued during provisioning. Its later automatic drain is not a new
      // action.
      submitRef.current(false);
    };
    const action = decide();
    if (action !== "wait") {
      apply(action);
      return;
    }
    // A session that never settles produces no further status transition, so
    // re-running on state alone can't notice it. Re-check once the bound
    // elapses — the only way the wait becomes reportable at all.
    const remaining =
      QUEUED_FIRST_TURN_MAX_WAIT_MS - (Date.now() - pendingAutoSendAt) + 250;
    const timer = window.setTimeout(
      () => {
        // Re-read live state: this fires minutes later, and only the store
        // knows whether the park is still armed by then.
        if (
          useWorkspaceStore.getState().pendingAutoSend[chatId] !==
          pendingAutoSendAt
        ) {
          return;
        }
        apply(decide());
      },
      Math.max(remaining, 0),
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pendingAutoSendAt,
    workspaceProvisioning,
    session.status,
    session.pendingPermission,
    chatId,
    composerEmpty,
    sendPreparing,
  ]);

  // ⌥+click in the browser-tab element picker
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

  const handleAttachFiles = useCallback(
    () => fileInputRef.current?.click(),
    [],
  );
  const openTranscriptPicker = useCallback(
    () => setTranscriptPickerOpen(true),
    [],
  );
  const openWorkspacePicker = useCallback(
    () => setWorkspacePickerOpen(true),
    [],
  );
  // The editor owns the file-read + validation pipeline (insertFiles); this
  // wrapper just resets the file input so the same file can be re-picked.
  const handleFileInput = async (files: FileList | null) => {
    await addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // The inline agent name + status
  // subtitle ("Claude · streaming…") used to live in the chat
  // header. The Conversation pane tab strip now carries chat identity per session,
  // so the subtitle was redundant and made the header noisy. Streaming /
  // auth-required / stop-reason signals are already surfaced through the
  // composer state chip + toast layer.

  return (
    <div className="zeros-agent-surface text-fg1 [container-type:inline-size] flex h-full min-h-0 flex-col bg-transparent text-sm [container-name:agent-chat]">
      {/* The Zeros Foundation-aligned chat
          header is suppressed when the caller passes any `headerActions`
          (truthy or an empty fragment). The Conversation pane path always passes
          `<></>` so the entire header — title, agent chip, project
          context chip — collapses, since the Conversation pane top bar +
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

      {/* Agent errors surface only through the toast surface (with agent name).
          Reset session lives in the settings/menu surface so an inline error
          banner does not interrupt transcript flow. The useEffect higher up fires
          toast.error("Claude Code: …") on every status transition. */}

      {/* SummaryHandoffPill was removed with in-chat agent switching.
          Zeros-native forks stage their concise transcript directly in the
          destination composer; sourceChatId remains product-owned lineage and
          does not need its own banner. */}

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
          pins flush to conversation pane's right border at every column width),
          inner ConversationContent is overflow-visible and centered.
          2026-06-18 (final): max-w-[1152px] is the SINGLE source of the
          chat's responsive width — the roomy envelope the user wants for
          tool cards / diffs / wide tables. It is a MAX, not a fixed
          width: the band only reaches 1152 when conversation pane is that wide; when
          conversation pane is narrower the band shrinks to the window (mx-auto adds
          NO gutters below the cap). This 1152 band is the OUTER
          envelope (scroll container + content column); the answer lane
          inside it is separately capped at 768px (turn-event-list.tsx,
          `max-w-[768px]`) so prose reads at a comfortable measure rather
          than stretching the full band. A same-day experiment instead
          capped the answer lane at 80% — reverted, because a proportional
          cap reserved a fixed ~20% right gutter at EVERY width, so the
          column never "fit in" when shrunk. The side
          gap must appear ONLY once content hits the 1152 cap, never
          before. To retune: THIS value sets the outer band (mirror it on
          the composer + permission caps below); the inner reading measure
          is the 768 cap in turn-event-list.tsx.
          The 1152px measure balances reading width with the outer column,
          which drag-resizes
          up to min(2400px, 70vw) via ConversationPane; this band centres
          inside that. Markdown tables fill the band (display:table +
          width:100% in styles/global/runtime-content.css) and wrap wider tables in a
          horizontal-scroll div (markdown.ts > wrapTablesInScroller).
          Thin scrollbar styling in styles/global/scrollbars.css. */}
      {/* Relative shell around the scroll container so the top-mask (below)
          can sit OUTSIDE the scroller and stay pinned to the viewport top
          regardless of scroll position. Grows like the scroller did. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Conversation
          ref={setScrollContainer}
          data-agent-diff-collision-boundary=""
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
            // px-7 (28px): one flat side gutter at every
            // column width — replaced the px-3/@520:px-5/@680:px-8 ramp. Keeps
            // the transcript clear of the checkpoint rail's ticks (left-1 +
            // 20px hit zone = 28px) at all widths. Mirror any change on the
            // composer column below (lock-step alignment).
            className="zeros-agent-messages mx-auto flex w-full max-w-[1152px] min-w-0 flex-none flex-col gap-5 overflow-visible px-7 pt-3 pb-8"
          >
            {/* Older history auto-pages in via the nearTop effect above, with
              no visible affordance: scrolling back should show everything. */}
            {/* Reconnecting state is surfaced by the "Reconnecting…" card
              directly above the composer (see the composer banner stack) —
              keep the message area empty so the user can still see the
              transcript area. */}
            {showTranscriptLoading && (
              <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
                <ZerosSpinner
                  size={14}
                  label="Loading conversation"
                  className="shrink-0"
                />
                <span aria-hidden="true">Loading conversation…</span>
              </div>
            )}
            {/* Empty transcript → state what this workspace IS (created /
              branched from / setup script), not what the session is doing.
              2026-07-29: replaced "Session ready. Ask the agent anything."
              Deliberately NOT gated on session.status: the old line was, so
              every respawn flipped it warming→ready and the text blinked out
              and back (see the respawn fix in conversation/chat-view.tsx). This
              block describes the workspace, which a session rebuild doesn't
              change, so it stays put. Still hidden on `error` — a failed
              session shows its own failure UI and provenance would read as
              reassurance the user shouldn't take. */}
            {session.transcriptState === "resident" &&
              session.messages.length === 0 &&
              !session.error && (
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
              // A steer starts a new VISUAL prompt segment but remains inside
              // the same provider turn. Only the visual tail owns sticky/tail
              // UI, while every segment sharing that provider turn stays live
              // so its streaming tool group does not collapse mid-run.
              const isVisualTail = i === turns.length - 1;
              const isActiveProviderSegment = isTailProviderTurnSegment(
                turns,
                i,
              );
              const ownsProviderFooter = isProviderTurnTail(turns, i);
              // One answer for the shimmer AND the footer (see tailTurnInFlight):
              // they are two halves of the same claim, and computing them apart
              // is what let a reopened chat show the working shimmer while
              // hiding this turn's own STOPPED BY USER pill.
              const turnIsPendingLocal =
                !!turn.userPrompt && pendingLocalTurnId === turn.userPrompt.id;
              const turnInFlight = tailTurnInFlight({
                sessionStreaming: isStreaming,
                pendingLocalTurn: turnIsPendingLocal,
                hasEvents: turn.events.length > 0,
              });
              return (
                <React.Fragment key={turnKey(turn)}>
                  <TurnContainer turn={turn} isActive={isVisualTail}>
                    {/* Still-pending queued sends do NOT render here — they
                        live in the QueuedMessagesCard docked above the
                        composer (2026-07-06 queue redesign), so every
                        userPrompt reaching this point is a dispatched turn. */}
                    {turn.userPrompt && (
                      // Every turn's user prompt is sticky: as the
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
                        // Keep-alive deck (conversation/chat-deck.tsx) keeps hidden
                        // chats mounted, so the prompt's "More"-expanded state
                        // needs the surfacing signal to collapse on tab switch.
                        surfaceActive={surfaceActive}
                        editingMessageId={editingMessageId}
                        onRequestEdit={setEditingMessageId}
                        originalText={turn.userPrompt.text}
                        originalAttachments={turn.userPrompt.attachments}
                        originalSegments={turn.userPrompt.segments}
                        autoAction={turn.userPrompt.autoAction}
                        // Auto-sent messages are copy-only because their short
                        // label cannot round-trip. Mid-turn steers are also
                        // copy-only: their reset boundary is the opening
                        // provider prompt, not the steer message id.
                        onEdit={
                          turn.userPrompt.autoAction || turn.isSteer
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
                        <div ref={isVisualTail ? setActivePromptEl : null}>
                          {/* The user prompt renders as a right-aligned,
                        fit-to-content bubble.
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
                    while THIS renderer's own send for it is still pending
                    session (re)creation (Cursor's newSession takes seconds;
                    engine-respawn rebuilds too), which would otherwise flash
                    the just-sent turn as SETTLED ("0s ⧉ …", no shimmer) until
                    the first event arrived. Keyed on the pending TURN, never on
                    session status: reopening a chat warms the session too, and
                    that is how a stopped turn used to come back to life. */}
                    <TurnEventList
                      events={turn.events}
                      isActive={isActiveProviderSegment}
                      isStreaming={turnInFlight}
                      showActivity={isVisualTail}
                      activityEvents={turn.providerEvents}
                      activityStartedAt={
                        isVisualTail
                          ? (session.activeTurnStartedAt ??
                            turn.recordedStartedAt)
                          : turn.recordedStartedAt
                      }
                      workflow={activeWorkflow}
                      onStopWorkflow={session.stopBackgroundTask}
                      ctx={messageCtx}
                      footer={
                        turn.userPrompt && chatId && ownsProviderFooter ? (
                          <TurnFooter
                            chatId={chatId}
                            turnId={turn.recordedTurnId ?? turn.userPrompt.id}
                            events={turn.providerEvents}
                            startedAt={turn.recordedStartedAt}
                            live={isVisualTail && turnInFlight}
                            fallbackStopReason={
                              isVisualTail && session.status !== "streaming"
                                ? session.lastStopReason
                                : null
                            }
                            fallbackStatusLabel={
                              isVisualTail && session.status !== "streaming"
                                ? footerLabelForFailure(session.failure)
                                : null
                            }
                            // "An auto-rebuild is re-running THIS turn" — which
                            // only happens while this renderer's own send owns
                            // it (rebuildAndRetry / the resume-and-retry hop).
                            // It used to read session status, so merely
                            // REOPENING a chat suppressed a genuinely failed
                            // turn's AGENT STOPPED pill until the resume landed.
                            retrying={isVisualTail && turnIsPendingLocal}
                            isLastTurn={isVisualTail}
                            // One-click resume after a token-cap /
                            // budget stop: functionally the user typing
                            // "Continue" and hitting send (same session, full
                            // context). The stop pill / budget card stays on
                            // this turn as history.
                            onContinue={() => void handleSend("Continue")}
                            onFork={() =>
                              forkToNewTab(
                                turn.userPrompt!.id,
                                turn.userPrompt!.text,
                              )
                            }
                            onForkIntent={() =>
                              warmForkToNewTab(
                                turn.userPrompt!.id,
                                turn.userPrompt!.text,
                              )
                            }
                            // Auth-required + Claude/Codex: the SIGN IN
                            // REQUIRED pill becomes a live Sign-in button
                            // (background CLI login → browser).
                            signInPhase={
                              isVisualTail &&
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
        {/* Checkpoint rail — a left-edge minimap with one tick per user
          message. The bright tick tracks the
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

      {/* The ActivityHUD pill is gone. The shimmer now
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
          with the centered conversation column. Like the messages band it's
          a MAX: on a 2000px conversation pane the
          composer sits in the 1152px centred measure; when conversation pane is
          narrower it shrinks to the window. */}
        {/* gap-0.5 (2px): above-composer cards (Reconnecting, permission, plan
          review, embedded terminal) sit nearly flush to the composer.
          The message list is a separate container, so its spacing is unaffected. */}
        {/* px-7 (28px, 2026-07-16): kept in lock-step with the transcript
          column's flat 28px gutter above so the composer's edges align with
          the message bubbles at every width. */}
        <div className="mx-auto box-border flex w-full max-w-[1152px] min-w-0 shrink-0 flex-col gap-0.5 border-t-0 bg-transparent px-7 pt-0 pb-4">
          {/* Inline composer errors use the shared toast surface: the
            "Error: <label>" surfaces as a toast.error from a useEffect
            higher up. The composer remains enabled when isErrorState is set:
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
          <GoalCard
            goal={session.goal}
            editing={goalEditorOpen}
            onEditingChange={setGoalEditorOpen}
            onSave={saveGoal}
            onStatus={setGoalStatus}
            onDelete={deleteGoal}
          />
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
          {permissionCardActive && permissionRequest && (
            <PermissionCard
              request={permissionRequest}
              onRespond={respondToVisiblePermission}
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
          {planReview && !browserPermissionCardActive && (
            <PlanReviewCard
              planText={readPlan(planReview.request.toolCall.rawInput)}
              onApprove={approvePlan}
              onReject={denyPlanReview}
            />
          )}
          {/* Provider-native work must always retain a visible Stop surface.
            Quiet Claude Ultracode continuation is a separate concern: it can
            keep the turn live, but never owns task-card visibility. */}
          {showBackgroundTasksCard ? (
            <BackgroundTasksCard
              tasks={session.backgroundTasks}
              onStop={session.stopBackgroundTask}
            />
          ) : null}
          {session.waitingForBackgroundTasks ? (
            <BackgroundTasksWaitingLine
              tasks={session.backgroundTasks}
              startedAt={
                session.backgroundTasksWaitingSince ??
                session.backgroundTasks[0]?.startedAt ??
                Date.now()
              }
              active={surfaceActive}
            />
          ) : null}
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
            canonical ArrowUp icon. The streaming-state Stop button stays a
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
              so the popover matches the composer width,
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
                  <PromptInputToolbar
                    data-permission-feedback-boundary=""
                    className="min-w-0 flex-nowrap gap-1.5 pt-1 pr-0 pb-1 pl-0"
                  >
                    {/* gap-0.5: exactly 2px between the + / model / fast /
                    effort / permission pills. */}
                    <PromptInputTools className="min-w-0 flex-nowrap gap-0.5">
                      {/* The locally stateful menu opens without re-rendering
                      AgentChat. Modal/file actions remain deferred past Radix
                      focus restoration inside the island. */}
                      <ComposerAttachmentMenu
                        concealed={composerConcealed}
                        onAttachFiles={handleAttachFiles}
                        onAttachTranscript={openTranscriptPicker}
                        onLinkWorkspace={openWorkspacePicker}
                        onIntent={warmTranscriptPicker}
                      />
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={COMPOSER_FILE_ACCEPT}
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => void handleFileInput(e.target.files)}
                      />
                      {/* Configured model · Permissions — the shared pill block
                      (also used in the edit composer). Effort/Fast are part of
                      the model label and edited in its popover. */}
                      {editToolbarPills}
                      <BoundaryStatusPill status={session.boundary} />
                      <BoundaryPortsPill
                        snapshot={session.boundaryPorts}
                        onOpenPort={openBoundaryPreview}
                      />
                    </PromptInputTools>
                    {/* Right cluster: [context ring] [send] (+ save tick while
                    editing a queued message). Grouped so the toolbar's
                    justify-between keeps tools left / actions right. */}
                    <div
                      data-composer-toolbar-actions=""
                      className="flex shrink-0 items-center gap-1.5"
                    >
                      {/* Context gauge — the ring + breakdown popover.
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
                      {/* Unified send/stop: PromptInputSubmit renders
                    Send (ArrowUp) when ready, Square (outlined, not
                    filled) when streaming. The form's onSubmit handler
                    above already calls session.cancel() when streaming, so
                    clicking the same button while in flight halts the
                    agent — no separate destructive button. Title swaps so
                    the affordance still reads. */}
                      <Tooltip
                        label={
                          composerStreaming
                            ? "Stop agent"
                            : sendPreparing
                              ? "Starting the agent…"
                              : editingQueuedId
                                ? "Save message"
                                : "Send"
                        }
                        shortcut={
                          composerStreaming || sendPreparing ? undefined : "↵"
                        }
                      >
                        <PromptInputSubmit
                          // `submitted` = this send is parked on a cold
                          // transcript read or a session (re)build with the
                          // text still in the composer. Without it the button
                          // looked idle-but-dead for the whole spawn, which is
                          // what made people press Enter again and again.
                          status={
                            isErrorState
                              ? "error"
                              : composerStreaming
                                ? "streaming"
                                : sendPreparing
                                  ? "submitted"
                                  : "ready"
                          }
                          disabled={
                            composerStreaming
                              ? false
                              : sendPreparing
                                ? true
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
          {/* The bottom pill row (AgentPill + folder label + ContextPill) is
            removed. Agent switching
            now lives in the "+" menu's Chat submenu; folder context is
            shown in the Conversation pane top bar; ContextPill / token-usage
            UI is intentionally absent here. The container below keeps the same height so the
            chrome doesn't jump when toggling between AgentChat and
            EmptyComposer. */}
        </div>
      </div>
      {/* Full-screen image preview
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
