// ──────────────────────────────────────────────────────────
// TranscriptTurn — one memoized transcript turn
// ──────────────────────────────────────────────────────────
//
// AgentChat re-renders on every streamed chunk of its live turn. Each turn
// used to be rendered inline with a new render function, new edit/retry/fork
// closures and a new footer element, so React re-rendered every turn of the
// transcript for every chunk: work and garbage that grew with the length of
// the conversation. A settled turn now receives only values that stay equal
// while another turn streams (the turn object, booleans, the shared props
// object and its stable callbacks); everything that belongs to the live tail
// travels in `tail`, which is null for every other turn.
// ──────────────────────────────────────────────────────────

import React, { memo, useCallback, useMemo } from "react";
import type { AgentFailure } from "../../platform/bridge/failure";
import type { BackgroundTask, WorkflowProgress } from "../../platform/bridge/agent-events";
import { AuthenticationNotice } from "./authentication-notice";
import {
  authenticationFailureMessage,
  authenticationTurnOutput,
  authenticationTurnState,
} from "./auth-prompt-recovery";
import { cloudAdmissionForTurn } from "./cloud-admission-failure";
import type { ComposerAttachment } from "./composer-attachments";
import type { ComposerSegment } from "./composer-editor";
import { pickStartedAt } from "./activity-hud";
import { MessageView, type RendererContext } from "./renderers";
import { TurnContainer, TurnPromptHeader, type EditAgentContext } from "./turn-container";
import { TurnEventList } from "./turn-event-list";
import { TurnFooter, turnFooterFailureLabel } from "./turn-footer";
import type { Turn } from "./turn-grouping";
import type { AgentMessage, AgentSessionState, AgentTextMessage } from "./use-agent-session";

const NO_EVENTS: AgentMessage[] = [];

/** Handlers shared by every turn. Their identities must not change while the
 *  conversation streams; AgentChat routes each through its newest closure. */
export interface TranscriptTurnActions {
  editAndResubmit: (
    messageId: string,
    editedText: string,
    attachments: ComposerAttachment[],
    segments?: ComposerSegment[],
  ) => void | boolean | Promise<void | boolean>;
  retryTurn: (prompt: AgentTextMessage, events: AgentMessage[], newChat: boolean) => Promise<void>;
  warmRetryTranscript: (prompt: AgentTextMessage, events: AgentMessage[]) => void;
  continueTurn: () => void;
  forkToNewTab: (messageId: string, text: string, nativeFork: boolean) => void;
  warmForkToNewTab: (messageId: string, text: string) => void;
  signIn: () => void;
  stopWorkflow?: (taskId: string) => void;
}

/** Values every turn reads that change only with the chat, its mode or its
 *  surfacing — never with a streamed chunk. */
export interface TranscriptTurnShared {
  chatId: string | null | undefined;
  folder: string | null | undefined;
  footerAgentId: string | null | undefined;
  agentDisplayName: string;
  signInAgentId: string | null;
  cloudAdmissionFailure: AgentSessionState["cloudAdmissionFailure"];
  surfaceActive: boolean;
  deferContent: boolean;
  scrollRoot: HTMLElement | null;
  readOnly: boolean;
  transcriptReadOnly: boolean;
  interactive: boolean;
  hasChatThread: boolean;
  designRole: boolean;
  /** Codex in a cloud workspace whose runtime can fork natively. */
  nativeFork: boolean;
  setEditingMessageId: (id: string | null) => void;
  setActivePromptEl: (element: HTMLDivElement | null) => void;
  /** Renderer context without per-message streaming fields; TurnEventList
   *  derives isStreaming/lastMessageId for its own turn. */
  ctx: RendererContext;
  actions: TranscriptTurnActions;
}

/** Session state only the visual tail turn presents. */
export interface TranscriptTurnTail {
  failure: AgentFailure | null;
  failureKind: string | undefined;
  sessionStreaming: boolean;
  lastStopReason: AgentSessionState["lastStopReason"];
  activeTurnStartedAt: number | null;
  backgroundContinuationActive: boolean;
  backgroundStartedAt: number | null | undefined;
  backgroundTasks: BackgroundTask[] | undefined;
  workflow: WorkflowProgress | null;
}

export interface TranscriptTurnProps {
  turn: Turn;
  isVisualTail: boolean;
  isActiveProviderSegment: boolean;
  ownsProviderFooter: boolean;
  turnIsPendingLocal: boolean;
  turnInFlight: boolean;
  recovered: boolean;
  initialContent: boolean;
  /** This turn's prompt is open in the edit composer. The toolbar pills and
   *  agent context are only read while editing, so other turns receive none
   *  and stay equal as the chat re-renders. */
  editing: boolean;
  editToolbarPills?: React.ReactNode;
  editAgentContext?: EditAgentContext;
  shared: TranscriptTurnShared;
  tail: TranscriptTurnTail | null;
}

export const TranscriptTurn = memo(function TranscriptTurn({
  turn,
  isVisualTail,
  isActiveProviderSegment,
  ownsProviderFooter,
  turnIsPendingLocal,
  turnInFlight,
  recovered,
  initialContent,
  editing,
  editToolbarPills,
  editAgentContext,
  shared,
  tail,
}: TranscriptTurnProps) {
  const { actions, ctx } = shared;
  const prompt = turn.userPrompt;
  const cloudAdmission = useMemo(
    () =>
      cloudAdmissionForTurn({
        folder: shared.folder,
        turnId: prompt?.id,
        recoveryFailure: prompt?.recoveryFailure,
        current: shared.cloudAdmissionFailure,
        agentId: shared.signInAgentId,
      }),
    [shared.folder, prompt, shared.cloudAdmissionFailure, shared.signInAgentId],
  );
  const authState = cloudAdmission
    ? null
    : authenticationTurnState({
        userPrompt: prompt,
        events: turn.events,
        failureKind: tail?.failureKind,
        isTail: isVisualTail,
        inFlight: turnInFlight,
        recovered,
        readOnly: shared.transcriptReadOnly,
      });
  const authRequired = !shared.transcriptReadOnly && authState === "sign-in";
  const authStopped = authState === "stopped" || authState === "signed-in";
  const visibleEvents = useMemo(
    () => (cloudAdmission ? NO_EVENTS : authState ? authenticationTurnOutput(turn.events) : turn.events),
    [cloudAdmission, authState, turn.events],
  );

  const promptId = prompt?.id;
  const promptText = prompt?.text;
  const editable =
    !!prompt &&
    !(shared.transcriptReadOnly || prompt.autoAction || prompt.localFrom || prompt.queued || turn.isSteer);
  const onEdit = useCallback(
    (editedText: string, attachments: ComposerAttachment[], segments: ComposerSegment[]) =>
      actions.editAndResubmit(promptId!, editedText, attachments, segments),
    [actions, promptId],
  );
  const providerEvents = turn.providerEvents;
  const warmRetry = useCallback(
    () => actions.warmRetryTranscript(prompt!, providerEvents),
    [actions, prompt, providerEvents],
  );
  const retry = useCallback(
    () => actions.retryTurn(prompt!, providerEvents, false),
    [actions, prompt, providerEvents],
  );
  const retryNewChat = useCallback(
    () => actions.retryTurn(prompt!, providerEvents, true),
    [actions, prompt, providerEvents],
  );
  const nativeFork = shared.nativeFork && isVisualTail;
  const fork = useCallback(
    () => actions.forkToNewTab(promptId!, promptText!, nativeFork),
    [actions, promptId, promptText, nativeFork],
  );
  const forkIntent = useCallback(
    () => actions.warmForkToNewTab(promptId!, promptText!),
    [actions, promptId, promptText],
  );
  const retryable = shared.interactive && !!prompt && !prompt.localFrom;

  return (
    <TurnContainer
      turn={turn}
      isActive={isVisualTail}
      deferContent={shared.deferContent}
      surfaceActive={shared.surfaceActive}
      scrollRoot={shared.scrollRoot}
      initialContent={initialContent}
    >
      {() => (
        <>
          {/* Follow-up queue rows do not render here. A first prompt
              awaiting only provider admission does: it is already
              presented as this active turn, before wire dispatch. */}
          {prompt && (
            // Every turn's user prompt is sticky: as the user scrolls up
            // through history each turn's prompt pins until the next turn's
            // prompt arrives at the top and pushes it off.
            //
            // Click-to-edit is enabled for ALL turns including the active one
            // ("regenerate this prompt with a tweak"). For the active turn,
            // editAndResubmit cancels the in-flight stream before truncating
            // and resending. Auto-sent messages are copy-only because their
            // short label cannot round-trip. Mid-turn steers are also
            // copy-only: their reset boundary is the opening provider prompt,
            // not the steer message id.
            <TurnPromptHeader
              chatId={shared.chatId ?? undefined}
              messageId={prompt.id}
              createdAt={prompt.createdAt}
              // The keep-alive deck keeps hidden chats mounted, so the
              // prompt's "More"-expanded state needs the surfacing signal to
              // collapse on tab switch.
              surfaceActive={shared.surfaceActive}
              editingMessageId={editing ? prompt.id : null}
              onRequestEdit={shared.setEditingMessageId}
              originalText={prompt.text}
              originalAttachments={prompt.attachments}
              originalSegments={prompt.segments}
              autoAction={prompt.autoAction}
              localFrom={prompt.localFrom}
              onEdit={editable ? onEdit : undefined}
              editToolbarPills={editToolbarPills}
              editAgentContext={editAgentContext}
            >
              <div ref={isVisualTail ? shared.setActivePromptEl : null}>
                {/* The user prompt renders as a right-aligned, fit-to-content
                    bubble. TurnPromptHeader paints the bubble chrome and the
                    hover edit/copy/age row; the inner TextMessage contributes
                    just the text. */}
                <MessageView message={prompt} ctx={ctx} />
              </div>
            </TurnPromptHeader>
          )}
          {/* Per-turn footer (run time, copy output, "…" Reset to this point,
              authored file pills) renders INSIDE TurnEventList's 800 lane so
              it hugs the answer. A turn counts as IN FLIGHT while streaming,
              and also while THIS renderer's own send for it is still pending
              session (re)creation; keyed on the pending TURN, never on
              session status. */}
          {(!authRequired || visibleEvents.length > 0) && (
            <TurnEventList
              events={visibleEvents}
              usageEvents={ownsProviderFooter ? turn.providerEvents : null}
              failureTurnId={!cloudAdmission && !authRequired && shared.chatId ? turn.recordedTurnId ?? undefined : undefined}
              isActive={isActiveProviderSegment}
              isStreaming={turnInFlight && !authStopped}
              showActivity={isVisualTail}
              backgroundTasks={tail?.backgroundTasks}
              surfaceActive={shared.surfaceActive}
              activityEvents={turn.providerEvents}
              activityStartedAt={pickStartedAt(
                turn.providerEvents,
                turn.recordedStartedAt,
                tail ? tail.activeTurnStartedAt : null,
                tail && tail.backgroundContinuationActive && !turnIsPendingLocal
                  ? tail.backgroundStartedAt
                  : null,
              )}
              workflow={tail?.workflow ?? null}
              onStopWorkflow={shared.transcriptReadOnly ? undefined : actions.stopWorkflow}
              ctx={ctx}
              footer={
                // Cached rows have no native turn/usage authority. Do not
                // mount turn metadata reads or reset/fork controls until the
                // transcript has validated.
                !shared.deferContent &&
                !authState &&
                turn.recordedTurnId &&
                shared.chatId &&
                ownsProviderFooter ? (
                  <TurnFooter
                    folder={shared.folder}
                    agentId={shared.footerAgentId}
                    readOnly={shared.readOnly}
                    surfaceActive={shared.surfaceActive}
                    chatId={shared.chatId}
                    turnId={turn.recordedTurnId}
                    failure={tail?.failure ?? null}
                    recoveryFailure={prompt?.recoveryFailure}
                    onRetryNewChatIntent={retryable && shared.hasChatThread ? warmRetry : undefined}
                    onRetry={retryable && isVisualTail ? retry : undefined}
                    onRetryNewChat={retryable && isVisualTail && !shared.designRole ? retryNewChat : undefined}
                    events={turn.providerEvents}
                    startedAt={turn.recordedStartedAt}
                    live={isVisualTail && turnInFlight}
                    fallbackStopReason={tail && !tail.sessionStreaming ? tail.lastStopReason : null}
                    fallbackStatusLabel={tail && !tail.sessionStreaming ? turnFooterFailureLabel(tail.failure) : null}
                    // "An auto-rebuild is re-running THIS turn": only while
                    // this renderer's own send owns it.
                    retrying={isVisualTail && turnIsPendingLocal}
                    isLastTurn={isVisualTail}
                    // One-click resume after a token-cap / budget stop: the
                    // user typing "Continue" and hitting send.
                    onContinue={actions.continueTurn}
                    onFork={prompt ? fork : undefined}
                    onForkIntent={prompt ? forkIntent : undefined}
                  />
                ) : null
              }
            />
          )}
          {(authRequired || authStopped) && (
            <AuthenticationNotice
              historical={authStopped}
              resolved={authState === "signed-in"}
              message={authenticationFailureMessage(turn.events, tail?.failure ?? null)}
              name={shared.agentDisplayName}
              onSignIn={actions.signIn}
            />
          )}
        </>
      )}
    </TurnContainer>
  );
});
