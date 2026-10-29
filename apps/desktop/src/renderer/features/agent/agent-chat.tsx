import { LocalLinksProvider } from "./local-links/provider";
import { AGENT_NOTICE_ACTION, AgentNotice } from "./agent-notice";
import { getFollowUpBehavior, type FollowUpBehavior } from "../settings/follow-up-behavior";
import { notifyAgentSendFailure } from "./agent-send-failure-toast";
// AgentChat keeps no message state of its own: everything it renders comes
// from useAgentSession.

import { beginChatScrollNavigation, CHAT_SCROLL_NAVIGATION_EVENT, scrollChatToBoundary } from "./chat-scroll-navigation";
import { transcriptParentId } from "./transcript-parent";
import { useTranscriptHistoryStatus } from "./use-transcript-history-status";
import { presentLeadingPrompt } from "./transcript-leading-prompt";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOpenChatPreviewInWorkbench } from "@/renderer/shell/workbench/use-open-browser";
import { workspacePreviewAvailable } from "../../platform/cloud-workspace-access";
import { useOpenChatFileInWorkbench, warmChatFileInWorkbench } from "@/renderer/shell/workbench/use-open-file";
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
import {
  canApplyHistoryPage,
  captureHistoryPageScrollPosition,
  prependHistoryPage,
  scheduleHistoryPageScrollRestore,
} from "./transcript-paging";
import { useOpenPrUrlInReviewTab } from "@/renderer/shell/pr/use-open-review-tab";
import { warmWorkspaceFiles } from "@/renderer/shell/workspace-files-cache";
import { nativeInvoke, useNativeRuntime } from "@/renderer/platform/runtime";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { captureDeferredFocus } from "@/renderer/shared/ui/deferred-focus";
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
import { retryAgentTurn, warmRetryTranscript } from "./retry-agent-turn";
import { cloudPromptTurnActivity } from "./cloud-prompt-presentation";
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
import { cloudQueuedPrompt } from "./cloud-queued-prompt";
import { agentActivity, chatAgentActivity } from "./agent-activity";
import { EmbeddedTerminalCommand } from "./embedded-terminal-command";
import { AddedDirectories } from "./added-directories";
import { PermissionCard } from "./permission-card";
import { useComposerCardFocus } from "./use-composer-card-focus";
import {
  browserConfirmationShouldTakeComposer,
  useBrowserConfirmation,
} from "../browser/browser-confirmation-store";
import { useAgentControlConfirmation } from "../agent-control/agent-control-confirmation-store";
import {
  nativeConfirmationFailureText,
  nativeConfirmationToPermissionRequest,
  nextNativeConfirmation,
  respondToNativeConfirmation,
} from "../agent-control/native-confirmation";
import { PlanReviewCard } from "./plan-review-card";
import { GoalCard } from "./goal-card";
import { QuestionCard } from "./question-card";
import { readPlan, isPlanReviewRequest } from "./renderers/plan-body";
import { WorkspaceDirectoryPicker } from "./workspace-directory-picker";
import { useProjects } from "../../state/use-projects";
import { turnGet } from "../../platform/turns";
import { turnRowCache, turnRowKey } from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import { findProjectForFolder } from "../../state/workspace-resolution";
import { Bot, Square, ArrowLeft, Upload, Check } from "lucide-react";
import {
  encodeAttachments,
  reportSkippedAttachments,
} from "./encode-attachments";
import type { ComposerAttachment } from "./composer-attachments";
import { isSubmittedComposerDocument } from "./composer-submission";
import { useCloudWorkspaceAccountAccess } from "../team/cloud-workspace-account-access";
import {
  COMPOSER_FILE_ACCEPT,
  COMPOSER_SURFACE_RADIUS,
} from "./composer-shell";
import { ComposerAttachmentMenu } from "./composer-attachment-menu";
import { ComposerDesignTag } from "./composer-design-tag";
import { ComposerDesignFrame, useComposerDesignFrame } from "./composer-design-frame";
import { prepareDesignFrameAttachments } from "./design-frame-attachment";
import { hasDesignFrameAttachmentSelection } from "./design-frame-selection";
import { setComposerMode } from "./composer-mode";
import { permissionModesAvailable, turnCheckpointsAvailable } from "./chat-feature-availability";
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
import { registerLiveChatFileStager } from "./composer-file-attachment-delivery";
import { buildForkTranscriptAttachment, createForkedChat } from "./fork-chat";
import { resolveComposerPlaceholder } from "./composer-placeholder";
import {
  composerCardDock,
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
  isRecoverable,
  isTransportShaped,
} from "../../platform/bridge/failure";
import type {
  AgentMessage,
  AgentSessionControls,
  AgentSessionState,
  AgentTextMessage,
  MessageContentSegment,
} from "./use-agent-session";
import type { RendererContext } from "./renderers";
import { computeEditBaselines } from "./renderers/tool-edit";
import { Button, cn } from "../../shared/ui";
import {
  ModelPill,
  PermissionToggle,
  PlanModeFrame,
  ComposerConcealedContext,
} from "./composer-pills";
import { ContextGauge } from "./context-gauge";
import { ComposerTools } from "./composer-tools";
import {
  sessionToolsResource,
  warmPreparedSessionTools,
} from "./session-tools-cache";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import { BoundaryPortsPill } from "./boundary-ports";
import { useCloudWorkspaceCanEdit } from "../../state/use-cloud-workspace-can-edit";
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
  composerShowsStopControl,
  QUEUED_FIRST_TURN_MAX_WAIT_MS,
  queuedFirstTurnAction,
  sendPastPermission,
  sendSessionRecoveryMode,
  unreadableTranscriptSendAction,
} from "./session-reload-lifecycle";
import { startChatTitleRequest, settledFirstPromptForTitle } from "./chat-title";
import { permissionModeIdForDisplay } from "./permission-mode-display";
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
} from "./agents-cache";
import { invalidateCloudAgentRegistry, useWorkspaceAgents } from "./workspace-agent-registry";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { canSwitchPristineChat } from "./pristine-chat";
import { cloudCatalogGeneration } from "../../state/cloud-workspace-catalog";
import { isRunnableAgent } from "./agent-runnable";
import { requestProviderSettings, requestUserSettingsSection } from "../settings/settings-navigation";
import { isSubscriptionProvider } from "../settings/subscription-connection";
import { latestAuthenticationRecoveryTurn } from "./auth-prompt-recovery";
import { useAgentSessions } from "./sessions-hooks";
import { useStickyBottom } from "./use-sticky-bottom";
import { navigationShortcutBlocked, resolveNavigationShortcut, type MessageNavigation } from "../../shared/lib/navigation-shortcuts";
import { hasShortcutPriorityClaim } from "./shortcut-priority";
import {
  groupMessagesIntoTurns,
  isProviderTurnTail,
  turnKey,
} from "./turn-container";
import { useLocalLiveTextSource } from "./local-live-text";
import { ActivityScope } from "@/renderer/shared/ui/loading/activity-scope";
import {
  TranscriptTurn,
  type TranscriptTurnActions,
  type TranscriptTurnShared,
  type TranscriptTurnTail,
} from "./transcript-turn";
import { shareMap, shareMessageBuckets, shareSet } from "./transcript-stability";
import { useLatestCallback } from "@/renderer/shared/lib/use-latest-callback";
import { tailTurnInFlight } from "./tail-indicators";
import { cloudPresentationRunning } from "./cloud-turn-presentation";
import { pickActiveWorkflow } from "./workflow-activity";
import { stabilizeTurns } from "./stable-turns";
import { turnFailureForCard } from "./turn-failure";
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
import {
  AGENT_REGISTRY_VERIFICATION_DELAY_MS,
  canVerifyAgentRegistryInBackground,
} from "./agent-registry-verification";
import { collectPendingQuestionToolCallIds } from "./pending-question-tools";
import {
  windowOlderMessages as ipcWindowOlderMessages,
  truncateMessagesFrom as ipcTruncateMessagesFrom,
} from "./agent-history-client";

/** How long an empty chat waits for its folder's transcript list before it
 * shows the workspace rows instead of nothing. */
const TRANSCRIPT_LIST_GRACE_MS = 400;

// Plan mode is Claude's "plan" or Codex's "read-only" ("Plan only; no edits or
// commands").
const PLAN_MODE_RX = /plan|read.?only/i;

/** Read-only transcripts never pend on a question. Shared and never mutated. */
const NO_PENDING_QUESTION_TOOL_CALL_IDS = new Set<string>();

interface AgentChatProps {
  /** The session hook keeps append-only Local prose in its live message. */
  liveTextUpdates?: boolean;
  /** Saved workspace history shares the transcript, with all writing disabled. */
  readOnly?: boolean;
  composerReplacement?: React.ReactNode;
  session: AgentSessionState &
    AgentSessionControls & { hydrateChat(): Promise<void> };
  onBack: () => void;
  /** Optional right-aligned header slot; when provided it replaces the default back button. */
  headerActions?: React.ReactNode;
  /** The backing ChatThread enables the composer's persisted model, effort and
   *  permission pills. Without it the composer is minimal. */
  chatId?: string;
  /** False for a retained chat whose complete DOM is currently off-screen. */
  surfaceActive?: boolean;
  /** The chat's exact prepared cwd has not been published by workspace.create.
   * The composer remains interactive, but Send becomes an exact-chat intent
   * that drains only after provisioning and session readiness. */
  workspaceProvisioning?: boolean;
}

export function AgentChat(props: AgentChatProps) {
  const chat = useChatById(props.chatId);
  const cwd = chat?.folder ?? props.session.cwd;
  return <LocalLinksProvider cwd={cwd} active={props.surfaceActive ?? true}>
    <ActivityScope.Provider value={cwd && !isCloudWorkspace(cwd) ? props.surfaceActive ?? true : undefined}>
      <AgentChatBody {...props} />
    </ActivityScope.Provider>
  </LocalLinksProvider>;
}

function AgentChatBody({
  liveTextUpdates = false,
  readOnly = false,
  composerReplacement,
  session,
  onBack,
  headerActions,
  chatId,
  surfaceActive = true,
  workspaceProvisioning = false,
}: AgentChatProps) {
  const interactive = surfaceActive && !readOnly;
  // Hoisted so the draft seeding below can read state on first render.
  const dispatch = useWorkspaceDispatch();
  const activeChatId = useActiveChatId();
  const browserPickerSelection = useBrowserPickerSelection();
  const pendingChatSubmission = usePendingChatSubmission();
  const pendingAutoSend = usePendingAutoSend(chatId);
  // The stamp, not just the flag: the park's release site bounds its own wait
  // (see queuedFirstTurnAction).
  const pendingAutoSendAt = usePendingAutoSendAt(chatId);
  const pendingComposerAppend = usePendingComposerAppend();
  const chatThread = useChatById(chatId);
  // A cached window (cloud restore cache or the Local boot cache) paints while
  // the authoritative read is pending. It is read-only presentation until then.
  const provisionalTranscript = session.transcriptState === "loading" && !!session.transcriptPresentation;
  const transcriptReadOnly = readOnly || provisionalTranscript;
  const liveTextSource = useLocalLiveTextSource(liveTextUpdates && !transcriptReadOnly, chatId,
    session.cwd, session.executionId ?? session.sessionId);
  // A Local chat known to be empty shows its empty state while the engine
  // confirms it (e.g. right after a restart), never a blank pane.
  const emptyStateReady = session.transcriptState === "resident" ||
    provisionalTranscript && session.transcriptPresentation?.empty === true && session.messages.length === 0;
  // Cloud agents expose no native goals.
  const goalsAvailable = !isCloudWorkspace(chatThread?.folder);
  const browserConfirmation = useBrowserConfirmation(chatId);
  const agentControlConfirmation = useAgentControlConfirmation(chatId);
  const workflows = session.workflows;
  const activeWorkflow = useMemo(
    () => pickActiveWorkflow(workflows),
    [workflows],
  );
  const nativeReady = useNativeRuntime().ready;
  // Seed once per chat so each retained editor starts from its own persisted draft.
  const seededDraft = chatId
    ? useWorkspaceStore.getState().chatComposerDrafts[chatId]
    : undefined;
  // The editor's JSON is the draft's source of truth; seed it once.
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
    designFrame?: import("./design-frame-attachment").DesignFrameAttachmentSelection | null;
  }>({
    text: seededDraft?.text ?? "",
    attachments: seededDraft?.attachments ?? [],
    json: seededDraft?.json ?? null,
    designFrame: seededDraft?.designFrame,
  });
  // Indirections so the once-built editor + early keybind handlers reach the
  // current handlers (which are defined below the editor hook).
  const submitRef = useRef<(recordActivity?: boolean) => void>(() => {});
  const updateLiveDraftRef = useRef<() => void>(() => {});
  const composerFocusRef = useRef<() => void>(() => {});
  const composerCardRef = useRef<HTMLDivElement>(null);
  // activeTurnStartedAt is the last user message's createdAt; turn-scoped
  // chrome compares against it.
  const activeTurnStartedAt = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.kind === "text" && (m as AgentTextMessage).role === "user") {
        return m.createdAt;
      }
    }
    return 0;
  }, [session.messages]);
  // Subagent children render inside their parent's SubagentCard and are hidden
  // from the top level. Edits are never merged; each renders as its own row.
  const { visibleMessages, subagentChildren, editBaselines, queuedMessages } =
    useMemo(() => {
      const shadowed = new Set<string>();
      const subagentChildren = new Map<
        string,
        import("./use-agent-session").AgentMessage[]
      >();
      // Cloud queue acceptance and provider acceptance are different facts.
      // Keep every unaccepted cloud message in the composer queue, including
      // a dispatched command whose provider turn has not started yet.
      const cloud = isCloudWorkspace(session.cwd);
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
        const awaitingAgent = cloud && session.cloudPromptPending && m.id === session.foregroundTurnId;
        if (m.kind === "text" && (awaitingAgent || m.queued &&
            (cloud || m.queuedPresentation !== "active-turn" && m.queuedDelivery !== "sending"))) {
          // The original message and payload stay owned by the in-flight RPC.
          // This projection cannot edit, remove or resend an ambiguous command.
          queuedMessages.push(awaitingAgent ? { ...m, queued: true, queuedDelivery: "sending", queuedEditable: false } : m);
          shadowed.add(m.id);
          continue;
        }
        const parentId = transcriptParentId(m);
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
    }, [session.messages, session.cwd, session.cloudPromptPending, session.foregroundTurnId]);
  const livePendingLocalTurnId = usePendingLocalTurnId(chatId);
  const pendingLocalTurnId = readOnly || isCloudWorkspace(session.cwd) && session.cloudPromptPending ? null : livePendingLocalTurnId;
  const activity = readOnly ? null : agentActivity(session, pendingLocalTurnId);
  const backgroundContinuationActive = agentFamily(session.agentId) === "claude" && activity !== null && session.status !== "streaming";
  const waitingForBackgroundTasks = activity === "waiting";
  const untitled = chatThread?.title === "Untitled" || chatThread?.title === "New chat";
  // Recomputed per streamed chunk, but the request below re-arms only when
  // the chosen prompt itself changes.
  const titleCandidate = useMemo(
    () => (untitled ? settledFirstPromptForTitle({ status: session.status, messages: session.messages }) : null),
    [untitled, session.status, session.messages],
  );
  const titleMessageId = titleCandidate?.messageId ?? null;
  const titlePrompt = titleCandidate?.prompt ?? null;
  const seededTitle = chatThread?.title ?? null;
  useEffect(() => {
    if (
      readOnly ||
      !surfaceActive ||
      !chatId ||
      !seededTitle ||
      backgroundContinuationActive ||
      !titleMessageId ||
      !titlePrompt
    )
      return;
    return startChatTitleRequest({
      chatId,
      messageId: titleMessageId,
      prompt: titlePrompt,
      expectedTitle: seededTitle,
      dispatch,
    });
  }, [
    readOnly,
    backgroundContinuationActive,
    surfaceActive,
    chatId,
    seededTitle,
    dispatch,
    titleMessageId,
    titlePrompt,
  ]);
  const isStreaming =
    !readOnly &&
    !(isCloudWorkspace(session.cwd) && session.cloudPromptPending) &&
    (agentFamily(session.agentId) === "claude"
      ? activity === "running"
      : chatAgentActivity(session) === "running");
  const respondToQuestion = useCallback(
    (text: string) => {
      if (transcriptReadOnly) return;
      if (chatThread?.folder) recordWorkspaceActivity(chatThread.folder);
      session.sendPrompt(text, text).catch(() => {
        /* error surfaces via session.error */
      });
    },
    [chatThread?.folder, session, transcriptReadOnly],
  );
  // The global PermissionBar and each tool card's inline Allow/Deny share this call.
  const respondToPermission = useCallback(
    (
      response: import("../../platform/bridge/agent-events").RequestPermissionResponse,
    ) => {
      if (transcriptReadOnly) return;
      if (chatThread?.folder) recordWorkspaceActivity(chatThread.folder);
      session.respondToPermission(response);
    },
    [chatThread?.folder, session, transcriptReadOnly],
  );
  // Bound to this chat so inline permission controls need not know which chat
  // they are in.
  const policyChatId = chatId;
  const recordPolicy = useCallback(
    (rule: import("./policies").PolicyRule) => {
      if (transcriptReadOnly || !policyChatId) return;
      useSessionsStore.getState().addPolicy(policyChatId, rule);
    },
    [policyChatId, transcriptReadOnly],
  );
  const setModeForCtx = useMemo(
    () =>
      !transcriptReadOnly && session.setMode
        ? (modeId: string) => {
            void session.setMode!(modeId);
          }
        : null,
    [session, transcriptReadOnly],
  );
  // The rail publishes its scroll-spy pass here so the scroll-restore layout
  // effect can light the right tick before first paint.
  const checkpointRecomputeRef = useRef<(() => void) | null>(null);
  const checkpointNavigateRef = useRef<((direction: MessageNavigation) => boolean) | null>(null);
  // A count, not a flag: several queued sends can await their turn, and each new
  // last checkpoint consumes one (see the last-checkpoint effect below).
  const pendingSendScrollCountRef = useRef(0);

  // Editing a past prompt truncates history at that message and resends it. It
  // never reverts files on disk; that is a separate operation.
  const editAndResubmit = useCallback(
    async (
      messageId: string,
      editedText: string,
      // ALL staged attachments (reconstructed originals + new), inline.
      attachments: ComposerAttachment[],
      segments?: ComposerSegment[],
    ) => {
      const trimmed = editedText.trim();
      if (transcriptReadOnly || !chatId) return;
      if (trimmed.length === 0 && attachments.length === 0) {
        return;
      }
      // The edit is accepted now; record before cancellation/attachment/SQLite
      // awaits so a slow resubmit cannot later leapfrog another workspace.
      if (chatThread?.folder) recordWorkspaceActivity(chatThread.folder);
      // Cancel a streaming turn before truncating, or its response keeps arriving
      // after the edited prompt is gone.
      if (session.status === "streaming") {
        try {
          await session.cancel?.();
        } catch {
          /* cancel best-effort; carry on with truncate */
        }
      }
      // Every harness receives confirmed file references, including resends of
      // older text/image attachments. Resolve them before changing history.
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
      // A reconstructed chip has no bytes of its own. When its recovery read fails,
      // report it instead of silently dropping the attachment.
      reportSkippedAttachments(skippedOnEdit, toast.warning);
      if (skippedOnEdit.length > 0) return false;
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
      // Await the SQLite truncate before sendPrompt, or the first persist write
      // coalesces with the flush and rows past the cut survive a reload.
      try {
        await ipcTruncateMessagesFrom(chatId, messageId);
      } catch {
        /* SQLite unavailable in browser harness; in-memory is fine */
      }
      // The resubmitted prompt gets a fresh id, so the last-checkpoint effect
      // scrolls it into view even when the count is unchanged.
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
    [chatId, chatThread?.folder, session, transcriptReadOnly],
  );

  // The composer hook below defines openPreview; read it through a ref so
  // messageCtx stays stable.
  const openPreviewRef = useRef<((src: string) => void) | null>(null);
  const previewImageThroughRef = useCallback((src: string) => {
    openPreviewRef.current?.(src);
  }, []);
  // Read through refs: the cwd resolves later and the open helper's identity
  // changes, but messageCtx must stay stable.
  const chatCwdRef = useRef<string | undefined>(undefined);
  const openChatFile = useOpenChatFileInWorkbench();
  const openChatFileRef = useRef(openChatFile);
  useEffect(() => {
    openChatFileRef.current = openChatFile;
  }, [openChatFile]);
  const warmFileThroughRef = useCallback(
    (path: string) => {
      if (!readOnly) warmChatFileInWorkbench(chatCwdRef.current, path);
    },
    [readOnly],
  );
  const openChatPreview = useOpenChatPreviewInWorkbench();
  const chatPreviewRef = useRef({ chatId: chatId ?? "", executionId: session.executionId ?? undefined, ports: session.boundaryPorts ?? undefined });
  chatPreviewRef.current = { chatId: chatId ?? "", executionId: session.executionId ?? undefined, ports: session.boundaryPorts ?? undefined };
  const openPreviewUrlThroughRef = useCallback((url: string) => openChatPreview(chatCwdRef.current, url, chatPreviewRef.current), [openChatPreview]);
  const openFileThroughRef = useCallback(
    (path: string) => {
      if (!readOnly) openChatFileRef.current(chatCwdRef.current, path);
    },
    [readOnly],
  );
  // A link to the active workspace's PR opens its Review tab. Read through a ref
  // to keep messageCtx stable.
  const openPrUrl = useOpenPrUrlInReviewTab();
  const openPrUrlRef = useRef(openPrUrl);
  useEffect(() => {
    openPrUrlRef.current = openPrUrl;
  }, [openPrUrl]);
  const openPrUrlThroughRef = useCallback(
    (url: string) => openPrUrlRef.current(url),
    [],
  );
  // Keep pending records inspectable; only blocking asks pause live activity.
  const hasBlockingQuestion = session.pendingQuestions.some((question) => question.request.blocking);
  const pendingQuestionToolCallIds = useMemo(() => {
    return collectPendingQuestionToolCallIds(
      session.pendingQuestions,
      session.messages,
    );
  }, [session.pendingQuestions, session.messages]);
  const retrySafetyReviewRef = useRef(session.retrySafetyReview);
  retrySafetyReviewRef.current = session.retrySafetyReview;
  const retrySafetyReviewThroughRef = useCallback((retryId: string) => {
    if (transcriptReadOnly) return Promise.resolve();
    const retry = retrySafetyReviewRef.current;
    return retry
      ? retry(retryId)
      : Promise.reject(new Error("Safety retry is unavailable."));
  }, [transcriptReadOnly]);
  const openBrowserSettings = useCallback(() => {
    if (!interactive) return;
    requestUserSettingsSection("browser-use");
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  }, [dispatch, interactive]);
  // Every streamed chunk re-renders AgentChat with a new session object and
  // re-derives these collections from the whole message list. Share unchanged
  // collections and route session-bound handlers through their newest closure,
  // so the renderer context (and every memoized turn reading it) stays
  // referentially stable while another message streams. Only a committed
  // render becomes the sharing baseline.
  const sharedCtxRef = useRef<{
    subagentChildren?: Map<string, AgentMessage[]>;
    editBaselines?: Map<string, string>;
    pendingQuestionToolCallIds?: Set<string>;
  }>({});
  const stableSubagentChildren = useMemo(
    () => shareMessageBuckets(sharedCtxRef.current.subagentChildren, subagentChildren),
    [subagentChildren],
  );
  const stableEditBaselines = useMemo(
    () => shareMap(sharedCtxRef.current.editBaselines, editBaselines),
    [editBaselines],
  );
  const stablePendingQuestionToolCallIds = useMemo(
    () => shareSet(sharedCtxRef.current.pendingQuestionToolCallIds, pendingQuestionToolCallIds),
    [pendingQuestionToolCallIds],
  );
  useLayoutEffect(() => {
    sharedCtxRef.current = {
      subagentChildren: stableSubagentChildren,
      editBaselines: stableEditBaselines,
      pendingQuestionToolCallIds: stablePendingQuestionToolCallIds,
    };
  }, [stableSubagentChildren, stableEditBaselines, stablePendingQuestionToolCallIds]);
  const respondToQuestionThroughRef = useLatestCallback(respondToQuestion);
  const respondToPermissionThroughRef = useLatestCallback(respondToPermission);
  const editAndResubmitThroughRef = useLatestCallback(editAndResubmit);
  const setModeThroughRef = useLatestCallback((modeId: string) => {
    setModeForCtx?.(modeId);
  });
  const setModeAvailable = setModeForCtx !== null;
  // Turns read this context; each TurnEventList derives its own isStreaming
  // and lastMessageId, so those two never re-render settled turns.
  const transcriptCtx: RendererContext = useMemo(
    () => ({
      transcriptReadOnly,
      isStreaming: false,
      lastMessageId: null,
      activeTurnStartedAt,
      subagentChildren: stableSubagentChildren,
      editBaselines: stableEditBaselines,
      respondToQuestion: respondToQuestionThroughRef,
      pendingQuestionToolCallIds: transcriptReadOnly
        ? NO_PENDING_QUESTION_TOOL_CALL_IDS
        : stablePendingQuestionToolCallIds,
      hasBlockingQuestion: !transcriptReadOnly && hasBlockingQuestion,
      pendingPermission: transcriptReadOnly ? null : session.pendingPermission,
      respondToPermission: respondToPermissionThroughRef,
      retrySafetyReview: retrySafetyReviewThroughRef,
      safetyReviewRetries: transcriptReadOnly ? undefined : session.safetyReviewRetries,
      recordPolicy,
      chatId: chatId ?? null,
      setMode: setModeAvailable ? setModeThroughRef : null,
      editAndResubmit: editAndResubmitThroughRef,
      previewImage: previewImageThroughRef,
      attachmentCwd: chatThread?.folder ?? session.cwd ?? null,
      attachmentImagesActive: surfaceActive,
      liveTextSource,
      openFile: openFileThroughRef,
      warmFile: warmFileThroughRef,
      openPrUrl: readOnly ? undefined : openPrUrlThroughRef,
      openPreviewUrl: readOnly ? undefined : openPreviewUrlThroughRef,
      openBrowserSettings: interactive ? openBrowserSettings : undefined,
    }),
    [
      openBrowserSettings,
      interactive,
      activeTurnStartedAt,
      stableSubagentChildren,
      stableEditBaselines,
      respondToQuestionThroughRef,
      stablePendingQuestionToolCallIds,
      hasBlockingQuestion,
      session.pendingPermission,
      respondToPermissionThroughRef,
      retrySafetyReviewThroughRef,
      session.safetyReviewRetries,
      recordPolicy,
      chatId,
      setModeAvailable,
      setModeThroughRef,
      editAndResubmitThroughRef,
      previewImageThroughRef,
      chatThread?.folder,
      session.cwd,
      surfaceActive,
      liveTextSource,
      readOnly,
      transcriptReadOnly,
      openFileThroughRef,
      warmFileThroughRef,
      openPrUrlThroughRef,
      openPreviewUrlThroughRef,
    ],
  );

  // State, not refs, so the hooks that need these elements re-run when they mount.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [activePromptEl, setActivePromptEl] = useState<HTMLDivElement | null>(
    null,
  );
  // Mirrors scrollEl for imperative readers.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const agentsList = useWorkspaceAgents(chatThread?.folder, interactive);
  const agentSessions = useAgentSessions();
  const cloudComputerV2 = useCloudWorkspaceAccountAccess(parseCloudWorkspaceKey(chatThread?.folder)?.organizationId);
  const retryTurn = useCallback(
    (prompt: AgentTextMessage, events: AgentMessage[], newChat: boolean) => {
      if (!chatId || !interactive) return Promise.resolve();
      return retryAgentTurn({ chatId, prompt, events, newChat }, {
        sessions: agentSessions,
        getChat: (id) => useWorkspaceStore.getState().chats.find((chat) => chat.id === id),
        publishChat: (chat) => dispatch({ type: "ADD_CHAT", chat }),
      }).catch((error) => {
        // The source card is hidden after navigation to the fresh chat.
        if (newChat) toast.error(error instanceof Error ? error.message : "Could not retry in a new chat.");
        throw error;
      });
    },
    [agentSessions, chatId, dispatch, interactive],
  );
  const capabilitiesBridge = useBridge();
  const changeComposerMode = useCallback((mode: "code" | "design") => {
    if (!capabilitiesBridge || !chatId) return;
    void setComposerMode(capabilitiesBridge, chatId, mode).catch((error: unknown) => {
      toast.error("Could not change Design mode", { description: error instanceof Error ? error.message : String(error) });
    });
  }, [capabilitiesBridge, chatId]);
  const enterDesignMode = useCallback(() => changeComposerMode("design"), [changeComposerMode]);
  const leaveDesignMode = useCallback(() => changeComposerMode("code"), [changeComposerMode]);
  const designFrameContext = useComposerDesignFrame({
    chatId,
    cwd: chatThread?.folder ?? session.cwd ?? undefined,
    active: interactive && !readOnly,
    intent: chatThread?.composerMode ?? "code",
    initialFrame: seededDraft?.designFrame,
    onPin: useCallback((target: import("./design-frame-attachment").DesignFrameAttachmentSelection | null | undefined) => {
      composerLiveRef.current.designFrame = target;
      if (chatId && !readOnly) setLiveChatDraft(chatId, { ...composerLiveRef.current });
    }, [chatId, readOnly]),
  });
  const pinDesignFrame = designFrameContext.pin;
  const preparationOwner = JSON.stringify([
    chatId,
    session.agentId ?? chatThread?.agentId,
    chatThread?.folder,
    interactive,
  ]);
  const preparationOwnerRef = useRef<string | null>(preparationOwner);
  preparationOwnerRef.current = preparationOwner;
  useEffect(() => {
    preparationOwnerRef.current = preparationOwner;
    return () => { preparationOwnerRef.current = null; };
  }, [preparationOwner]);
  const prepareSessionTools = useCallback(async () => {
    const agentId = session.agentId ?? chatThread?.agentId;
    if (!chatId || !agentId || workspaceProvisioning || !interactive) return;
    // The normal admission path owns auth, boundaries, env and single-flight
    // startup. Opening Tools prepares that same chat without adding a prompt.
    await agentSessions
      .ensureSession(chatId, agentId, {
        cwd: session.cwd ?? chatThread?.folder ?? undefined,
        env: chatThread ? envForChat(chatThread, session.initialize) : undefined,
      })
      .catch(() => {
        // Admission publishes its failure on the chat's session state.
      });
  }, [
    agentSessions,
    chatId,
    chatThread,
    session.agentId,
    session.cwd,
    session.initialize,
    workspaceProvisioning,
    interactive,
  ]);
  const prepareSessionCommands = useCallback(() => {
    const agentId = session.agentId ?? chatThread?.agentId;
    if (
      !chatId || agentId !== "claude" || !interactive ||
      workspaceProvisioning || capabilitiesBridge?.status !== "connected"
    ) return;
    void warmPreparedSessionTools(
      sessionToolsResource(capabilitiesBridge),
      prepareSessionTools,
      () => {
        if (preparationOwnerRef.current !== preparationOwner) return null;
        const current = useSessionsStore.getState().sessions[chatId];
        if (
          current?.agentId !== agentId || !current.executionId || !current.cwd ||
          !["ready", "streaming"].includes(current.status)
        ) return null;
        return {
          agentId,
          sessionId: current.executionId,
          workspaceId: current.cwd,
        };
      },
    ).catch(() => {
      // Admission failures are already in session state. Keep confirmed
      // commands; another picker open or Tools refresh can retry discovery.
    });
  }, [
    chatId,
    session.agentId,
    chatThread?.agentId,
    interactive,
    workspaceProvisioning,
    capabilitiesBridge,
    prepareSessionTools,
    preparationOwner,
  ]);

  // Verify auth in the background only after this session settles: the probes
  // run provider subprocesses that would compete with a cold resume or first
  // turn. loadAgents (TTL-bound, unlike refreshAgents) coalesces mount storms.
  useEffect(() => {
    if (
      !session.agentId ||
      isCloudWorkspace(chatThread?.folder) ||
      !interactive ||
      !canVerifyAgentRegistryInBackground(session.status)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      const latestStatus = chatId
        ? useSessionsStore.getState().sessions[chatId]?.status
        : session.status;
      if (!latestStatus || !canVerifyAgentRegistryInBackground(latestStatus)) {
        return;
      }
      void loadAgents((force) => agentSessions.listAgents(force)).catch(() => {
        /* Keep the last confirmed registry during background revalidation. */
      });
    }, AGENT_REGISTRY_VERIFICATION_DELAY_MS);
    return () => clearTimeout(timer);
  }, [agentSessions, chatId, chatThread?.folder, session.agentId, session.status, interactive]);

  const signInAgentId = session.agentId ?? chatThread?.agentId ?? null;
  const handleSignIn = useCallback(() => {
    if (!interactive || !isSubscriptionProvider(signInAgentId)) return;
    requestProviderSettings(signInAgentId);
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
  }, [dispatch, signInAgentId, interactive]);
  // Keep the ref the chat file-open closure reads in sync with the chat's
  // workspace owner. The session cwd is only a pre-hydration fallback: if an
  // engine ever reports a nested cwd, its file link still belongs to the
  // Workbench slice keyed by the chat's bound folder.
  useEffect(() => {
    const cwd = chatFileOpenCwd(chatThread?.folder, session.cwd);
    chatCwdRef.current = cwd;
    // Prime the workspace file list so the FIRST file-chip click resolves
    // synchronously (instant open) instead of waiting on git ls-files.
    if (!readOnly && (surfaceActive || !isCloudWorkspace(cwd))) warmWorkspaceFiles(cwd);
  }, [session.cwd, chatThread?.folder, readOnly, surfaceActive]);
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
      if (readOnly || !chatId) return;
      dispatch({ type: "UPDATE_CHAT_SETTINGS", id: chatId, updates });
    },
    [chatId, dispatch, readOnly],
  );

  // Lifted here so opening one turn's edit composer closes any other; null means
  // none.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Plan maps to the agent's own plan-shaped mode (Claude "plan", Codex
  // "read-only"). Before the live session advertises modes, use the selected
  // agent's static modes so the menu shows its real vocabulary; the live modes
  // reconcile by id on bind.
  const effectiveModes = useMemo(
    () =>
      session.availableModes.length > 0
        ? session.availableModes
        : staticModesForAgent(session.agentId ?? chatThread?.agentId ?? null),
    [session.availableModes, session.agentId, chatThread?.agentId],
  );

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

  // Selecting a mode both switches the live session and persists the exact
  // native id to chat.lastModeId, so it survives a force-respawn (see
  // reconcilePermissionModeAtBind).

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

  // Leave Plan for the exact mode used before it. Approving Claude's
  // ExitPlanMode must call this, or the toggle stays on Plan and the next turn
  // re-plans.
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

  // A plan-shaped id goes through enterPlan so the pre-plan mode is remembered;
  // any other mode is set live and persisted.
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

  // Prefer the live mode, then the persisted id, then the posture default,
  // coerced to a mode this model offers. The persisted mode is untouched, so
  // switching back to a capable model restores it.
  const fallbackPermissionModeId =
    agentModeForPermission(
      chatThread?.permissionMode ?? "auto",
      effectiveModes,
      chatAgentId,
    )?.id ?? null;
  const currentPermissionModeId: string | null = coerceModeIdForModel(
    chatAgentId,
    chatThread?.model ?? null,
    permissionModeIdForDisplay({
      status: session.status,
      liveModeId: session.currentModeId,
      persistedModeId: chatThread?.lastModeId ?? null,
      fallbackModeId: fallbackPermissionModeId,
    }),
    session.boundary,
  );

  const permissionModes = permissionModesAvailable(chatThread?.folder);
  const showPermissionToggle = permissionModes && agentHasPermissionMenu(
    chatAgentId,
    chatThread?.model ?? null,
  );

  // Dashed composer frame for the guarded "propose, don't act" modes — Claude
  // Plan, Codex Ask for approval, and Cursor Ask.
  const composerGuarded = permissionModes && permissionModeShowsFrame(
    chatAgentId,
    currentPermissionModeId,
  );

  // A started chat is its agent's session, so other agents' models open a new
  // tab. In-memory messages or a promoted title (which survives a respawn) mean
  // it has started.
  const hasSessionMessages = useSessionsStore((s) => {
    if (!chatId) return false;
    const slot = s.sessions[chatId];
    return !!slot && (slot.hasTranscript || slot.messages.length > 0);
  });
  // Which turn (if any) this renderer has an unsettled prompt for. The tail's
  // liveness is derived from this rather than from session status, so a chat
  // being REOPENED — a tab switch, a workspace switch, an app reload, all of
  // which warm a session — never repaints a finished turn as working.
  const conversationStarted = useSessionsStore((s) => !!chatThread &&
    !canSwitchPristineChat(chatThread, chatId ? s.sessions[chatId] : undefined));

  // The prompt cache is keyed by model and effort, so a mid-conversation change
  // re-reads the whole conversation at full price. Warn once per workspace, and
  // only when real messages exist.
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

  // A fresh chat switches agent in place, clearing the native mode ids and engine
  // session id, which don't translate across agents. A started chat opens a new
  // tab for the picked agent and carries the draft across.
  const agentSwitchRef = useRef(0);
  const switchAgentModel = useCallback(
    function selectAgentModel(sel: AgentModelSelection) {
      if (!chatThread || !chatId) return;
      const selection = ++agentSwitchRef.current;
      const born = newChatBornDefaults(sel.agentId);
      // Exact-key restoration: a model always gets its own last effort/Fast
      // pair. Never carry the source model's configuration across this switch.
      const { effort, fast } = resolveModelConfiguration(
        sel.agentId,
        sel.model,
        null,
      );
      // Pristine needs both: no in-memory messages and the never-promoted title,
      // because after a respawn the slot is empty while history hydrates.
      const currentSlot = useSessionsStore.getState().sessions[chatId];
      if (isCloudWorkspace(chatThread.folder) && currentSlot && currentSlot.transcriptState !== "resident") {
        const { navigationVersion, activeChatId } = useWorkspaceStore.getState();
        // Unknown history is not proof of a started chat. Share its existing
        // read before deciding whether a new tab is necessary. Only the latest
        // pick in this exact view may act after hydration.
        void agentSessions.hydrateChat(chatId).then(() => {
          const state = useWorkspaceStore.getState(), current = state.chats.find(row => row.id === chatId);
          if (agentSwitchRef.current === selection && current?.folder === chatThread.folder &&
              current.agentId === chatThread.agentId && current.updatedAt === chatThread.updatedAt &&
              state.navigationVersion === navigationVersion && state.activeChatId === activeChatId &&
              useSessionsStore.getState().sessions[chatId]?.transcriptState === "resident") selectAgentModel(sel);
        }).catch(() => {});
        return;
      }
      const pristine = canSwitchPristineChat(chatThread, currentSlot);
      if (pristine) {
        const { navigationVersion, activeChatId } = useWorkspaceStore.getState();
        const apply = () => updateChatSettings({
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
        const closing = isCloudWorkspace(chatThread.folder)
          ? agentSessions.closeSession(chatId, { reason: "agent-switch" })
          : agentSessions.closeSession(chatId);
        if (closing) {
          void closing.then((confirmed) => {
            const state = useWorkspaceStore.getState(), current = state.chats.find((row) => row.id === chatId);
            if (confirmed && agentSwitchRef.current === selection && current?.folder === chatThread.folder && current.agentId === chatThread.agentId &&
                current.updatedAt === chatThread.updatedAt && state.navigationVersion === navigationVersion &&
                state.activeChatId === activeChatId) apply();
          }).catch(() => {});
        } else apply();
        return;
      }
      const fresh: ChatThread = {
        id: newChatId(chatThread.folder),
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

  // Shared with TurnPromptHeader's edit mode so editing a past prompt has the
  // same pills.
  const editToolbarPills = useMemo(() => {
    if (!chatThread) return null;
    return (
      <>
        <ModelPill
          agents={agentsList}
          agentId={chatThread.agentId}
          initialize={session.initialize}
          onRefreshModels={isCloudWorkspace(chatThread.folder) ? session.refreshModelCatalog : undefined}
          value={chatThread.model}
          effort={chatThread.effort}
          fast={!!chatThread.fast}
          onSelectAgentModel={switchAgentModel}
          redirectCrossAgent={conversationStarted}
          selectionTiming={isCloudWorkspace(chatThread.folder) ? "next-message" : undefined}
          onConfigure={({ effort, fast }) => {
            const effortChanged = effort !== chatThread.effort;
            updateChatSettings({ effort, fast });
            session.updateConfig?.();
            if (effortChanged) maybeShowCostBumpToast("effort");
          }}
          onChange={(v) => {
            if (chatId) {
              const store = useSessionsStore.getState();
              store.patchSession(chatId, { modelSelectionRevision: (store.sessions[chatId]?.modelSelectionRevision ?? 0) + 1 });
            }
            const configuration = resolveModelConfiguration(
              chatThread.agentId,
              v,
              session.initialize,
            );
            updateChatSettings({ model: v, ...configuration });
            // Apply to the LIVE session too, so the change takes effect on the
            // next turn instead of only on a rebuild.
            if (v) session.setModel?.(v);
            // After setModel: updateConfig pushes the whole env, carrying the effort and
            // Fast resets and stamping appliedChatEnvKey so sendPrompt does not respawn.
            session.updateConfig?.();
            // Once per chat, a mid-conversation model change is a
            // cache miss on the next reply (slower + more tokens).
            if (v && v !== chatThread.model) maybeShowCostBumpToast("model");
          }}
        />
        {showPermissionToggle && (
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
    // Depends on the session slices read above, not the whole session object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chatThread,
    interactive,
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
  const cloudPreviewsEnabled = useCloudWorkspaceAccountAccess(parseCloudWorkspaceKey(chatThread?.folder)?.organizationId);
  const cloudCanEdit = useCloudWorkspaceCanEdit(chatThread?.folder);
  const cloudPreviewsActive = cloudPreviewsEnabled && cloudCanEdit;
  const warmBoundaryPreview = useCallback(() => {}, []);
  const openBoundaryPreview = useCallback(
    (port: ExecutionBoundaryPortStatus) => {
      if (!workspacePreviewAvailable(chatThread?.folder ?? "")) return;
      if (isCloudWorkspace(chatThread?.folder)) {
        if (!cloudPreviewsActive || !chatId || !session.executionId) return;
        dispatch({ type: "ADD_WORKBENCH_TAB", scope: chatThread?.folder, tab: createBrowserTab({
          url: `http://localhost:${port.port}/`, title: `localhost:${port.port}`,
          previewSource: { chatId, port: port.port, executionId: session.executionId, portId: port.id },
        }) });
        return;
      }
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
    [chatId, chatThread?.folder, dispatch, nativeReady, openBoundaryPort, cloudPreviewsActive, session.executionId],
  );

  const chatFolder = chatThread?.folder || undefined;
  // Resolve the chat's repo origin so the #-PR picker can list PRs.
  const { projects } = useProjects();
  const composerOriginUrl =
    findProjectForFolder(chatFolder ?? null, projects)?.originUrl ?? null;

  // Composer @-mention, slash and #-PR pickers, shared with the edit composer.
  // /add-dir and "Link workspaces" grant Claude another directory on the next
  // respawn.
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
          setWorkspacePickerOpen(true);
          return true;
        case "compact":
          // Compaction is not a prompt: no "/compact" bubble lands in the transcript, and
          // it narrates itself as an agent-output row.
          void session.compactContext?.();
          return true;
        case "goal":
          if(!goalsAvailable){toast.error("Goals are unavailable for this cloud chat.");return true;}
          setGoalEditorOpen(true);
          return true;
        case "clear": {
          // Close this chat and open a fresh one on the same agent, model and workspace.
          // The old transcript stays reopenable from History.
          if (!chatId) return false;
          const fresh: ChatThread = {
            id: newChatId(chatThread.folder),
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
          const { navigationVersion, activeChatId } = useWorkspaceStore.getState();
          // ADD_CHAT also sets the new chat active → navigation. Archiving the
          // old chat AFTERWARD leaves it non-active, so focus stays on the new
          // one (no replacement-neighbor selection like the tab-close path).
          const finish = (deferred = false) => {
            const state = useWorkspaceStore.getState(), current = state.chats.find((row) => row.id === chatId);
            if (!current || current.archived || current.folder !== chatThread.folder || current.agentId !== chatThread.agentId) return;
            if (!deferred || state.navigationVersion === navigationVersion && state.activeChatId === activeChatId)
              dispatch({ type: "ADD_CHAT", chat: fresh, recordWorkspaceActivity: true });
            dispatch({ type: "ARCHIVE_CHAT", id: chatId });
          };
          const closing = agentSessions.closeSession(chatId);
          if (closing) void closing.then((confirmed) => { if (confirmed) finish(true); }).catch(() => {});
          else finish();
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
      goalsAvailable,
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

  // Returns true when it took ownership, so the caller strips the token instead
  // of sending text. Without a cwd it falls through to text.
  const openTerminalCommand = useCallback(
    (name: string): boolean => {
      if (name === "login" && isSubscriptionProvider(terminalAgentId)) {
        handleSignIn();
        return true;
      }
      if (slashCommandKind(terminalAgentId, name) !== "terminal") return false;
      if (!terminalCwd) return false;
      setTerminalCommand(name);
      return true;
    },
    [terminalAgentId, terminalCwd, handleSignIn],
  );

  // Mid-turn sends park in the queue card above the composer. Its ↑/↓ selection
  // is virtual: the composer keeps DOM focus.
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
  const queueEditGenerationRef = useRef(0);
  const queueKeysRef = useRef({
    arrowUp: (): boolean => false,
    arrowDown: (): boolean => false,
    deleteKey: (): boolean => false,
    modEnter: (): boolean => false,
    escape: (): boolean => false,
  });

  const composer = useComposerEditor({
    agentId: session.agentId ?? chatThread?.agentId ?? null,
    agentName: session.agentName ?? session.agentId ?? null,
    agentSupportsImage:
      session.initialize?.agentCapabilities?.promptCapabilities?.image !==
      false,
    modelId: chatThread?.model ?? null,
    cwd: readOnly ? null : session.cwd ?? chatThread?.folder ?? null,
    stageIntoContextGraph: !readOnly,
    attachmentImagesActive: interactive,
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
    onSlashOpen: prepareSessionCommands,
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
    // History keeps this editor mounted through recovery. Seed its parked
    // draft once, including attachment bytes; readOnly gates editing, staging
    // and persistence until the same composer becomes available again.
    initialContent: initialContentRef.current,
  });
  const {
    editor: composerEditor,
    isEmpty: composerEmpty,
    serialize: serializeComposerState,
    insertFiles: addFiles,
    hasPendingAttachmentReads: composerAttachmentsReading,
    waitForAttachmentReads: waitForComposerAttachmentReads,
    insertTextAttachment: stageTextAttachment,
    removeAttachmentBySourceKey: unstageAttachment,
    stagedSourceKeys,
    clear: clearComposerEditor,
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
  const clearComposer = () => { clearComposerEditor(); designFrameContext.clear(); };
  const composerHasContent = !composerEmpty || designFrameContext.hasContext;
  const queuedEditHasContent = !composerEmpty || Boolean(editingQueuedId && cloudComputerV2 && isCloudWorkspace(chatThread?.folder) && session.getQueuedDraft?.(editingQueuedId)?.prepareAdditional);
  composerFocusRef.current = focusComposer;
  // The composer stays editable in every session state, because sending from a
  // failed chat is the retry. Only saved history is read-only.
  useEffect(() => {
    composerEditor?.setEditable(!readOnly);
  }, [composerEditor, readOnly]);

  // A fork publishes its new tab before the transcript read settles. Register
  // only while THIS retained surface is active. Delivery is background work:
  // keep the current focus, and let a hidden destination queue the chip.
  useEffect(() => {
    if (!chatId || !interactive || !composerEditor) return;
    return registerLiveChatTextAttachmentStager(chatId, (input) => {
      const staged = stageTextAttachment(input, { focus: false });
      if (staged && !staged.ok) {
        toast.warning(
          `Attached "${input.name}", but it won't be sent — ${staged.reason ?? "it exceeds this model's attachment budget"}.`,
        );
      }
      return staged !== null;
    });
  }, [chatId, composerEditor, interactive, stageTextAttachment]);

  // Browser element selections arrive as Files and take the paste/drop path,
  // so validation, workspace staging (local or cloud) and draft persistence
  // match user-added pills. Same active-only gate as above: a hidden or
  // read-only composer leaves the delivery queued for this exact chat.
  useEffect(() => {
    if (!chatId || !interactive || readOnly || !composerEditor) return;
    return registerLiveChatFileStager(chatId, ({ files, groupName }, { focus }) => {
      if (composerEditor.isDestroyed) return false;
      // A queued delivery may drain after the user has moved to another input.
      // Append without moving its focus or the parked composer's caret.
      if (focus) focusComposer();
      void addFiles(files, { focus, atEnd: true, groupName });
      return true;
    });
  }, [addFiles, chatId, composerEditor, focusComposer, interactive, readOnly]);

  // Attach another chat's transcript. The read runs only while this chat is
  // interactive (hidden retained chats stay inert) and a consumer shows it: the
  // empty-chat row or the "+" picker. The menu warms it on pointer or focus.
  const transcriptRowLive =
    emptyStateReady &&
    session.messages.length === 0 &&
    !session.error &&
    !!chatThread?.folder;
  const historyFolder = chatThread?.folder ?? session.cwd;
  const historyConnection = useBridgeStatus(historyFolder);
  const transcriptHistoryStatus = useTranscriptHistoryStatus({
    identity: JSON.stringify([chatThread?.folder ?? session.cwd, chatId]),
    active: surfaceActive,
    hasMessages: session.messages.length > 0,
    hasTranscript: session.hasTranscript,
    resident: session.transcriptState === "resident",
    error: session.transcriptReadError,
    // Cloud history reads the control-plane mirror even while its VM sleeps.
    connected: isCloudWorkspace(historyFolder) || historyConnection === "connected",
    retry: session.hydrateChat,
  });
  const transcriptLoadingVisible = transcriptHistoryStatus === "loading";
  const { summaries: transcriptSummaries, loaded: transcriptsLoaded } =
    useChatTranscriptSummaries(
      chatThread?.folder,
      chatId,
      interactive && (transcriptRowLive || transcriptPickerOpen),
    );
  const warmTranscriptPicker = useCallback(() => {
    warmChatTranscriptSummaries(chatThread?.folder, chatId);
  }, [chatThread?.folder, chatId]);
  // If the engine is busy or starting, show the workspace rows after a short
  // grace; the transcript row replaces them when the list lands. The timer runs
  // only for the visible empty chat.
  const [transcriptWaitExpiredFor, setTranscriptWaitExpiredFor] = useState<string | null>(null);
  useEffect(() => {
    if (!chatId || !interactive || !transcriptRowLive || transcriptsLoaded) return;
    const timer = window.setTimeout(() => setTranscriptWaitExpiredFor(chatId), TRANSCRIPT_LIST_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [chatId, interactive, transcriptRowLive, transcriptsLoaded]);
  // null means "not known yet", the third answer provenanceBlockShape depends on.
  // Derived from the rendered array, so the rows never yield to an empty row.
  const hasTranscripts = transcriptsLoaded
    ? transcriptSummaries.length > 0
    : transcriptWaitExpiredFor === chatId
      ? false
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
  // True while a send is being prepared. A cold transcript read or session
  // rebuild can re-enter with the composer still full, and each re-entry would
  // otherwise send the same composer again (see handleSend).
  const sendInFlightRef = useRef(false);
  // The visible half of sendInFlightRef: a send parked on a cold read or rebuild
  // can take tens of seconds, so the submit button shows its spinner meanwhile.
  const [sendPreparing, setSendPreparing] = useState(false);

  // Derived from the composer document, never a second list, so removing a chip
  // un-adds its pill with one direction of data flow.
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
      const mayFocus = captureDeferredFocus(composerEditor?.view.dom ?? null);
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
      // The click handler must not await I/O; the preceding hover has usually warmed
      // the cache. handleSend waits on transcriptAttachesRef for the cold case.
      const run = (async () => {
        try {
          const snap = await loadTranscriptSnapshot({
            chatId: sourceId,
            mode,
            lastMessageAt: summary.lastMessageAt,
            // No exportedAt: meta is not part of the cache key, so a timestamp would make
            // the hover preview and the attachment differ depending on who missed first.
            meta: { title: summary.title, folder: summary.folder },
          });
          // A second click while the read is in flight means stop, not attach again.
          if (transcriptCancelRef.current.has(sourceId)) return;
          if (snap.count === 0) {
            // Everything was filtered out (for example a chat whose only turn never
            // answered); say so instead of attaching an empty file.
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
            // Frozen here: the chip's hover header describes the file, not the live chat.
            preview: {
              agentId: summary.agentId,
              agentName: summary.agentName,
              userMessageCount: summary.userMessageCount,
              lastMessageAt: summary.lastMessageAt,
            },
          }, { focus: surfaceActiveRef.current && mayFocus() });
          // An over-budget attachment is excluded at send, so this is the only place to
          // say so; otherwise the pill would show a check for a file the agent never gets.
          if (staged && !staged.ok) {
            toast.warning(
              `Attached "${label}", but it won't be sent — ${staged.reason ?? "it exceeds this model's attachment budget"}.`,
            );
          } else if (snap.truncated || !snap.complete) {
            // A truncated document or an incomplete history walk is a partial record, and
            // the user must be told, as the copy action does.
            toast.warning(
              `Attached the most recent part of "${label}" — the full history was too large to read.`,
            );
          }
        } catch (err) {
          if (transcriptCancelRef.current.has(sourceId)) return;
          // Beyond not-connected, these are transport strings that tell the user nothing
          // actionable.
          console.error("[Zeros] transcript attach failed:", err);
          toast.error("Couldn't read that transcript — try again in a moment.");
        } finally {
          settle();
        }
      })();
      transcriptAttachesRef.current.add(run);
      void run.finally(() => transcriptAttachesRef.current.delete(run));
    },
    [composerEditor, stageTextAttachment],
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
        .then(async(snapshot) => {
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
          toast.error("Couldn't fork this chat. Reopen it and try again.");
        });
      trackPendingTextAttachmentDelivery(fresh.id, delivery);
    },
    [chatThread, dispatch, readForkTranscript],
  );

  /** A second click on a pill whose read hasn't landed: abandon the attach and
   *  drop its pending state on the same frame. */
  const cancelTranscriptAttach = useCallback((sourceChatId: string) => {
    transcriptCancelRef.current.add(sourceChatId);
    setPendingTranscriptIds((prev) => {
      if (!prev.has(sourceChatId)) return prev;
      const next = new Set(prev);
      next.delete(sourceChatId);
      return next;
    });
  }, []);

  /** "Open this chat" from a pill's menu. The list includes closed chats, so
   *  unarchive first: a bare SET_ACTIVE_CHAT on an archived id shows nothing and
   *  the selection keeper bounces it. UNARCHIVE_CHAT is a no-op for open chats. */
  const openTranscriptChat = useCallback(
    (sourceChatId: string) => {
      dispatch({ type: "UNARCHIVE_CHAT", id: sourceChatId });
      dispatch({ type: "SET_ACTIVE_CHAT", id: sourceChatId });
    },
    [dispatch],
  );

  // Turns render with content-visibility:auto, so a hidden chat's scrollTop
  // drifts by the size estimates. Positions are saved as an anchor turn, offset
  // and at-bottom flag (chat-scroll-anchor.ts), and restores re-measure the
  // anchor for a few frames.
  const setScrollPosition = useSessionsStore((s) => s.setScrollPosition);
  /** Mirrors surfaceActive for the save gate: a hidden chat's collapse-clamp
   *  scroll events must never overwrite the saved reading position. */
  const surfaceActiveRef = useRef(surfaceActive);
  surfaceActiveRef.current = surfaceActive;
  /** A saved position waiting for the cold-boot hydrate, which lands after mount;
   *  the layout effect after useStickyBottom applies it once messages exist. */
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

  // One assignment is not enough: content-visibility renders the turns near the
  // target for real only in later frames, so each pass re-measures the anchor.
  // A user gesture cancels at once.
  const SETTLE_FRAMES = 4;
  const settleCancelRef = useRef<() => void>(() => {});
  const settleEpochRef = useRef(0);
  useEffect(() => () => settleCancelRef.current(), []);
  const settleScroll = useCallback(
    (el: HTMLElement, computeTarget: () => number, onFinished?: () => void, follow = false) => {
      beginChatScrollNavigation(el, { follow, target: computeTarget() });
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
        el.removeEventListener(CHAT_SCROLL_NAVIGATION_EVENT, finish);
        el.removeEventListener("wheel", finish);
        el.removeEventListener("touchstart", finish);
        el.removeEventListener("pointerdown", finish);
        el.removeEventListener("keydown", finish);
        if (settleEpochRef.current === epoch) {
          restoreInProgressRef.current = false;
        }
        onFinished?.();
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
      el.addEventListener(CHAT_SCROLL_NAVIGATION_EVENT, finish);
      el.addEventListener("wheel", finish, { passive: true });
      el.addEventListener("touchstart", finish, { passive: true });
      el.addEventListener("pointerdown", finish, { passive: true });
      el.addEventListener("keydown", finish);
      raf = requestAnimationFrame(tick);
      settleCancelRef.current = finish;
      return finish;
    },
    [],
  );
  /** Land on a saved position: the anchor turn's live top plus offset, or raw
   *  pixels when the anchor is gone. The rail recompute runs before paint. */
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
  /** Land on the tail; the target re-derives from scrollHeight each frame, so
   *  content that re-expands still ends flush at the bottom. */
  const restoreToBottom = useCallback(
    (el: HTMLElement) => {
      // Tail-following needs no historical turns materialized; skip the full layout
      // of a cold 200-message transcript.
      settleScroll(el, () => el.scrollHeight - el.clientHeight, undefined, true);
      checkpointRecomputeRef.current?.();
    },
    [settleScroll],
  );

  // Snap to the bottom by default, or restore the saved position when a chat
  // joins the retained deck or cold-boots. Before paint, so a chat restored above
  // the bottom lights the right rail tick on the first frame.
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

  // rAF-coalesced; the trailing frame records the resting position. Never save
  // from a hidden surface, a detached or zero-height scroller, or while a
  // cold-boot restore is pending.
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

  // Extra scroll room at the tail so clicking a late checkpoint can still land
  // its prompt at the top of the viewport. CheckpointRail sizes it; it renders
  // here so scrollHeight includes it, and above useStickyBottom, which reads it.
  const [checkpointSpacerPx, setCheckpointSpacerPx] = useState(0);
  checkpointSpacerPxRef.current = checkpointSpacerPx;

  // Sticky-bottom auto-scroll (use-sticky-bottom.ts). The checkpoint spacer is
  // blank room, not content: while it is active the auto-snap pauses and "at
  // bottom" means the content bottom. Seed at-bottom from the saved position: a
  // chat mounted hidden is never measured, and a true seed would snap a
  // mid-transcript restore to the bottom on reveal.
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
    // Freeze measurement while hidden: the content-visibility clamp would mark
    // every hidden chat "at bottom".
    {
      bottomInsetPx: checkpointSpacerPx,
      enabled: surfaceActive,
      initialAtBottom: initialAtBottomRef.current,
    },
  );
  // Declared after useStickyBottom on purpose: its layout effect may snap to the
  // bottom of the pre-hydrate transcript first, and this re-applies the saved
  // target in the same commit.
  useLayoutEffect(() => {
    const pending = pendingHydrateRestoreRef.current;
    if (pending === null || !scrollEl) return;
    if (session.messages.length === 0) return;
    pendingHydrateRestoreRef.current = null;
    if (pending.atBottom) restoreToBottom(scrollEl);
    else restoreToPosition(scrollEl, pending);
  }, [session.messages, scrollEl, restoreToPosition, restoreToBottom]);

  // A Home, repository or settings round trip keeps the pane host connected, so
  // restore on every hidden-to-active transition too.
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

  // A workspace switch detaches the pane host, and Chromium zeroes scrollers in
  // a detached subtree. ChatPane calls this after reparenting; capture is
  // registered beside it so ChatPane can flush the final position first.
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

  // Hydration loads the latest 200 messages; older history pages in as the
  // reader nears the top. loadOlder keeps an anchor so tail growth is not
  // mistaken for the prepend's height.
  const LOAD_OLDER_PAGE = 200;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderPageRequestRef = useRef<object | null>(null);
  const olderPageEpochRef = useRef(0);
  const olderPageFailureRef = useRef<{
    epoch: number;
    cursor: string;
    executionId: AgentSessionState["executionId"];
    sessionId: AgentSessionState["sessionId"];
  } | null>(null);
  const olderScrollCancelRef = useRef<() => void>(() => {});
  // Retiring a surface invalidates its read and correction before the next
  // paint. A late finally must not clear a replacement surface's loading state.
  useLayoutEffect(() => {
    setLoadingOlder(false);
    olderPageFailureRef.current = null;
    return () => {
      olderPageEpochRef.current += 1;
      olderPageRequestRef.current = null;
      olderScrollCancelRef.current();
    };
  }, [
    chatId,
    scrollEl,
    surfaceActive,
    session.executionId,
    session.sessionId,
    session.transcriptState,
  ]);
  // Probe SQLite once with a one-row read so a brand-new chat never loads.
  const [hasOlder, setHasOlder] = useState(false);
  // Far enough out that the next page usually arrives before the edge, close
  // enough that a chat parked mid-transcript never pages in unrequested history.
  const NEAR_TOP_PX = 600;
  const [nearTop, setNearTop] = useState(false);
  useEffect(() => {
    if (!scrollEl || !surfaceActive) return;
    const onScroll = () => {
      if (!surfaceActiveRef.current || restoreInProgressRef.current) return;
      // Retry a failed cursor only after the reader leaves this paging band.
      if (scrollEl.scrollTop > NEAR_TOP_PX) olderPageFailureRef.current = null;
      setNearTop(scrollEl.scrollTop <= NEAR_TOP_PX);
    };
    setNearTop(scrollEl.scrollTop <= NEAR_TOP_PX);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [scrollEl, surfaceActive]);

  // Reveal the scrollbar only while scrolling, by flagging data-scrolling on the
  // element directly so the scroll stream never re-renders the transcript
  // (runtime-content.css keys the thumb off it).
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

  // Re-probe when the oldest message id changes too: a rebuild can insert a
  // resume marker before the user prompt.
  const hasAnyMessages = session.messages.length > 0;
  const oldestMsgId = session.messages[0]?.id;
  useEffect(() => {
    if (!chatId || !hasAnyMessages) {
      setHasOlder(false);
      return;
    }
    if (!surfaceActive) return;
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
        const current = useSessionsStore.getState().sessions[chatId];
        if (!canApplyHistoryPage(slot, current)) return;
        if (rows.length === 0) {
          setHasOlder(false);
          return;
        }
        // Deduplicate against memory: in-memory order can differ from SQLite's arrival
        // order (a resume marker inserted before the prompt), so the probe could
        // report a message that is already loaded.
        const present = new Set(current.messages.map((m) => m.id));
        const hasGenuineOlder = rows.some((r) => !present.has(r.id));
        setHasOlder(hasGenuineOlder);
      } catch {
        // SQLite/IPC unavailable (browser harness) — leave hasOlder
        // at false; loadOlder is a no-op there anyway.
        if (
          !cancelled &&
          canApplyHistoryPage(slot, useSessionsStore.getState().sessions[chatId])
        ) {
          setHasOlder(false);
        }
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, [
    chatId,
    hasAnyMessages,
    oldestMsgId,
    surfaceActive,
    session.executionId,
    session.sessionId,
    session.transcriptState,
  ]);
  const loadOlder = useCallback(async () => {
    if (!chatId || !surfaceActiveRef.current) return;
    if (loadingOlder || olderPageRequestRef.current) return;
    const slot = useSessionsStore.getState().sessions[chatId];
    const oldest = slot?.messages[0];
    if (!oldest || slot.transcriptState !== "resident") return;
    const epoch = olderPageEpochRef.current;
    const failure = olderPageFailureRef.current;
    // Clearing loading state must not retry the same failed read on each
    // render. Live appends leave this execution/session/cursor unchanged.
    if (
      failure?.epoch === epoch &&
      failure.cursor === oldest.id &&
      failure.executionId === slot.executionId &&
      failure.sessionId === slot.sessionId
    ) return;
    const request = {};
    let awaitingRestore = false;
    const finishRequest = () => {
      if (olderPageRequestRef.current !== request) return;
      olderPageRequestRef.current = null;
      if (scrollEl?.isConnected && surfaceActiveRef.current) {
        setNearTop(scrollEl.scrollTop <= NEAR_TOP_PX);
      }
      setLoadingOlder(false);
    };
    olderPageRequestRef.current = request;
    setLoadingOlder(true);
    try {
      const older = await ipcWindowOlderMessages(
        chatId,
        LOAD_OLDER_PAGE,
        oldest.id,
      );
      if (
        olderPageRequestRef.current !== request ||
        !surfaceActiveRef.current
      ) return;
      const current = useSessionsStore.getState().sessions[chatId];
      if (!canApplyHistoryPage(slot, current)) return;
      if (older.length === 0) {
        setHasOlder(false);
        return;
      }
      const messages = prependHistoryPage(current.messages, older);
      if (messages === current.messages) {
        // SQLite returned only messages already in memory — treat as no-more.
        setHasOlder(false);
        return;
      }
      olderScrollCancelRef.current();
      if (scrollEl?.isConnected && !restoreInProgressRef.current) {
        const position = captureHistoryPageScrollPosition(scrollEl);
        const applied = { ...current, messages };
        const restoreEpoch = settleEpochRef.current;
        olderScrollCancelRef.current = scheduleHistoryPageScrollRestore(
          scrollEl,
          position,
          {
            isCurrent: () =>
              surfaceActiveRef.current &&
              olderPageEpochRef.current === epoch &&
              canApplyHistoryPage(applied, useSessionsStore.getState().sessions[chatId]),
            allowHeightFallback: () =>
              useSessionsStore.getState().sessions[chatId]?.messages === messages,
            restore: (computeTarget, onFinished) => {
              if (
                restoreInProgressRef.current ||
                settleEpochRef.current !== restoreEpoch
              ) return;
              const cancel = settleScroll(scrollEl, computeTarget, onFinished);
              checkpointRecomputeRef.current?.();
              return cancel;
            },
            onFinished: finishRequest,
            requestFrame: (callback) => window.requestAnimationFrame(callback),
            cancelFrame: (frame) => window.cancelAnimationFrame(frame),
          },
        );
        awaitingRestore = true;
      }
      useSessionsStore.getState().patchSession(chatId, {
        messages,
        // Suspend the live-append trim (MAX_MESSAGES_PER_CHAT) while the
        // reader holds expanded history — see the re-arm effect below.
        historyExpanded: true,
      });
      if (older.length < LOAD_OLDER_PAGE) setHasOlder(false);
    } catch (err) {
      if (
        olderPageRequestRef.current === request &&
        olderPageEpochRef.current === epoch &&
        surfaceActiveRef.current &&
        canApplyHistoryPage(slot, useSessionsStore.getState().sessions[chatId])
      ) {
        olderPageFailureRef.current = {
          epoch,
          cursor: oldest.id,
          executionId: slot.executionId,
          sessionId: slot.sessionId,
        };
        console.warn("[Zeros] load-older failed:", err);
      }
      if (awaitingRestore) olderScrollCancelRef.current();
    } finally {
      // React may publish the prepend before the correction frame. Keep the
      // synchronous lock through settling so auto-paging cannot overtake it.
      if (!awaitingRestore) finishRequest();
    }
  }, [chatId, loadingOlder, scrollEl, settleScroll]);
  // Auto-page older history near the top. Each prepend pushes the viewport down,
  // and the next scroll event re-evaluates nearTop, so loading chains only while
  // the reader keeps pulling up.
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
  // Back at the bottom, trim to the live window again and clear
  // historyExpanded; scrolling up pages the trimmed rows back in from disk.
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

  // Older builds persisted mode_switch rows; drop them before grouping so they
  // neither render as unknown rows nor form an empty leading turn.
  const stableTurnsRef = useRef<ReturnType<typeof groupMessagesIntoTurns>>([]);
  // A Local window can begin inside one long turn; its opening prompt travels
  // beside the window (transcript-leading-prompt.ts) so the turn keeps its
  // prompt bubble, checkpoint and footer.
  const leadingPrompt = session.leadingPrompt ?? null;
  const turns = useMemo(
    () =>
      stabilizeTurns(
        stableTurnsRef.current,
        groupMessagesIntoTurns(
          presentLeadingPrompt(
            visibleMessages.filter((m) => (m.kind as string) !== "mode_switch"),
            leadingPrompt,
          ),
        ),
      ),
    [visibleMessages, leadingPrompt],
  );
  const authenticationRecoveredAt = useMemo(() => latestAuthenticationRecoveryTurn(turns), [turns]);
  // Only a committed render becomes the baseline. Mutating this ref inside
  // useMemo lets an abandoned concurrent render influence the next pass.
  useLayoutEffect(() => {
    stableTurnsRef.current = turns;
  }, [turns]);
  const initialCachedTurnIndex = useMemo(() => {
    if (!provisionalTranscript || !chatId) return -1;
    const saved = useSessionsStore.getState().scrollPositions[chatId];
    return saved && !saved.atBottom
      ? turns.findIndex(turn => turn.userPrompt?.id === saved.anchorId)
      : -1;
  }, [chatId, provisionalTranscript, turns]);

  // Hold the previous array while prompt ids and previews are unchanged: turns
  // rebuild on every streamed chunk, and a fresh array would re-fire
  // CheckpointRail's layout recompute for every checkpoint on each chunk.
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

  // A send only guarantees the prompt is seen: when the new turn renders out of
  // view, scroll to the bottom. Keyed on the last checkpoint id, not the count,
  // because history paging prepends and an edit can change the id alone. Each id
  // change consumes one pending send.
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
    // Any sliver over 32px in the viewport counts as seen, including a long prompt
    // whose top is above it.
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

  const setScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollEl(node);
  }, []);

  // Message shortcuts use the checkpoint rail; panel shortcuts reach the
  // scroll boundaries. Capture reaches the rich composer; DOM ownership keeps
  // retained chats and other columns from reacting to the focused pane's key.
  useEffect(() => {
    if (!surfaceActive) return;
    const handler = (e: KeyboardEvent) => {
      if (hasShortcutPriorityClaim() || navigationShortcutBlocked(e)) return;
      const shortcut = resolveNavigationShortcut(e);
      if (shortcut?.kind !== "message" && shortcut?.kind !== "agent-panel-scroll") return;
      if (chatId) {
        const workspaceState = useWorkspaceStore.getState();
        if (
          workspaceState.activePage !== "workspace" ||
          workspaceState.activeChatId !== chatId
        ) {
          return;
        }
      }
      const el = scrollRef.current;
      if (!el) return;
      const owner = el.closest("[data-pane-root]") ?? el.closest(".zeros-agent-surface");
      if (!(e.target instanceof Node) || !owner?.contains(e.target)) return;
      if (shortcut.kind === "agent-panel-scroll") {
        e.preventDefault();
        e.stopPropagation();
        pendingHydrateRestoreRef.current = null;
        scrollChatToBoundary(el, shortcut.direction);
        return;
      }
      if (checkpointNavigateRef.current?.(shortcut.direction)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [chatId, surfaceActive]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  openPreviewRef.current = openPreview;
  // The editor's onChange mirrors the composer into composerLiveRef, which the
  // sidebar's "+ New Agent" reads synchronously; parking and unmount publish it
  // to the store.
  const updateLiveDraft = useCallback(() => {
    if (readOnly || !chatId) return;
    const s = serializeComposerState();
    if (!s || s.isEmpty) {
      composerLiveRef.current = { text: "", attachments: [], json: null, designFrame: composerLiveRef.current.designFrame };
      setLiveChatDraft(chatId, composerLiveRef.current);
      return;
    }
    const draft = {
      text: s.displayText,
      attachments: s.attachments,
      json: s.json,
      designFrame: composerLiveRef.current.designFrame,
    };
    composerLiveRef.current = draft;
    setLiveChatDraft(chatId, { ...draft });
  }, [chatId, serializeComposerState, readOnly]);
  updateLiveDraftRef.current = updateLiveDraft;
  const persistComposerDraft = useCallback(() => {
    if (readOnly || !chatId) return;
    const { text, attachments: atts, json, designFrame } = composerLiveRef.current;
    if (text.trim() === "" && atts.length === 0 && designFrame === undefined) {
      dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
      return;
    }
    dispatch({
      type: "SET_CHAT_DRAFT",
      chatId,
      draft: { text, attachments: atts, json, designFrame },
    });
  }, [chatId, dispatch, readOnly]);
  useEffect(() => {
    if (readOnly || !chatId) return;
    return registerLiveChatDraftRestorer(chatId, (draft) => {
      // A queued-message edit or newer typing owns the editor now. The live
      // draft coordinator also checks its keystroke-fresh mirror, while this
      // final editor read covers imperative content that deliberately paused
      // live persistence.
      if (editingQueuedRef.current) return false;
      const current = serializeComposerState();
      if (current && !current.isEmpty || hasDesignFrameAttachmentSelection(composerLiveRef.current.designFrame)) return false;
      setComposerContent({
        json: draft.json ?? (draft.text.trim() ? textToDoc(draft.text) : null),
        attachments: draft.attachments,
      });
      composerLiveRef.current = {
        text: draft.text,
        attachments: draft.attachments,
        json: draft.json ?? null,
        designFrame: draft.designFrame,
      };
      pinDesignFrame(draft.designFrame);
      return true;
    });
  }, [chatId, serializeComposerState, setComposerContent, readOnly, pinDesignFrame]);
  useEffect(() => {
    return () => {
      if (readOnly || !chatId) return;
      persistComposerDraft();
      // Hand off to the parked snapshot before releasing the live owner.
      setLiveChatDraft(chatId, null);
    };
  }, [chatId, persistComposerDraft, readOnly]);

  const isErrorState =
    (session.status === "failed" || session.status === "auth-required") &&
    !(cloudComputerV2 && isCloudWorkspace(chatThread?.folder) && session.cloudSendWait?.state === "waiting");

  // Real authentication rejections invalidate the exact registry once. Mount,
  // reveal and routine lifecycle failures must not fan out probes or toasts.
  const lastErrorObservationRef = useRef({ chatId, folder: chatThread?.folder,
    account: cloudCatalogGeneration(), agentId: session.agentId, failure: session.failure,
    error: session.error, status: session.status });
  useEffect(() => {
    const previous = lastErrorObservationRef.current;
    const current = { chatId, folder: chatThread?.folder, account: cloudCatalogGeneration(),
      agentId: session.agentId, failure: session.failure, error: session.error, status: session.status };
    lastErrorObservationRef.current = current;
    if (!interactive || !isErrorState || previous.chatId !== current.chatId || previous.folder !== current.folder ||
        previous.account !== current.account || previous.agentId !== current.agentId) return;
    const sameFailure = previous.failure === current.failure || !!previous.failure && !!current.failure &&
      (["kind", "message", "stage", "agentId", "advice"] as const).every(key => previous.failure![key] === current.failure![key]) &&
      previous.failure.exit?.code === current.failure.exit?.code && previous.failure.exit?.signal === current.failure.exit?.signal &&
      previous.failure.exit?.stderrTail === current.failure.exit?.stderrTail;
    if (sameFailure && previous.error === current.error && previous.status === current.status) return;
    if (cloudComputerV2 && isCloudWorkspace(chatThread?.folder) && session.cloudSendWait) return;
    if (session.failure?.kind === "lifecycle-superseded" || session.failure?.kind === "transport-closed") return;
    const detail = session.failure?.message ?? session.error ?? undefined;
    // A transport message is not evidence of rejected credentials.
    if (isTransportShaped(detail)) {
      return;
    }
    const isAuth =
      session.status === "auth-required" ||
      session.failure?.kind === "auth-required";
    // Refresh cached provider state only when the CLI explicitly rejects
    // authentication; protocol, transport and Design-protection failures are not
    // auth evidence and must not fan out probes.
    if (isAuth) {
      if (current.folder && isCloudWorkspace(current.folder)) {
        invalidateCloudAgentRegistry(current.folder);
      } else {
        invalidateAgentsCache();
        void refreshAgents((force) => agentSessions.listAgents(force)).catch(() => {
          /* Retain the last confirmed Local registry until it can refresh. */
        });
      }
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
    interactive,
    cloudComputerV2,
    chatThread?.folder,
    session.cloudSendWait,
  ]);
  // Use the footer's exact cached row to decide whether it can present this
  // failure. Completed/cancelled history cannot own a later startup failure.
  // Local notification turns have a recorded ID without a user prompt.
  // The read is shared with that footer and remains inert on hidden surfaces.
  const preparationTurn = turns.at(-1);
  const preparationTurnRead = useCachedRead(
    turnRowCache,
    !readOnly && !provisionalTranscript && chatId && turnCheckpointsAvailable(chatId) && preparationTurn?.recordedTurnId &&
      session.status === "failed" && session.failure?.stage !== "prompt"
      ? turnRowKey(chatId, preparationTurn.recordedTurnId)
      : null,
    (key) => {
      const [ownerChatId, turnId] = key.split("\u0000");
      return turnGet(ownerChatId, turnId);
    },
    { maxAgeMs: 30_000, enabled: surfaceActive },
  );
  const preparationTurnFailure = !provisionalTranscript && chatId && preparationTurn?.recordedTurnId &&
    session.status === "failed" && session.failure?.stage !== "prompt"
    ? turnFailureForCard({
        events: preparationTurn.providerEvents,
        turnId: preparationTurn.recordedTurnId,
        fallback: session.failure,
        recoveryFailure: preparationTurn.userPrompt?.recoveryFailure,
        status: preparationTurnRead.data?.status,
        stopReason: session.lastStopReason ?? preparationTurnRead.data?.stopReason,
        live: tailTurnInFlight({ sessionStreaming: isStreaming,
          pendingLocalTurn: pendingLocalTurnId === preparationTurn.userPrompt?.id,
          hasEvents: preparationTurn.events.length > 0 }),
        retrying: pendingLocalTurnId === preparationTurn.userPrompt?.id,
      }) : null;
  // Keep terminal startup failures in this chat exactly once, while normal
  // reconnects and superseded preparation stay quiet.
  const preparationFailure = !readOnly && session.status === "failed" &&
    session.failure && session.failure.stage !== "prompt" &&
    !preparationTurnFailure &&
    !(cloudComputerV2 && isCloudWorkspace(chatThread?.folder) && session.cloudSendWait) &&
    session.failure.kind !== "auth-required" &&
    session.failure.kind !== "cloud-credentials-unavailable" &&
    session.failure.kind !== "lifecycle-superseded" &&
    !isRecoverable(session.failure) && !isTransportShaped(session.failure.message)
      ? session.failure : null;
  // Plan review is not a permission gate: the user can approve, copy, or type a
  // follow-up to refine it. isPlanReviewRequest (plan-body.ts) detects it from
  // the ExitPlanMode title or a plan body, not the kind; Codex's bodiless
  // switch_mode escalation is a real gate.
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
  const composerStreaming = cloudPresentationRunning(session, pendingLocalTurnId) ?? (Boolean(isCloudWorkspace(session.cwd) && (session.cloudStop || session.cloudOutbox?.pendingCount && !session.cloudOutbox.waiting)) || !(isCloudWorkspace(session.cwd) && (session.cloudSendWait || session.cloudPromptPending)) && composerShowsStopControl({
    status: backgroundContinuationActive ? "streaming" : session.status,
    hasPendingLocalTurn: pendingLocalTurnId !== null,
    planReview: Boolean(planReview),
  }));

  // Mid-turn steering is advertised per session; an unsupported harness disables
  // "Send now" while a turn runs.
  const steeringSupported =
    session.initialize?.agentCapabilities?.steering;
  const steeringAgentName =
    session.agentName ??
    chatThread?.agentName ??
    session.agentId ??
    "This agent";

  // Cursor's SDK reports no current context-window fill, so its gauge stays
  // disabled.
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

  // One card docks above the composer for a pending Allow/Deny, except Claude's
  // plan review, which is not a gate.
  const nativeConfirmation = nextNativeConfirmation(
    browserConfirmation,
    agentControlConfirmation,
  );
  const nativePermissionCardActive = browserConfirmationShouldTakeComposer({
    browserPending: Boolean(nativeConfirmation),
    providerPermissionPending: Boolean(session.pendingPermission),
    providerIsPlanReview: Boolean(planReview),
  });
  const providerPermissionCardActive =
    !!session.pendingPermission && !planReview && !nativePermissionCardActive;
  // Native confirmations are main-process gates owned by the exact chat that
  // started the browser session or asked to control an app or simulator. They
  // reuse this existing card instead of a global dialog. A provider-native
  // hard permission remains ahead of them; non-blocking plan review yields so
  // asynchronous browser work cannot stall with no visible decision surface.
  const permissionCardActive =
    providerPermissionCardActive || nativePermissionCardActive;
  const permissionRequest = useMemo(
    () =>
      nativePermissionCardActive && nativeConfirmation
        ? nativeConfirmationToPermissionRequest(nativeConfirmation)
        : (session.pendingPermission?.request ?? null),
    [
      nativeConfirmation,
      nativePermissionCardActive,
      session.pendingPermission,
    ],
  );
  const respondToVisiblePermission = useCallback(
    (
      response: import("../../platform/bridge/agent-events").RequestPermissionResponse,
    ) => {
      if (nativePermissionCardActive && nativeConfirmation) {
        void respondToNativeConfirmation(nativeConfirmation, response).catch(
          () => {
            toast.error(nativeConfirmationFailureText(nativeConfirmation));
          },
        );
        return;
      }
      if (session.pendingPermission) session.respondToPermission(response);
    },
    [nativeConfirmation, nativePermissionCardActive, session],
  );

  // Permissions take priority over questions. Every card sits above the
  // still-usable composer: the agent may be working meanwhile, and a message
  // typed below queues behind the turn (Send now steers it in). A blocking
  // card holds the keyboard, so its shortcuts work until the user clicks into
  // the composer (see composerCardDock).
  const pendingQuestion = session.pendingQuestions?.[0] ?? null;
  const questionCardActive = !!pendingQuestion && !permissionCardActive;
  const blockingQuestionActive = questionCardActive && pendingQuestion?.request.blocking === true;
  const { concealed: composerConcealed, cardHoldsKeyboard } = composerCardDock({
    interactive,
    permissionCardActive,
    blockingQuestionActive,
  });
  // A non-interactive chat's composer is display:none, not unmounted, so the
  // draft survives. Popovers anchored to it must close, or Radix re-parks them at
  // the viewport's corner. The refs mirror state for the focus guardian.
  const composerConcealedRef = useRef(composerConcealed);
  composerConcealedRef.current = composerConcealed;
  const cardHoldsKeyboardRef = useRef(cardHoldsKeyboard);
  cardHoldsKeyboardRef.current = cardHoldsKeyboard;
  useComposerCardFocus(
    composerCardRef,
    cardHoldsKeyboard && interactive && (!chatId || activeChatId === chatId),
  );

  // Focus this chat's composer when it becomes the active chat (new tab, tab or
  // pane switch, History open, a card resolving). Only the global active chat
  // pulls focus, and never away from another input, dialog or the workbench
  // (composer-focus.ts).
  const acquiredComposerFocusRef = useRef(false);
  useEffect(() => {
    const action = nextComposerFocusAction({
      owns: composerOwnsFocus({
        chatId,
        activeChatId,
        composerConcealed,
        cardHoldsKeyboard,
      }),
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
    const mayFocus = captureDeferredFocus(composerEditor?.view.dom ?? null);
    let cancelled = false;
    // Defer one microtask: a just-revealed retained layer clears its `inert`
    // this commit, and a pane/tab click blurs the previous composer as its
    // default action — both must settle before we read document.activeElement
    // and move focus.
    queueMicrotask(() => {
      // A fast re-switch may have moved on since the effect ran.
      if (cancelled || !mayFocus() || !composerOwnsFocus({
        chatId,
        activeChatId: useWorkspaceStore.getState().activeChatId,
        composerConcealed: composerConcealedRef.current,
        cardHoldsKeyboard: cardHoldsKeyboardRef.current,
      }))
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
    return () => { cancelled = true; };
  }, [chatId, activeChatId, composerConcealed, cardHoldsKeyboard, composerEditor]);

  // A click inside the active window that blurs the composer returns focus to it,
  // except for the workbench, other panes, text selection and real inputs,
  // menus or dialogs (shouldReclaimComposerFocus). The re-check is a macrotask:
  // a microtask would run before the click's own handlers and race Radix
  // triggers mid-open.
  useEffect(() => {
    if (!interactive || !composerEditor) return;
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
      const mayFocus = captureDeferredFocus(composerDom);
      setTimeout(() => {
        if (!surfaceActiveRef.current || !mayFocus()) return;
        const selection = window.getSelection();
        if (
          shouldReclaimComposerFocus({
            owns: composerOwnsFocus({
              chatId,
              activeChatId: useWorkspaceStore.getState().activeChatId,
              composerConcealed: composerConcealedRef.current,
              cardHoldsKeyboard: cardHoldsKeyboardRef.current,
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
  }, [interactive, composerEditor, chatId]);

  // failed and auth-required do not disable Send: sending is the retry, one
  // rebuild per explicit send. The button keeps its error tint.
  const canSend =
    (session.transcriptState === "resident" || cloudComputerV2 && isCloudWorkspace(chatThread?.folder)) &&
    !composerStreaming &&
    composerHasContent;

  // Attach-time staging has normally completed already. Await the final
  // persistence check for every kind before publishing a reference to an agent.
  const encodeComposerAttachments = async (
    localAttachments: ComposerAttachment[],
  ) => {
    if (localAttachments.length > 0) setSendPreparing(true);
    return encodeAttachments(localAttachments, {
      supportsImage:
        session.initialize?.agentCapabilities?.promptCapabilities?.image !== false,
      cwd: chatThread?.folder || null,
      chatId: chatId ?? null,
      agentId: session.agentId ?? chatThread?.agentId ?? null,
    }).finally(() => {
      if (localAttachments.length > 0) setSendPreparing(false);
    });
  };

  /** The chat whose send is parked on an unreadable transcript: one automatic
   *  retry, then no park-drain cycling. Cleared when the transcript reads. */
  const transcriptParkedChatRef = useRef<string | null>(null);

  /** Park a send whose transcript cannot be read: keep the exact document as the
   *  draft and arm its one-shot auto-send for the readiness drain. Always tell the
   *  user. */
  const parkUnreadableTranscriptSend = (
    parkChatId: string,
    override?: string,
  ): void => {
    const snapshot = override === undefined ? serializeComposerState() : null;
    const action = unreadableTranscriptSendAction({
      hasPayload: snapshot
        ? !snapshot.isEmpty || hasDesignFrameAttachmentSelection(composerLiveRef.current.designFrame)
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
      designFrame: composerLiveRef.current.designFrame,
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
      followUpBehavior?: FollowUpBehavior;
      /** Summary imports from prior chats, prepended as <from_previous_chat> blocks. */
      imports?: import("../../state/store").SummaryImport[];
      /** Attachments from another surface (browser capture), encoded like paste and
       *  drop so persistence and metadata match. */
      stagedAttachments?: ComposerAttachment[];
      /** Pre-built ContentBlocks (for example images queued in the EmptyComposer),
       *  appended after the local attachments. */
      extraAttachments?: ContentBlock[];
      /** Chip metadata the EmptyComposer already computed, so the seeded bubble
       *  matches what the user saw. */
      bubbleAttachments?: import("./use-agent-session").AgentTextMessageAttachment[];
      /** Ordered bubble segments (text + inline pills) for the EmptyComposer
       *  hand-off path; the direct-send path derives them from the editor. */
      bubbleSegments?: MessageContentSegment[];
    },
    recordActivity = true,
  ) => {
    // A transcript click returns before its read lands, so a fast Enter after a
    // cold click would send without the chip and then stage it into the next
    // message. Send is the commit, so it waits for explicitly staged reads; the
    // single-flight guard makes that await safe.
    const capturedDesignFrame = override === undefined ? designFrameContext.capture() : null;
    const submittedDesignFrame = hasDesignFrameAttachmentSelection(capturedDesignFrame) ? capturedDesignFrame : null;
    const cloudSubmission = cloudComputerV2 && !!chatId && isCloudWorkspace(chatThread?.folder);
    const sendGeneration = chatId ? agentSessions.getSendGeneration(chatId) : undefined;
    const hydrateNeeded = !cloudSubmission && session.transcriptState !== "resident";
    const forkAttachmentPending = chatId
      ? hasPendingTextAttachmentDelivery(chatId)
      : false;
    // Same for a dropped video whose key frames are still being read: they
    // go with the video rather than into the next message.
    const attachmentReadsPending = override === undefined && composerAttachmentsReading();
    if (
      hydrateNeeded ||
      transcriptAttachesRef.current.size > 0 ||
      forkAttachmentPending ||
      attachmentReadsPending
    ) {
      setSendPreparing(true);
      try {
        if (hydrateNeeded) await session.hydrateChat();
        await Promise.allSettled([...transcriptAttachesRef.current]);
        if (chatId) await waitForPendingTextAttachmentDeliveries(chatId);
        if (attachmentReadsPending) await waitForComposerAttachmentReads();
      } finally {
        setSendPreparing(false);
      }
    }
    // An unreadable transcript never gets a new bubble appended. A chat with no
    // slot is a provisioning workspace and falls through to its queue below; any
    // other unreadable state parks the send for the reconnect drain instead of
    // silently doing nothing.
    {
      const storeTranscriptState = chatId
        ? useSessionsStore.getState().sessions[chatId]?.transcriptState
        : "resident";
      if (
        chatId &&
        !cloudSubmission &&
        storeTranscriptState !== "resident" &&
        !(storeTranscriptState === undefined && workspaceProvisioning)
      ) {
        designFrameContext.pin(submittedDesignFrame);
        parkUnreadableTranscriptSend(chatId, override);
        return;
      }
      // Readable again — re-arm the single automatic retry above.
      transcriptParkedChatRef.current = null;
    }
    const snapshot = override === undefined ? serializeComposerState() : null;
    const localAttachments: ComposerAttachment[] = snapshot?.attachments ?? [];
    const attachmentsToEncode = [
      ...localAttachments,
      ...(extras?.stagedAttachments ?? []),
    ];
    const rawText = override ?? snapshot?.displayText ?? "";
    const displayText = rawText.trim();
    // A permission gate holds the turn but not the composer: the send queues behind
    // it. During plan review a typed follow-up denies the review (Claude keeps
    // planning) and becomes the next prompt.
    const permissionSend = sendPastPermission({
      permissionPending: !!session.pendingPermission,
      planReview: !!planReview,
      status: session.status,
    });
    if (permissionSend === "hold") return;
    if (permissionSend === "revise-plan") denyPlanReview();
    // A bare /plan, /fast, /ultracode or /compact runs its action instead of
    // sending; a terminal command (/mcp, /login) opens the embedded terminal.
    const importCount = extras?.imports?.length ?? 0;
    const extraAttachCount =
      (extras?.extraAttachments?.length ?? 0) +
      (extras?.stagedAttachments?.length ?? 0);
    const commandHasAttachments =
      localAttachments.length > 0 || importCount > 0 || extraAttachCount > 0 || submittedDesignFrame !== null;
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
      extraAttachCount === 0 &&
      !submittedDesignFrame
    ) {
      return;
    }
    const cloudTarget = cloudComputerV2 && chatId ? parseCloudWorkspaceKey(chatThread?.folder) : null;
    if (cloudSubmission && chatId) {
      if (!cloudTarget) throw new Error("The cloud workspace identity is unavailable. Reopen this workspace to send.");
      if (recordActivity && chatThread?.folder) recordWorkspaceActivity(chatThread.folder);
      const wakeIntent = bareCommand && !commandHasAttachments ? { id: crypto.randomUUID() } : undefined;
      if (bareCommand && !commandHasAttachments) {
        await agentSessions.prepareForSend(chatId, wakeIntent);
        if (agentSessions.getSendGeneration(chatId) !== sendGeneration) return;
        if (openTerminalCommand(bareCommand[1])) {
          if (override === undefined) {
            clearComposer(); dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
          }
          return;
        }
      }
      const prefix = extras?.imports?.map(s => `<from_previous_chat name="${(s.title || "prior chat").replace(/"/g, "'")}"${s.agentId ? ` agent="${s.agentId}"` : ""}>\n${s.summary}\n</from_previous_chat>`).join("\n\n");
      const queued = cloudQueuedPrompt({ cwd: chatThread!.folder, chatId, agentId: session.agentId ?? chatThread?.agentId,
        text: (prefix ? `${prefix}\n\n` : "") + expandMentionsInText(displayText, browserPickerSelection), displayText, snapshot,
        stagedAttachments: extras?.stagedAttachments, extraAttachments: extras?.extraAttachments,
        bubbleAttachments: extras?.bubbleAttachments, segments: extras?.bubbleSegments,
        prepareAdditional: submittedDesignFrame ? async () => {
          if (!capabilitiesBridge) throw new Error("The frame context connection is unavailable.");
          return prepareDesignFrameAttachments(capabilitiesBridge, submittedDesignFrame);
        } : undefined });
      let composerReleased = false;
      const releaseSubmittedComposer = () => {
        if (composerReleased) return;
        composerReleased = true;
        const unchanged = override === undefined && snapshot && isSubmittedComposerDocument(snapshot.json, serializeComposerState()?.json);
        if (unchanged) {
          clearComposerEditor(); designFrameContext.consume(submittedDesignFrame);
        }
        if (override !== undefined || unchanged)
          dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
      };
      await session.sendPrompt(queued.text, queued.displayText, queued.attachments, queued.bubbleAttachments, queued.segments, undefined, queued.cloudQueue, wakeIntent,
        extras?.followUpBehavior ?? getFollowUpBehavior(), releaseSubmittedComposer);
      // Legacy cloud senders release on return; durable sends release at their
      // private commit and must not clear a newer draft when HTTPS settles.
      releaseSubmittedComposer();
      pendingSendScrollCountRef.current += 1;
      return true;
    }
    // A prepared worktree has an identity but no usable cwd yet. Persist the exact
    // rich document and queue only this chat, so rapid creates keep independent
    // first messages and none spawns into a missing path.
    if (workspaceProvisioning && chatId && override === undefined && snapshot) {
      designFrameContext.pin(submittedDesignFrame);
      if (recordActivity && chatThread?.folder) {
        recordWorkspaceActivity(chatThread.folder);
      }
      const draft = {
        text: snapshot.displayText,
        attachments: snapshot.attachments,
        json: snapshot.json,
        designFrame: composerLiveRef.current.designFrame,
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
    // Check availability here; sendPrompt owns authentication so it can retain
    // the original message and attachments for explicit continuation.
    if (agentsList && !isCloudWorkspace(chatThread?.folder)) {
      const targetAgentId = session.agentId ?? chatThread?.agentId;
      const targetAgent = targetAgentId
        ? agentsList.find((a) => a.id === targetAgentId)
        : undefined;
      if (targetAgentId && !targetAgent) {
        // The registry is loaded but no longer knows this agent (a retired adapter).
        // Don't spawn; AgentRemovedPanel offers the switch.
        toast.error(`${targetAgentId}: Agent no longer available`, {
          description:
            "This agent was removed from Zeros. Switch this chat to an available agent to continue.",
        });
        return;
      }
      if (
        targetAgent &&
        !targetAgent.installed &&
        !isRunnableAgent(targetAgent)
      ) {
        toast.error(`${targetAgent.name}: Not installed`, {
          description: `Open Settings → Providers to install ${targetAgent.name}.`,
        });
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
    // Only a chat that ended badly (failed, auth-required) blocks here for a
    // rebuild, one attempt per explicit send: the user fixed a key or environment
    // and sends again. A chat that merely has no session yet starts one in the
    // background and falls through, so the send is accepted at once.
    const recoveryMode =
      session.status === "auth-required"
        ? null
        : sendSessionRecoveryMode(session.status);
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
          /* surfaces via session.error / the parked-turn release */
        });
    } else if (recoveryMode === "await") {
      const targetAgentId = session.agentId ?? chatThread?.agentId;
      if (!targetAgentId) return;
      setSendPreparing(true);
      try {
        // ensureSession already rebuilds unhealthy sessions. Pass the composer env: an
        // empty applied-env key would make sendPrompt respawn the session again.
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
    let submittedDesignAttachments: ComposerAttachment[] = [];
    if (submittedDesignFrame) {
      if (!capabilitiesBridge) throw new Error("The frame context connection is unavailable.");
      setSendPreparing(true);
      try {
        submittedDesignAttachments = await prepareDesignFrameAttachments(capabilitiesBridge, submittedDesignFrame);
        attachmentsToEncode.push(...submittedDesignAttachments);
      } finally {
        setSendPreparing(false);
      }
    }
    const {
      blocks: localImageBlocks,
      bubbleAttachments: localBubbleAttachments,
      bubbleAttachmentById: localBubbleAttachmentById,
      skipped: skippedAttachments,
    } = await encodeComposerAttachments(attachmentsToEncode);
    // The sent bubble renders every staged segment, so a dropped attachment would
    // look delivered. Say so.
    reportSkippedAttachments(skippedAttachments, toast.warning);
    if (skippedAttachments.length > 0) return;
    const extraBlocks: ContentBlock[] = [
      ...localImageBlocks,
      ...((extras?.extraAttachments as ContentBlock[] | undefined) ?? []),
    ];
    const bubbleAttachments = [
      ...localBubbleAttachments,
      ...(extras?.bubbleAttachments ?? []),
    ];
    const messageSegments: MessageContentSegment[] | undefined =
      override === undefined && snapshot
        ? toMessageSegments(
            snapshot.segments,
            localAttachments,
            localBubbleAttachmentById,
          )
        : extras?.bubbleSegments;
    // The generated frame attachment is outside the editable TipTap document;
    // include its normal file chip in the sent message's ordered segments.
    if (submittedDesignFrame && messageSegments) {
      for (const attachment of submittedDesignAttachments) {
        messageSegments.push(...toMessageSegments([{
          type: "attachment", attachmentId: attachment.id, name: attachment.name,
          mimeType: attachment.mimeType, kind: attachment.kind,
        }], [attachment], localBubbleAttachmentById));
      }
    }
    const submit = (onAccepted?: () => void) => session.sendPrompt(
      wireText, displayText, extraBlocks,
      bubbleAttachments.length > 0 ? bubbleAttachments : undefined,
      messageSegments && messageSegments.length > 0 ? messageSegments : undefined,
      onAccepted,
      undefined,
      undefined,
      extras?.followUpBehavior ?? getFollowUpBehavior(),
    );
    const submittedDraftUnchanged = override === undefined && snapshot &&
      isSubmittedComposerDocument(snapshot.json, serializeComposerState()?.json);
    if (submittedDraftUnchanged) {
      clearComposerEditor();
      designFrameContext.consume(submittedDesignFrame);
    }
    // Drop any stashed draft for this chat —
    // the user just sent it. Defensive against the cleanup-on-unmount
    // path racing the post-send empty state.
    if (chatId && (override !== undefined || submittedDraftUnchanged)) {
      dispatch({ type: "CLEAR_CHAT_DRAFT", chatId });
    }
    // Arm the send-jump after every early return, so slash commands and refused
    // sends never leave a stale count.
    pendingSendScrollCountRef.current += 1;
    submit().catch(() => {
      /* error surfaces via session.error */
    });
    return true;
  };

  /** Single-flight entry point for every send. runSend clears the composer only
   *  at its end, after I/O that can take tens of seconds, and each re-entry
   *  would send the same text again. Dropping a re-entry is safe: the composer
   *  is untouched, so it holds the message already being sent. */
  const handleSend = async (
    override?: string,
    extras?: Parameters<typeof runSend>[1],
    recordActivity = true,
  ): Promise<void> => {
    if (readOnly || sendInFlightRef.current) return;
    const folder = chatThread?.folder ?? session.cwd;
    const attemptId = `send-${crypto.randomUUID()}`;
    sendInFlightRef.current = true;
    const generation = chatId ? agentSessions.getSendGeneration(chatId) : undefined;
    try {
      await runSend(override, extras, recordActivity);
    } catch (error) {
      if (chatId && generation !== agentSessions.getSendGeneration(chatId)) return;
      if (chatId && isCloudWorkspace(folder)) {
        notifyAgentSendFailure({ folder, chatId, attemptId, agentId: chatThread?.agentId ?? session.agentId, model: chatThread?.model, error });
        return;
      }
      toast.error("Message wasn't sent", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      sendInFlightRef.current = false;
    }
  };

  /** Leave queued-edit mode. Restores the stashed pre-edit draft, releases
   *  the provider-side queue hold, and hands focus back to the composer. */
  const exitQueuedEdit = (releaseQueue = true) => {
    if (editingQueuedRef.current == null) return;
    queueEditGenerationRef.current++;
    editingQueuedRef.current = null;
    setEditingQueuedId(null);
    setQueueSelectedId(null);
    setComposerContent(
      queueStashRef.current ?? { json: null, attachments: [] },
    );
    queueStashRef.current = null;
    if (releaseQueue) session.releaseQueue?.();
    // setContent doesn't emit an editor change — re-sync the live draft to
    // the restored content explicitly.
    updateLiveDraftRef.current();
    if (interactive) queueMicrotask(() => focusComposer());
  };

  /** Load a queued message into the composer for editing. Stash the current
   *  draft and hold the queue so a settling turn cannot flush the target. */
  const startQueuedEdit = (id: string) => {
    const target = queuedMessages.find((m) => m.id === id);
    if (!target || target.queuedEditable === false || target.queuedDelivery) return;
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
    queueEditGenerationRef.current++;
    editingQueuedRef.current = id;
    setEditingQueuedId(id);
    setQueueSelectedId(id);
    setQueueCollapsed(false);
    setComposerContent(
      (cloudComputerV2 && isCloudWorkspace(chatThread?.folder) ? session.getQueuedDraft?.(id) : undefined) ?? messageToEditorContent({
        text: target.text,
        segments: target.segments,
        attachments: target.attachments,
      }),
    );
    queueMicrotask(() => focusComposer());
  };

  /** Save the composer back onto the queued entry through the same pipeline as a
   *  send, so nothing degrades through an edit. */
  const saveQueuedEdit = async (releaseQueue = true): Promise<boolean> => {
    const id = editingQueuedRef.current;
    if (!id || queueSaveInFlightRef.current) return false;
    const generation = queueEditGenerationRef.current;
    const s = serializeComposerState();
    const displayText = (s?.displayText ?? "").trim();
    const localAttachments = s?.attachments ?? [];
    const prepareAdditional = cloudComputerV2 && isCloudWorkspace(chatThread?.folder) ? session.getQueuedDraft?.(id)?.prepareAdditional : undefined;
    if (displayText.length === 0 && localAttachments.length === 0 && !prepareAdditional) return false;
    queueSaveInFlightRef.current = true;
    try {
      const wireText = expandMentionsInText(
        displayText,
        browserPickerSelection,
      );
      if (cloudComputerV2 && chatId && s && isCloudWorkspace(chatThread?.folder)) {
        const queued = cloudQueuedPrompt({ cwd: chatThread!.folder, chatId, agentId: session.agentId,
          text: wireText, displayText, snapshot: s, prepareAdditional });
        session.editQueued?.(id, queued);
        exitQueuedEdit(releaseQueue); return true;
      }
      const { blocks, bubbleAttachments, bubbleAttachmentById, skipped } =
        await encodeComposerAttachments(localAttachments);
      // Upload completion belongs to this edit instance and document only.
      // Keep newer typing (or a different/reopened edit) intact, including
      // when this save was initiated by Send now.
      if (
        editingQueuedRef.current !== id ||
        queueEditGenerationRef.current !== generation
      ) return false;
      if (!s || !isSubmittedComposerDocument(s.json, serializeComposerState()?.json)) {
        toast.error("Queued message changed while saving", {
          description: "Your changes are still in the editor. Save again to include them.",
        });
        return false;
      }
      // The queued row renders every segment too, and this is the last moment the
      // user can act on an excluded attachment.
      reportSkippedAttachments(skipped, toast.warning);
      if (skipped.length > 0) return false;
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
    } catch (error) {
      if (cloudComputerV2 && isCloudWorkspace(chatThread?.folder)) {
        notifyAgentSendFailure({ folder: chatThread?.folder, chatId: chatId!, attemptId: id, agentId: session.agentId,
          model: chatThread?.model, error });
        return false;
      }
      toast.error("Queued message wasn't saved", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      queueSaveInFlightRef.current = false;
    }
    exitQueuedEdit(releaseQueue);
    return true;
  };

  const deleteQueued = (id: string) => {
    const idx = queuedMessages.findIndex((m) => m.id === id);
    if (queuedMessages[idx]?.queuedDelivery) return;
    // Remove while the edit hold still owns the queue. Releasing first can
    // dispatch this very message if the running turn finished during editing.
    session.removeQueued?.(id);
    if (editingQueuedRef.current === id) exitQueuedEdit();
    // Deleting the message withdraws the prompt, not its files from the
    // append-only context graph (context-graph-staging.ts). Keep the selection on
    // the neighbouring row so repeated ⌫ walks the list.
    if (queueSelectedRef.current === id) {
      const next =
        queuedMessages[idx + 1]?.id ?? queuedMessages[idx - 1]?.id ?? null;
      setQueueSelectedId(next === id ? null : next);
    }
  };

  /** "Send now": steer the running turn, or flush when idle. An edited row is
   *  saved first, so what is sent is what the composer shows. */
  const sendNowQueued = async (id: string) => {
    if (queuedMessages.find((message) => message.id === id)?.queuedDelivery === "sending") return;
    const wasEditing = editingQueuedRef.current === id;
    if (wasEditing && !(await saveQueuedEdit(false))) return;
    let delivery: Promise<boolean> | undefined;
    try {
      // Select the edited message before releasing the hold, otherwise an
      // idle queue can drain its earlier head (or this row) before Send now.
      delivery = session.steerQueued?.(id);
    } finally {
      if (wasEditing) session.releaseQueue?.();
    }
    const ok = await delivery;
    if (ok === false) {
      toast.error("Couldn't send now", {
        description:
          "The message stays queued. Choose Send now to retry delivery.",
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
      if (selected != null) void sendNowQueued(selected);
      else void handleSend(undefined, {
        followUpBehavior: getFollowUpBehavior() === "queue" ? "steer" : "queue",
      });
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
  releaseQueueRef.current = readOnly ? undefined : session.releaseQueue;
  const exitQueuedEditRef = useRef(exitQueuedEdit);
  exitQueuedEditRef.current = exitQueuedEdit;
  const wasSurfaceActiveRef = useRef(interactive);
  useEffect(() => {
    const wasActive = wasSurfaceActiveRef.current;
    wasSurfaceActiveRef.current = interactive;
    // Intent pre-rendering mounts a chat inactive. Only a real visible→parked
    // transition owns queue release/draft persistence; otherwise a hover would
    // publish a redundant global store write before the user even selects it.
    if (interactive || !wasActive) return;
    if (editingQueuedRef.current != null) exitQueuedEditRef.current();
    else releaseQueueRef.current?.();
    // exitQueuedEdit restores the pre-edit stash synchronously; persist only
    // afterward so a parked chat can never save queued-message text as its
    // ordinary composer draft.
    persistComposerDraft();
  }, [persistComposerDraft, interactive]);
  // Bounded-deck eviction and application shutdown retain the old unmount
  // guarantee as a final idempotent safety net.
  useEffect(() => {
    const editGeneration = queueEditGenerationRef;
    return () => {
      editGeneration.current++;
      releaseQueueRef.current?.();
    };
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

  // InlineEdit, the feedback pill and the empty-state composer send through this
  // chat once its session is ready.
  const pendingSub = pendingChatSubmission;
  useEffect(() => {
    if (!interactive) return;
    if (!pendingSub) return;
    if (!chatId) return;
    // The store routes by activeChatId at enqueue time; this guard stops a double
    // send if two chats are ever mounted together.
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
    interactive,
    // Re-arm once a send that was being prepared has finished, so a submission
    // that arrived during that window still goes out.
    sendPreparing,
  ]);

  // If a user queues a first turn and then deliberately clears the composer
  // before setup finishes, cancel that exact intent. The "seen content" latch
  // avoids mistaking the editor's initial seed tick for a user clear.
  const queuedContentSeenRef = useRef(false);
  useEffect(() => {
    if (readOnly || !chatId || !pendingAutoSend) {
      queuedContentSeenRef.current = false;
      return;
    }
    if (composerHasContent) {
      queuedContentSeenRef.current = true;
      return;
    }
    if (queuedContentSeenRef.current) {
      dispatch({ type: "CONSUME_AUTO_SEND", chatId });
      queuedContentSeenRef.current = false;
    }
  }, [chatId, composerHasContent, dispatch, pendingAutoSend, readOnly]);

  // A dispatcher-seeded or typed first message waits for checkout. Once the exact
  // lifecycle publishes and this chat's session is ready, submit its own rich
  // document, independent of the current route; the exact id stops another pane
  // from consuming it. Also the park's release site (queuedFirstTurnAction): a
  // terminal spawn or an overlong wait hands the message back and says so.
  useEffect(() => {
    if (readOnly || !chatId || pendingAutoSendAt === null) return;
    const decide = (): "wait" | "send" | "release" =>
      queuedFirstTurnAction({
        status: session.status,
        provisioning: workspaceProvisioning,
        hasPermissionGate: !!session.pendingPermission,
        composerEmpty: !composerHasContent,
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
    readOnly,
    pendingAutoSendAt,
    workspaceProvisioning,
    session.status,
    session.pendingPermission,
    chatId,
    composerHasContent,
    sendPreparing,
  ]);

  // ⌥+click in the browser element picker appends context without sending.
  const pendingAppend = pendingComposerAppend;
  useEffect(() => {
    if (readOnly || !pendingAppend) return;
    if (!chatId) return;
    // Append only targets this chat. (chatId null = EmptyComposer
    // case, handled separately in EmptyComposer.tsx.)
    if (pendingAppend.chatId !== chatId) return;
    appendComposerText(`\n\n${pendingAppend.text}`);
    dispatch({ type: "CONSUME_COMPOSER_APPEND", id: pendingAppend.id });
    if (interactive) queueMicrotask(() => focusComposer());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAppend, chatId, interactive, readOnly]);

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
  const handleFileInput = async (files: FileList | null) => {
    await addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Everything below stays equal while the live turn streams, so React skips
  // every settled turn (transcript-turn.tsx). Tail-only state reaches only the
  // visual tail.
  const retryTurnThroughRef = useLatestCallback(retryTurn);
  const warmRetryTranscriptThroughRef = useLatestCallback(
    (prompt: AgentTextMessage, events: AgentMessage[]) => {
      if (chatThread) warmRetryTranscript(chatThread, prompt, events);
    },
  );
  const continueTurnThroughRef = useLatestCallback(() => {
    void handleSend("Continue");
  });
  const forkToNewTabThroughRef = useLatestCallback(forkToNewTab);
  const warmForkToNewTabThroughRef = useLatestCallback(warmForkToNewTab);
  const signInThroughRef = useLatestCallback(handleSignIn);
  const stopWorkflow = session.stopBackgroundTask;
  const transcriptActions = useMemo<TranscriptTurnActions>(
    () => ({
      editAndResubmit: editAndResubmitThroughRef,
      retryTurn: retryTurnThroughRef,
      warmRetryTranscript: warmRetryTranscriptThroughRef,
      continueTurn: continueTurnThroughRef,
      forkToNewTab: forkToNewTabThroughRef,
      warmForkToNewTab: warmForkToNewTabThroughRef,
      signIn: signInThroughRef,
      stopWorkflow,
    }),
    [
      editAndResubmitThroughRef,
      retryTurnThroughRef,
      warmRetryTranscriptThroughRef,
      continueTurnThroughRef,
      forkToNewTabThroughRef,
      warmForkToNewTabThroughRef,
      signInThroughRef,
      stopWorkflow,
    ],
  );
  const transcriptFolder = chatThread?.folder ?? session.cwd;
  const transcriptAgentName =
    session.agentName ?? chatThread?.agentName ?? signInAgentId ?? "Agent";
  const transcriptHasChatThread = !!chatThread;
  const transcriptDesignRole = session.agentRole === "design";
  const transcriptShared = useMemo<TranscriptTurnShared>(
    () => ({
      chatId,
      folder: transcriptFolder,
      agentDisplayName: transcriptAgentName,
      signInAgentId,
      surfaceActive,
      deferContent: provisionalTranscript,
      scrollRoot: scrollEl,
      readOnly,
      transcriptReadOnly,
      interactive,
      hasChatThread: transcriptHasChatThread,
      designRole: transcriptDesignRole,
      setEditingMessageId,
      setActivePromptEl,
      ctx: transcriptCtx,
      actions: transcriptActions,
    }),
    [
      chatId,
      transcriptFolder,
      transcriptAgentName,
      signInAgentId,
      surfaceActive,
      provisionalTranscript,
      scrollEl,
      readOnly,
      transcriptReadOnly,
      interactive,
      transcriptHasChatThread,
      transcriptDesignRole,
      setEditingMessageId,
      setActivePromptEl,
      transcriptCtx,
      transcriptActions,
    ],
  );
  const tailBackgroundStartedAt =
    session.backgroundActivity?.startedAt ?? session.backgroundTasksWaitingSince;
  const tailBackgroundTasks = waitingForBackgroundTasks ? session.backgroundTasks : undefined;
  const transcriptTail = useMemo<TranscriptTurnTail>(
    () => ({
      failure: session.failure,
      failureKind: session.failure?.kind,
      sessionStreaming: session.status === "streaming" && !session.cloudPromptPending,
      lastStopReason: session.lastStopReason,
      activeTurnStartedAt: session.activeTurnStartedAt,
      backgroundContinuationActive,
      backgroundStartedAt: tailBackgroundStartedAt,
      backgroundTasks: tailBackgroundTasks,
      workflow: activeWorkflow,
    }),
    [
      session.failure,
      session.status,
      session.cloudPromptPending,
      session.lastStopReason,
      session.activeTurnStartedAt,
      backgroundContinuationActive,
      tailBackgroundStartedAt,
      tailBackgroundTasks,
      activeWorkflow,
    ],
  );


  return (
    <div
      // Runtime-generated markdown and scrollbars require this style scope.
      // Own it here so saved history matches chats mounted through ChatDeck.
      data-zeros-root=""
      className="zeros-agent-surface text-fg1 [container-type:inline-size] flex h-full min-h-0 flex-col bg-transparent text-sm [container-name:agent-chat]"
    >
      {/* The Conversation pane passes headerActions (even an empty fragment) and
          hides this header; the legacy agent-mode surface keeps it. */}
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

      {/* max-w-[856px] is the chat's single width: an 800px column inside px-7
          gutters, shared with the composer and the read-only history bar. It is a
          maximum, so narrower panes shrink without fixed gutters. */}
      {/* Keeps the top mask outside the scroller, pinned to the viewport top. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Conversation
          ref={setScrollContainer}
          data-agent-diff-collision-boundary=""
          className="zeros-agent-body zeros-agent-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-transparent"
          style={{ position: "relative" }}
        >
          <ConversationContent
            // flex-none matters: ConversationContent's flex-1 would pin this box to the
            // scroller's height, so pb-8 would never reach the real bottom. pt-3 matches
            // the sticky prompt's top-3; px-7 clears the checkpoint rail. Mirror any change
            // on the composer column.
            className="zeros-agent-messages mx-auto flex w-full max-w-[856px] min-w-0 flex-none flex-col gap-5 overflow-visible px-7 pt-3 pb-8"
          >
            {/* Older history auto-pages in via the nearTop effect above, with
              no visible affordance: scrolling back should show everything. */}
            {transcriptLoadingVisible && (
              <div className="text-muted-fg flex items-center gap-2 py-2 text-xs">
                <ZerosSpinner
                  size={14}
                  label="Loading conversation"
                  className="shrink-0"
                />
                <span aria-hidden="true">Loading conversation…</span>
              </div>
            )}
            {transcriptHistoryStatus === "waiting" && (
              <div role="status" aria-label="Waiting for conversation" className="text-fg3 py-2 text-xs">
                Loading conversation…
              </div>
            )}
            {transcriptHistoryStatus === "unavailable" && (
              <div role="status" aria-label="Chat history unavailable" className="text-fg3 flex items-center gap-2 py-2 text-xs">
                <span>Chat history isn’t available yet.</span>
                <Button variant="ghost" size="sm" onClick={() => { void session.hydrateChat().catch(() => {}); }}>
                  Retry
                </Button>
              </div>
            )}
            {/* Describes the workspace, not the session, so it is not gated on status
                and a respawn cannot make it blink. Hidden on error. */}
            {readOnly &&
              session.transcriptState === "resident" &&
              session.messages.length === 0 && (
                <p className="text-fg2 text-sm">No chat history.</p>
              )}
            {!readOnly &&
              emptyStateReady &&
              session.messages.length === 0 &&
              !session.error && (
                <ChatProvenance
                  folder={chatThread?.folder}
                  hasTranscripts={hasTranscripts}
                >
                  {/* The transcript pills replace the workspace rows when a transcript is on
                      offer (provenanceBlockShape), and disappear after the first send. */}
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
              const receipt = cloudPromptTurnActivity(session, turns, i);
              // One answer for the shimmer AND the footer (see tailTurnInFlight):
              // they are two halves of the same claim, and computing them apart
              // is what let a reopened chat show the working shimmer while
              // hiding this turn's own STOPPED BY USER pill.
              const turnIsPendingLocal =
                !!turn.userPrompt && pendingLocalTurnId === turn.userPrompt.id;
              const editing = !!turn.userPrompt && turn.userPrompt.id === editingMessageId;
              return (
                <TranscriptTurn
                  key={turnKey(turn)}
                  turn={turn}
                  threadTailKey={turns.length ? turnKey(turns[turns.length - 1]) : null}
                  isVisualTail={isVisualTail}
                  isActiveProviderSegment={receipt.active}
                  isActivityTail={receipt.activityTail}
                  durablePrompt={receipt.durable}
                  receiptState={receipt.state}
                  presentation={receipt.presentation}
                  startedAt={receipt.startedAt}
                  ownsProviderFooter={isProviderTurnTail(turns, i)}
                  turnIsPendingLocal={turnIsPendingLocal}
                  turnInFlight={tailTurnInFlight({
                    sessionStreaming: isStreaming && (!session.cloudOutbox || receipt.active),
                    pendingLocalTurn: turnIsPendingLocal,
                    hasEvents: turn.events.length > 0,
                  })}
                  recovered={authenticationRecoveredAt > i}
                  initialContent={initialCachedTurnIndex >= 0 ? Math.abs(i - initialCachedTurnIndex) <= 4 : i >= turns.length - 6}
                  editing={editing}
                  editToolbarPills={editing ? editToolbarPills : undefined}
                  editAgentContext={
                    editing && chatThread
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
                  shared={transcriptShared}
                  tail={receipt.current ? transcriptTail : null}
                />
              );
            })}
            {!readOnly && isCloudWorkspace(session.cwd) && (session.cloudStop?.state === "unconfirmed" || session.cloudStop?.state === "failed") && (
              <AgentNotice
                data-cloud-stop-notice
                message={session.cloudStop.state === "failed" ? "Stop was refused. Try Stop again." : "Stop could not be confirmed. Reconnect to check this turn."}
              >
                <div className="mt-1">
                  <Button type="button" variant="ghost" size="sm" className={AGENT_NOTICE_ACTION}
                    disabled={!interactive} onClick={() => { void session.cancel(); }}>
                    Retry Stop
                  </Button>
                </div>
              </AgentNotice>
            )}
            {preparationFailure && (
              <AgentNotice
                data-agent-preparation-notice
                message={preparationFailure.advice ?? preparationFailure.message}
              />
            )}
            {/* -mt-5 cancels the column's gap-5 so the spacer adds exactly its height
                to scrollHeight, which the rail's reach math assumes. */}
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
        {/* Stable top fade under the chat strip, present from the first paint so a
            restore never pops it in; it never takes clicks. */}
        <div
          aria-hidden="true"
          // h-6 (24px) keeps it subtle — about one line. The via stop feathers
          // the lower edge so it dissolves without a visible seam.
          className="pointer-events-none absolute inset-x-0 top-0 z-[6] h-6 bg-gradient-to-b from-(--pane-bg) via-(--pane-bg)/40 to-transparent"
        />
        {/* A sibling of the scroller so the rail stays pinned; z-[8] paints above
            the top mask. */}
        <CheckpointRail
          active={surfaceActive}
          scrollEl={scrollEl}
          checkpoints={checkpoints}
          bottomSpacerPx={checkpointSpacerPx}
          onBottomSpacerChange={setCheckpointSpacerPx}
          recomputeRef={checkpointRecomputeRef}
          navigateRef={checkpointNavigateRef}
        />
      </div>

      {/* relative so JumpPills anchors to the composer's top edge, outside the
          scroll container. */}
      <div className="relative shrink-0">
        <JumpToLatestButton
          isAtBottom={isAtBottom}
          jumpToBottom={jumpToBottom}
        />
        {/* max-w-[856px] stays in lock-step with the transcript band above. */}
        {readOnly ? composerReplacement : (
        <div className="mx-auto box-border flex w-full max-w-[856px] min-w-0 shrink-0 flex-col gap-0.5 border-t-0 bg-transparent px-7 pt-0 pb-4">
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
          {goalsAvailable && <GoalCard
            goal={session.goal}
            editing={goalEditorOpen}
            onEditingChange={setGoalEditorOpen}
            onSave={saveGoal}
            onStatus={setGoalStatus}
            onDelete={deleteGoal}
          />}
          {/* Sends typed mid-turn dock here as a card above the permission or
              question card. ↑ from the composer walks the list. */}
          <QueuedMessagesCard
            messages={queuedMessages}
            selectedId={queueSelectedId}
            editingId={editingQueuedId}
            collapsed={queueCollapsed}
            onToggleCollapsed={() => setQueueCollapsed((c) => !c)}
            onSelect={setQueueSelectedId}
            onEdit={startQueuedEdit}
            onSaveEdit={() => void saveQueuedEdit()}
            saveDisabled={!queuedEditHasContent}
            onDelete={deleteQueued}
            onSendNow={(id) => void sendNowQueued(id)}
            steeringSupported={steeringSupported}
            streaming={composerStreaming}
            paused={session.queuePaused}
            waiting={isCloudWorkspace(session.cwd) && (session.cloudSendWait?.state === "waiting" || session.cloudPromptPending || queuedMessages.some(message => message.queuedDelivery === "sending"))}
            notSent={isCloudWorkspace(session.cwd) && session.cloudSendWait?.state === "failed"}
            statusMessage={isCloudWorkspace(session.cwd) ? session.cloudSendWait?.state === "failed"
              ? session.cloudSendWait.message
              : session.cloudSendWait?.phase === "starting-workspace" ? "Starting workspace…" : undefined : undefined}
            statusStartedAt={isCloudWorkspace(session.cwd) && session.cloudSendWait?.state === "waiting" && session.cloudSendWait.phase === "starting-workspace"
              ? session.cloudSendWait.startedAt : undefined}
            active={surfaceActive}
            onStop={interactive && !readOnly && isCloudWorkspace(session.cwd) &&
                (session.cloudSendWait?.state === "waiting" || session.cloudPromptPending || queuedMessages.some(message => message.queuedDelivery === "sending"))
              ? () => { void session.cancel(); } : undefined}
            agentName={steeringAgentName}
          />
          {/* The only permission gate: it docks above the still-usable composer.
              Claude's plan review is not a gate and uses PlanReviewCard. */}
          {permissionCardActive && permissionRequest && (
            <PermissionCard
              request={permissionRequest}
              onRespond={respondToVisiblePermission}
              onRecordPolicy={recordPolicy}
              chatId={chatId}
              cwd={session.cwd ?? chatThread?.folder ?? null}
            />
          )}
          {/* Shared question card. Blocking asks resolve a parked turn;
            optional answers follow the ordinary prompt/steering path. */}
          {questionCardActive && pendingQuestion && (
            <QuestionCard
              key={pendingQuestion.questionId}
              request={pendingQuestion.request}
              onRespond={(response) => session.respondToQuestion(response)}
            />
          )}
          {/* Plan review (Claude's ExitPlanMode): a standalone card above the
            still-live composer. Approve allows the gate + exits
            Plan mode; typing a follow-up below refines the plan (see
            handleSend's plan-review branch). */}
          {planReview && !nativePermissionCardActive && (
            <PlanReviewCard
              planText={readPlan(planReview.request.toolCall.rawInput)}
              onApprove={approvePlan}
              onReject={denyPlanReview}
            />
          )}
          {/* Provider (not a DOM wrapper): tells popover-bearing pills inside
            the card (ModelPill) to close while the composer is concealed —
            their portaled content would otherwise strand at the viewport
            origin once this card goes display:none. */}
          <ComposerConcealedContext.Provider value={composerConcealed}>
            <div
              ref={composerCardRef}
              className={cn(
                "border-border1 bg-bg2 focus-within:border-border2 relative flex w-full min-w-0 flex-col border px-3.5 py-3 shadow-xs transition-[border-color,background,box-shadow] duration-150 ease-out",
                COMPOSER_SURFACE_RADIUS,
                // Drag border: subtle (border2), not near-white --highlighted-bright; `!`
                // beats the higher-specificity focus-within:border-border2 so the drag
                // state looks identical whether or not the composer is focused.
                dragActive &&
                  "!border-border2 ring-highlighted-bright/30 border-dashed ring-2",
                // Guarded modes (Claude Plan / Codex Ask / Cursor Ask): hide the
                // solid border; the SVG dotted frame below provides the visible
                // edge (spaced round dots, --border4).
                composerGuarded && !dragActive && "!border-transparent",
                // Hidden only while the chat isn't interactive; cards dock
                // above it instead. hidden (not unmount) so the typed draft +
                // attachments survive.
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
                  className={cn(
                    "bg-bg3/75 text-fg2 pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-1.5 p-3 text-xs",
                    // Tracks the card's corners so the drop veil doesn't square
                    // off inside them.
                    COMPOSER_SURFACE_RADIUS,
                  )}
                  aria-hidden="true"
                >
                  <Upload size={20} />
                  <span>Drop files to attach</span>
                </div>
              )}
              <PromptInput
                onSubmit={(e) => {
                  e.preventDefault();
                  // During plan review the button sends a follow-up; otherwise submitting
                  // mid-stream cancels the turn. Enter goes through the editor keymap, so this
                  // is only the visible button.
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
                        onClick={() => exitQueuedEdit()}
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
                  {composerEditorContent}
                  {!editingQueuedId && designFrameContext.selection && (
                    <div className="flex min-w-0 items-center py-1">
                      <ComposerDesignFrame selection={designFrameContext.selection} onRemove={designFrameContext.remove} onToggleScreenshot={designFrameContext.toggleScreenshot} />
                    </div>
                  )}
                  <PromptInputToolbar
                    data-permission-feedback-boundary=""
                    className="min-w-0 flex-nowrap gap-1.5 pt-1 pr-0 pb-1 pl-0"
                  >
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
                        onDesign={chatId && capabilitiesBridge && !isCloudWorkspace(chatThread?.folder ?? session.cwd) ? enterDesignMode : undefined}
                        designSelected={chatThread?.composerMode === "design"}
                      />
                      {chatThread?.composerMode === "design" && <ComposerDesignTag onRemove={leaveDesignMode} />}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={COMPOSER_FILE_ACCEPT}
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => void handleFileInput(e.target.files)}
                      />
                      {editToolbarPills}
                      {workspacePreviewAvailable(chatFolder ?? "") && (!isCloudWorkspace(chatFolder) || cloudPreviewsActive) && <BoundaryPortsPill
                        snapshot={session.boundaryPorts}
                        onOpenPort={openBoundaryPreview}
                        onIntent={warmBoundaryPreview}
                      />}
                    </PromptInputTools>
                    <div
                      data-composer-toolbar-actions=""
                      className="flex shrink-0 items-center gap-1.5"
                    >
                      {/* Always present: an empty ring before the first turn, and a disabled ring
                          for Cursor, whose SDK reports no context fill. */}
                      <ComposerTools
                        ownerId={chatId}
                        cloudWorkspace={isCloudWorkspace(chatThread?.folder)}
                        agentId={session.agentId ?? chatThread?.agentId ?? null}
                        sessionId={session.executionId}
                        workspaceId={session.cwd ?? chatThread?.folder ?? null}
                        concealed={composerConcealed || !surfaceActive}
                        onPrepare={prepareSessionTools}
                        preparing={
                          workspaceProvisioning || session.status === "warming"
                        }
                        preparationError={
                          session.status === "auth-required"
                            ? "Sign in to this agent in Settings, then refresh tools."
                            : session.status === "failed"
                              ? "The agent could not start. Refresh tools to retry."
                              : undefined
                        }
                      />
                      <ContextGauge
                        usage={session.usage}
                        unavailableReason={contextUnavailableReason}
                        onCompactNow={
                          supportsCompactNow ? handleCompactNow : undefined
                        }
                        compactDisabled={composerStreaming || !canSend}
                      />
                      {/* Send when ready, Stop while streaming: onSubmit cancels a running turn. */}
                      <PromptInputSubmit
                        aria-label={
                          composerStreaming
                            ? "Stop agent"
                            : editingQueuedId
                              ? "Save message"
                              : sendPreparing
                                ? "Submitting"
                                : "Send message"
                        }
                        aria-keyshortcuts={
                          composerStreaming || sendPreparing ? undefined : "Enter"
                        }
                        // submitted: parked on a cold read or a rebuild with the text still in the
                        // composer. Without the spinner the button looked dead and people kept
                        // pressing Enter.
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
                                ? !queuedEditHasContent
                                : !canSend
                        }
                        className="disabled:bg-bg2-hover disabled:text-fg2 aria-disabled:bg-bg2-hover aria-disabled:text-fg2 size-8 disabled:opacity-100"
                      >
                        {composerStreaming ? (
                          <Square className="size-3" />
                        ) : undefined}
                      </PromptInputSubmit>
                      {/* Queued-edit save tick — sits beside Stop while the
                    agent runs (the screenshot-spec layout), so saving the
                    edit and stopping the turn stay separate, unambiguous
                    targets. When idle the main submit doubles as Save; the
                    tick stays for a consistent affordance. */}
                      {editingQueuedId && (
                        <Button
                          type="button"
                          onClick={() => void saveQueuedEdit()}
                          disabled={!queuedEditHasContent}
                          aria-label="Save queued message"
                          aria-keyshortcuts="Enter"
                          className="disabled:bg-bg2-hover disabled:text-fg2 size-8 shrink-0 rounded-sm p-0 disabled:opacity-100"
                        >
                          <Check className="size-4" />
                        </Button>
                      )}
                    </div>
                  </PromptInputToolbar>
                </PromptInputBody>
              </PromptInput>
            </div>
          </ComposerConcealedContext.Provider>
          {/* Keeps the same height as EmptyComposer's toolbar so the chrome doesn't
              jump between them. */}
        </div>
        )}
      </div>
      {imagePreviewOverlay}

      {!readOnly && chatThread && (
        <WorkspaceDirectoryPicker
          open={workspacePickerOpen}
          onOpenChange={setWorkspacePickerOpen}
          linkedDirs={chatThread.additionalDirectories ?? []}
          cwd={chatThread.folder}
          onLink={linkDirectory}
          onUnlink={removeDirectory}
        />
      )}
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
