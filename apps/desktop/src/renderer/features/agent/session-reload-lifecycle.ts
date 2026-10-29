import type { SessionStatus } from "./use-agent-session";
import {
  isRecoverable,
  type AgentFailure,
} from "../../platform/bridge/failure";
import type {
  ProviderBinding,
  ProviderMetadata,
} from "@zeros/protocol/identities";
import type {
  ExecutionBoundaryPortsSnapshot,
  ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";
import type { AgentGoal } from "@zeros/protocol/agent-events";
import type { BrowserRoute } from "@zeros/protocol/browser-tools";
import type { ComputerUseRoute } from "@zeros/protocol/computer-use-tools";
import type { DeviceToolRoute } from "@zeros/protocol/device-tools";

export interface SessionExecutionActor {
  agentRole?: "code" | "design";
  designDocumentId?: string | null;
}

/** Retain the immutable execution actor across renderer-owned rebuilds. An
 * explicit Code admission clears any stale Design document identity. */
export function executionActorForRecovery(
  previous: SessionExecutionActor | null | undefined,
  requested?: SessionExecutionActor | null,
): { agentRole?: "code" | "design"; designDocumentId?: string } {
  const agentRole = requested?.agentRole ?? previous?.agentRole;
  if (agentRole === "design") {
    const designDocumentId =
      requested?.designDocumentId ?? previous?.designDocumentId;
    return {
      agentRole,
      ...(designDocumentId ? { designDocumentId } : {}),
    };
  }
  return agentRole === "code" ? { agentRole } : {};
}

export type CapabilityRefreshFamily = "codex" | "claude" | "cursor";

/** Resolve the exact live route that may be torn down and resumed to pick up a
 * provider boot capability. This is intentionally narrower than ordinary
 * session recovery: only native bindings for the same adapter are safe, since
 * a legacy locator could mint a different conversation. */
export function providerCapabilityRefreshExecution(input: {
  providerFamily: string;
  agentId: string | null;
  executionId?: string | null;
  sessionId?: string | null;
  providerBinding?: ProviderBinding | null;
}): string | null {
  const binding = input.providerBinding;
  if (
    (input.providerFamily !== "codex" &&
      input.providerFamily !== "claude" &&
      input.providerFamily !== "cursor") ||
    !input.agentId ||
    binding?.kind !== "native" ||
    binding.providerId !== input.agentId ||
    !binding.resumeId.trim()
  ) {
    return null;
  }
  return input.executionId ?? input.sessionId ?? null;
}

/** What a change to one agent family's Browser route means for its live
 * sessions. A provider fixes its browser when it boots: Codex loads OpenAI's
 * Browser plugin, Claude Code takes `--chrome` or `--no-chrome`, and every
 * agent lists the `zeros_browser` tools once. Any new route other than "off"
 * therefore needs an idle resume. Zeros refuses an "off" route on each call,
 * so a refresh still queued for that family is moot ("cancel"), except that
 * only a resume removes Claude Code's `--chrome`. */
export function browserRouteRefreshAction(input: {
  providerFamily: CapabilityRefreshFamily;
  previous: BrowserRoute | null;
  next: BrowserRoute;
}): "refresh" | "cancel" | "none" {
  if (input.previous === null || input.previous === input.next) return "none";
  if (input.next !== "off" || input.previous === "claude-chrome") {
    return "refresh";
  }
  return input.providerFamily === "claude" ? "none" : "cancel";
}

/** The same rule for Computer use. `zeros_computer` tools are listed only
 * when a provider boots on the "zeros" route, and Codex keeps or drops its
 * built-in computer use at boot, so every new route other than "off" needs an
 * idle resume. Zeros refuses its own tools per call once the route is "off",
 * but only a resume turns off Codex's built-in computer use. */
export function computerRouteRefreshAction(input: {
  providerFamily: CapabilityRefreshFamily;
  previous: ComputerUseRoute | null;
  next: ComputerUseRoute;
}): "refresh" | "cancel" | "none" {
  if (input.previous === null || input.previous === input.next) return "none";
  if (input.next !== "off" || input.previous === "codex-native") {
    return "refresh";
  }
  return input.providerFamily === "codex" ? "none" : "cancel";
}

/** The same rule for simulators, which every agent family uses alike.
 * `zeros_device` tools are listed only when a provider boots with simulator
 * use on; once it is off Zeros refuses them per call, so no resume is
 * needed. */
export function deviceRouteRefreshAction(input: {
  previous: DeviceToolRoute | null;
  next: DeviceToolRoute;
}): "refresh" | "cancel" | "none" {
  if (input.previous === null || input.previous === input.next) return "none";
  return input.next === "zeros" ? "refresh" : "cancel";
}

/** A queued boot-capability refresh belongs to the provider family that
 * observed the setting edge. If the chat switches agents before it becomes
 * idle, refreshing the replacement provider would apply an unrelated setting
 * and could unnecessarily tear down a newly-created session. */
export function providerCapabilityRefreshStillTargetsFamily(input: {
  requestedFamily: CapabilityRefreshFamily;
  currentFamily: string;
}): boolean {
  return input.requestedFamily === input.currentFamily;
}

/** A boot-capability refresh waits behind every kind of work. Keeping queued
 * sends on the old execution until it is truly idle avoids closing a provider
 * between a user's send and the engine's turn-start acknowledgement. */
export function providerCapabilityRefreshCanRun(input: {
  status: SessionStatus;
  running: boolean;
  queuedCount: number;
}): boolean {
  return input.status === "ready" && !input.running && input.queuedCount === 0;
}

/** Durable locator fields for a load-session recovery request.
 *
 * A failed execution id is intentionally not accepted here: after an engine
 * restart it is neither a live route nor a provider resume handle. The
 * compatibility sessionId, when present, is derived only from the durable
 * provider binding so a protocol-v8 engine can still resume it. With no
 * binding, chatId on the surrounding request performs a conversation-only
 * probe for an execution that survived a renderer reload. */
export function recoveryLoadLocator(
  providerBinding: ProviderBinding | null | undefined,
): { providerBinding?: ProviderBinding; sessionId?: string } {
  if (!providerBinding) return {};
  return {
    providerBinding,
    sessionId: providerBinding.legacySessionId ?? providerBinding.resumeId,
  };
}

/** Identity patch and prompt route produced by a successful recovery load.
 * The engine may mint a replacement execution even though the durable provider
 * conversation stays the same, so all subsequent routing must use the load
 * response rather than the dead execution captured before recovery. */
export function recoveredSessionIdentity(
  loaded: {
    executionId?: string | null;
    sessionId?: string | null;
    response?: {
      providerBinding?: ProviderBinding;
      providerMetadata?: ProviderMetadata;
      boundary?: ExecutionBoundaryStatus;
      boundaryPorts?: ExecutionBoundaryPortsSnapshot;
    };
  },
  previous: {
    providerBinding?: ProviderBinding | null;
    providerMetadata?: ProviderMetadata | null;
  },
): {
  executionId: string;
  sessionId: string;
  providerBinding: ProviderBinding | null;
  providerMetadata: ProviderMetadata | null;
  boundary: ExecutionBoundaryStatus | null;
  boundaryPorts: ExecutionBoundaryPortsSnapshot | null;
} | null {
  const executionId = loaded.executionId ?? loaded.sessionId;
  if (!executionId) return null;
  const providerBinding =
    loaded.response?.providerBinding ?? previous.providerBinding ?? null;
  return {
    executionId,
    sessionId: executionId,
    providerBinding,
    providerMetadata: providerBinding
      ? (loaded.response?.providerMetadata ?? previous.providerMetadata ?? null)
      : null,
    boundary: loaded.response?.boundary ?? null,
    boundaryPorts: loaded.response?.boundaryPorts ?? null,
  };
}

/** The engine survives a local renderer reload. Its prompt activity is the
 * authoritative lifecycle signal; a successfully loaded active session must
 * not be flattened to `ready` merely because the new renderer has no send
 * promise of its own. */
export function loadedSessionStatus(promptActive: boolean): SessionStatus {
  return promptActive ? "streaming" : "ready";
}

/** Token-rate content can wait for the next paint, but the terminal turn state
 * is the commit boundary for the transcript. Flush that notification together
 * with every preceding chunk so React can reveal the complete answer in one
 * render instead of briefly treating a partial buffered message as final. */
export function agentUpdateFlushMode(update: {
  sessionUpdate?: string;
  state?: string;
}): "frame" | "turn-boundary" {
  if (
    update.sessionUpdate === "turn_state" &&
    (update.state === "completed" ||
      update.state === "failed" ||
      update.state === "cancelled")
  ) {
    return "turn-boundary";
  }
  return "frame";
}

/** Decide whether a caller may reuse a matching admission flight. Lazy boot
 * probes deliberately admit nothing when no live execution exists, so a later
 * focus/send request that shared such a flight must immediately perform its
 * real admission after the probe settles. */
export function sharedAdmissionFlightAction(input: {
  activeAdoptOnly: boolean;
  requestedAdoptOnly: boolean;
  hasLiveSession: boolean;
}): "reuse" | "retry" {
  return input.activeAdoptOnly &&
    !input.requestedAdoptOnly &&
    !input.hasLiveSession
    ? "retry"
    : "reuse";
}

/** Choose the provider admission route after no shared flight remains.
 * Cancellation deliberately detaches a load flight without discarding its
 * durable provider binding. Both ordinary admission and forced configuration
 * recovery must therefore resume that binding before either is allowed to
 * create a new provider conversation. Forced recovery first restarts the
 * ephemeral execution so the resumed provider receives the new config. */
export function admissionRouteWithoutFlight(input: {
  force: boolean;
  replaceProviderConversation: boolean;
  hasProviderBinding: boolean;
  canLoad: boolean;
}): "resume" | "restart" | "create" {
  if (!input.hasProviderBinding || !input.canLoad) return "create";
  if (input.force && input.replaceProviderConversation) return "create";
  return input.force ? "restart" : "resume";
}

/** Map a failure to the UI session status. The single definition shared by the
 *  provider's RPC paths and the store's turn-state settle, so they cannot
 *  disagree. */
export function statusForFailure(failure: AgentFailure): SessionStatus {
  if (failure.kind === "auth-required") return "auth-required";
  if (isRecoverable(failure)) return "reconnecting";
  return "failed";
}

/** Prompt dispatch is the one lifecycle stage where a superseded execution is
 * recoverable by the caller. A registered Design-territory handoff revokes the
 * old execution after the renderer has already committed the user's turn; the
 * send path must resume the durable provider conversation and retry that exact
 * prompt. Keep this narrower than isRecoverable: create/load supersession is
 * owned by the bind lifecycle and must never start an independent retry loop. */
export function promptFailureShouldRecover(failure: AgentFailure): boolean {
  return (
    isRecoverable(failure) ||
    (failure.kind === "lifecycle-superseded" && failure.stage === "prompt")
  );
}

/** Whether prompt recovery should first re-adopt the durable provider thread.
 * Session expiry and a territory-revoked execution both invalidate only the
 * ephemeral execution route; resuming before any cold fallback preserves
 * Codex, Claude, and Cursor conversation context across workspace switches. */
export function promptFailureShouldResumeProvider(
  failure: AgentFailure,
): boolean {
  return (
    failure.kind === "session-expired" ||
    (failure.kind === "lifecycle-superseded" && failure.stage === "prompt")
  );
}

/** A create/load that lost the engine's exact-conversation ownership race is
 * already replaced by newer lifecycle work. Match the legacy message too so a
 * current renderer paired with an older protocol-v8 engine does not mistake
 * its old `session-expired` classification for provider-thread deletion. */
export function bindFailureWasSuperseded(
  failure: AgentFailure | null | undefined,
): boolean {
  return (
    failure?.kind === "lifecycle-superseded" ||
    /\bconversation was closed or superseded while its agent session was starting\b/i.test(
      failure?.message ?? "",
    )
  );
}

/** A durable binding is discarded only when the provider says that exact
 * conversation no longer exists. Auth, transport, and timeout failures must
 * retain it so a temporary outage never destroys resumable context. */
export function resumeFailureInvalidatesBinding(
  failure: AgentFailure | null | undefined,
): boolean {
  return (
    failure?.kind === "session-expired" && !bindFailureWasSuperseded(failure)
  );
}

/** How a terminal engine turn_state settles the slot. It arrives for every
 *  turn through the frame buffer, so for a local prompt it lands after
 *  sendPrompt recorded the classified failure. Non-destructive: a recorded
 *  failure wins (clearing it erased why the turn died and the Sign-in
 *  button); a slot with nothing recorded, the re-adopted turn, settles to
 *  ready. */
export function settledTurnStatus(slot: {
  error: string | null;
  failure: AgentFailure | null;
}): SessionStatus {
  if (slot.failure) return statusForFailure(slot.failure);
  return slot.error ? "failed" : "ready";
}

/** Decide whether a send belongs behind an already-owned/incomplete turn.
 * Local refs disappear on reload, so session status is an equal input rather
 * than a secondary check. A queue flush bypasses the gate by construction. */
export function shouldQueuePrompt(input: {
  status: SessionStatus;
  hasBackgroundWork?: boolean;
  hasLocalSend: boolean;
  hasQueuedSends: boolean;
  queueHeld: boolean;
  flushing: boolean;
}): boolean {
  if (input.flushing) return false;
  return (
    input.hasBackgroundWork === true ||
    input.hasLocalSend ||
    input.hasQueuedSends ||
    input.queueHeld ||
    input.status === "streaming" ||
    input.status === "warming"
  );
}

/** Choose how a parked prompt is presented. The first send waiting only for
 * session admission is already the user's active turn: it belongs in the
 * transcript with the live timer, not in the follow-up queue card. Anything
 * behind another send/turn remains a real queued message. */
export function queuedPromptPresentation(input: {
  reason: "admission" | "busy-turn";
  hasLocalSend: boolean;
  hasQueuedSends: boolean;
  queueHeld: boolean;
  flushing: boolean;
}): "active-turn" | "queued-card" {
  if (
    input.reason === "admission" &&
    !input.hasLocalSend &&
    !input.hasQueuedSends &&
    !input.queueHeld &&
    !input.flushing
  ) {
    return "active-turn";
  }
  return "queued-card";
}

/** An accepted first prompt survives failed admission with its recovery card.
 * Follow-ups still use the queue's existing restoration flow. */
export function shouldPreserveAdmissionPromptOnFailure(
  failureKind: string | null | undefined,
  presentation: "active-turn" | "queued-card" | undefined,
): boolean {
  return (
    !!failureKind && failureKind !== "lifecycle-superseded" &&
    presentation === "active-turn"
  );
}

/** A first prompt waiting only for admission already owns the visible turn.
 * Stop must settle that prompt in place so the transcript and STOPPED BY USER
 * footer agree with what the user saw. Follow-ups remain editable in the
 * paused queue until the next explicit send resumes dispatch. */
export function cancelledQueuedMessageAction(
  presentation: "active-turn" | "queued-card" | undefined,
): "preserve-as-turn" | "preserve-in-queue" {
  return presentation === "active-turn" ? "preserve-as-turn" : "preserve-in-queue";
}

/** What a composer send does while the provider holds a permission request.
 * A plan review is not a gate: a typed follow-up means "revise the plan", so
 * the review is declined and the message sends as the next prompt. Any other
 * permission is a hard gate on the running turn. The permission card docks
 * above the still-usable composer, so a message typed meanwhile joins the
 * ordinary queue behind that turn (Send now steers it in), and nothing
 * dispatches past the gate. Outside a streaming turn there is no queue to
 * join, so the send holds and the draft stays in the composer. */
export function sendPastPermission(input: {
  permissionPending: boolean;
  planReview: boolean;
  status: SessionStatus;
}): "send" | "revise-plan" | "hold" {
  if (!input.permissionPending) return "send";
  if (input.planReview) return "revise-plan";
  return input.status === "streaming" ? "send" : "hold";
}

/** The first prompt is already a live user turn while its execution boundary
 * and provider route are being admitted. Give that turn the same Stop control
 * as a dispatched prompt; a bare warming session opened by focus/prewarm has no
 * user-owned work and therefore keeps the ordinary Send control. Plan review
 * owns its own submit actions and must not be replaced by Stop. */
export function composerShowsStopControl(input: {
  status: SessionStatus;
  hasPendingLocalTurn: boolean;
  planReview: boolean;
}): boolean {
  return (
    !input.planReview &&
    (input.status === "streaming" || input.hasPendingLocalTurn)
  );
}

/** Route Stop to the lifecycle object that actually exists at that instant.
 * Before the engine publishes an execution id there is no provider turn for
 * AGENT_CANCEL to address: the chat-scoped bind itself must be invalidated.
 * Once an execution exists it stays reusable and only its live/pending turn is
 * cancelled. */
export function admissionCancellationAction(input: {
  hasAgent: boolean;
  hasSession: boolean;
  status: SessionStatus;
  admissionInFlight: boolean;
}): "abort-admission" | "cancel-session" | "local-only" {
  if (!input.hasAgent) return "local-only";
  if (input.hasSession) return "cancel-session";
  if (input.admissionInFlight || input.status === "warming") {
    return "abort-admission";
  }
  return "local-only";
}

/** Remove renderer ownership of one cancelled create/resume flight. The old
 * async continuation is still protected by its cancel generation and exact
 * promise identity; detaching here lets the next prompt install a replacement
 * immediately instead of waiting behind work the user explicitly stopped. */
export function detachAdmissionFlight<T>(
  chatId: string,
  flights: Map<string, T>,
  loadKeys: Map<string, string>,
  adoptOnly: Map<string, boolean>,
): boolean {
  const detached = flights.delete(chatId);
  loadKeys.delete(chatId);
  adoptOnly.delete(chatId);
  return detached;
}

/** Route an explicit "Send now" for a queued row from authoritative session
 * lifecycle, not from the renderer-local prompt promise. A reloaded renderer
 * has no local send lock for the engine turn it adopted, but status remains
 * `streaming`; that row must steer into the live turn. Conversely, a local
 * prompt still preparing can momentarily own the lock before status becomes
 * streaming, so it must keep the row parked instead of steering into nothing. */
export function queuedSendNowAction(input: {
  status: SessionStatus;
  hasLocalSend: boolean;
}): "steer" | "flush" | "wait" {
  if (input.status === "streaming") return "steer";
  if (input.hasLocalSend || input.status === "warming") return "wait";
  return "flush";
}

/** Whether an explicit send must rebuild the session first: the retry for a
 *  chat that is failed, auth-required or reconnecting, or never spawned.
 *  warming and streaming are not recovery states; shouldQueuePrompt owns them.
 *  Treating warming as recovery held the text in the composer during a slow
 *  spawn, so each Enter queued another copy. */
export function sendNeedsSessionRecovery(status: SessionStatus): boolean {
  return status !== "ready" && status !== "warming" && status !== "streaming";
}

/** How a send that needs a session pays for it. "await" blocks the send, kept
 *  only for a chat whose last spawn ended badly: the send is the explicit retry
 *  and the honest place for another failure. "park", the default for a chat
 *  with no session yet, builds it in the background and accepts the message
 *  into the queued card at once, so every send is accepted in under 100 ms. */
export function sendSessionRecoveryMode(
  status: SessionStatus,
): "none" | "park" | "await" {
  if (!sendNeedsSessionRecovery(status)) return "none";
  return status === "failed" || status === "auth-required" ? "await" : "park";
}

/** Whether a send past shouldQueuePrompt still needs admission and must park
 *  instead of entering the turn body, decided before the local send lock is
 *  taken. Inline admission there made a first send invisible for its whole
 *  duration. "session-build" means no live session; "drift-respawn" means
 *  the session's env stamp no longer matches the pills (resuming the provider
 *  thread). An unstamped legacy slot never reads as drift. */
export function sendAdmissionPark(input: {
  hasAgent: boolean;
  hasSession: boolean;
  status: SessionStatus;
  appliedChatEnvKey: string | undefined;
  /** chatEnvDriftKey(composer env), undefined when the chat has no thread. */
  expectedEnvKey: string | undefined;
}): "session-build" | "drift-respawn" | null {
  if (!input.hasAgent || input.status === "streaming") return null;
  if (!input.hasSession || input.status === "auth-required")
    return "session-build";
  if (
    input.expectedEnvKey !== undefined &&
    input.appliedChatEnvKey !== undefined &&
    input.appliedChatEnvKey !== input.expectedEnvKey
  ) {
    return "drift-respawn";
  }
  return null;
}

/** What becomes of a parked queue once what it waited on finished; every park
 *  site needs a release site. "drop", announced, for an unhealthy chat:
 *  draining into it makes every queued send force a rebuild and spawn-storms. */
export function queueReleaseAction(input: {
  status: SessionStatus;
  queueHeld: boolean;
  hasBackgroundWork?: boolean;
}): "hold" | "drain" | "drop" {
  // Parked mid-edit: releaseQueue() owns it — the edit target must not be sent
  // out from under the user, and a held queue survives an unhealthy settle.
  if (input.queueHeld) return "hold";
  if (input.status === "ready" && input.hasBackgroundWork) return "hold";
  return input.status === "ready" ? "drain" : "drop";
}

/** A send that arrived while the transcript could not be read. A bubble cannot
 *  be appended to a partial history, but the send must not vanish silently.
 *  "park" keeps the composer payload as the draft and arms one automatic retry
 *  per disconnect (a second failure would cycle park and drain). "report" is
 *  for a payload outside the composer, a spent retry or a terminal session.
 *  "ignore" when there is nothing to send. */
export function unreadableTranscriptSendAction(input: {
  /** There is something to send at all. */
  hasPayload: boolean;
  /** That payload is the composer's own document (not a hand-off override). */
  payloadInComposer: boolean;
  /** This chat already parked one send on an unreadable transcript. */
  alreadyRetried: boolean;
  status: SessionStatus;
}): "park" | "report" | "ignore" {
  if (!input.hasPayload) return "ignore";
  if (!input.payloadInComposer || input.alreadyRetried) return "report";
  // A terminal session has no path to `ready`, so parking would promise a
  // delivery that queuedFirstTurnAction is about to hand straight back — two
  // contradictory toasts for one keystroke.
  return input.status === "failed" || input.status === "auth-required"
    ? "report"
    : "park";
}

/** The longest a parked first turn may wait before Zeros reports it did not go
 *  out, the same span as PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS. Sized for a
 *  checkout, admission, a cold provider host or an engine respawn; past it the
 *  wait is stuck, not slow. */
export const QUEUED_FIRST_TURN_MAX_WAIT_MS = 10 * 60_000;

/** What to do with a first turn parked before its chat could run it
 *  (REQUEST_AUTO_SEND). Its only drain was status ready, so a park whose spawn
 *  failed or never settled stayed armed silently. "send" when ready; "release"
 *  hands the text back and says so, at once for terminal statuses and after the
 *  bound otherwise; "wait" for real pre-ready states. During provisioning a
 *  failed status belongs to an earlier attempt, so only the bound releases. */
export function queuedFirstTurnAction(input: {
  status: SessionStatus;
  /** The chat's workspace is still being created (optimistic create window). */
  provisioning: boolean;
  hasPermissionGate: boolean;
  composerEmpty: boolean;
  /** A send is already being prepared for this chat. */
  sendInFlight: boolean;
  armedForMs: number;
}): "wait" | "send" | "release" {
  // Nothing to send and nothing to report: the user cleared the composer, and
  // the cancel effect retires that intent silently.
  if (input.composerEmpty) return "wait";
  if (
    input.status === "ready" &&
    !input.provisioning &&
    !input.hasPermissionGate &&
    !input.sendInFlight
  ) {
    // A slow-but-successful admission delivers. The bound reports a park that
    // cannot be dispatched; it never cancels one that finally can.
    return "send";
  }
  if (input.armedForMs > QUEUED_FIRST_TURN_MAX_WAIT_MS) return "release";
  if (input.provisioning) return "wait";
  return input.status === "failed" || input.status === "auth-required"
    ? "release"
    : "wait";
}

/** A send can await a rebuild, a drift respawn or a resume before its prompt
 *  reaches the engine, all while the chat shows Stop. Cancellation is a
 *  per-chat generation, not a flag: a send captures it at entry and re-reads it
 *  after every await. Monotonic, so it can be neither missed nor consumed by
 *  the wrong send, and it needs no session. */
export function bumpCancelGeneration(
  generations: Map<string, number>,
  chatId: string,
): number {
  const next = (generations.get(chatId) ?? 0) + 1;
  generations.set(chatId, next);
  return next;
}

export function cancelGeneration(
  generations: Map<string, number>,
  chatId: string,
): number {
  return generations.get(chatId) ?? 0;
}

/** Whether a cancel landed for `chatId` since `generation` was captured. */
export function cancelledSince(
  generations: Map<string, number>,
  chatId: string,
  generation: number,
): boolean {
  return cancelGeneration(generations, chatId) !== generation;
}

/** A bind-time async continuation may update renderer state only while it
 * still owns both the chat lifecycle generation and the exact execution slot.
 * Tab close removes the slot; a fast History restore can replace it. Either
 * transition makes permission/config callbacks from the old bind stale. */
export function bindStillOwnsSessionSlot(input: {
  cancelled: boolean;
  expectedExecutionId: string;
  slotExecutionId?: string | null;
  slotSessionId?: string | null;
}): boolean {
  if (input.cancelled) return false;
  return (
    (input.slotExecutionId ?? input.slotSessionId) === input.expectedExecutionId
  );
}

/** Remember that live pushes for an exact session arrived before its renderer
 * slot was bound. Refreshes insertion order and stays bounded across chats. */
export function markPrebindDirty(
  dirty: Map<string, string>,
  chatId: string,
  sessionId: string,
  limit = 64,
): void {
  dirty.delete(chatId);
  dirty.set(chatId, sessionId);
  while (dirty.size > limit) {
    const oldest = dirty.keys().next().value as string | undefined;
    if (!oldest) break;
    dirty.delete(oldest);
  }
}

/** Consume only an exact chat/session dirty mark. A terminal event from a
 * superseded session must not re-window or otherwise disturb its replacement. */
export function takePrebindDirty(
  dirty: Map<string, string>,
  chatId: string,
  sessionId: string,
): boolean {
  if (dirty.get(chatId) !== sessionId) return false;
  dirty.delete(chatId);
  return true;
}

export interface PrebindGoalSnapshot {
  chatId: string;
  sessionId: string;
  goal: AgentGoal | null;
}

function prebindGoalKey(chatId: string, sessionId: string): string {
  return JSON.stringify([chatId, sessionId]);
}

/** Retain the last authoritative goal snapshot emitted before an exact
 * renderer execution slot exists. Goal notifications are snapshots rather
 * than transcript deltas, so replaying the final exact-key value is safe. */
export function markPrebindGoalSnapshot(
  snapshots: Map<string, PrebindGoalSnapshot>,
  chatId: string,
  sessionId: string,
  goal: AgentGoal | null,
  limit = 64,
): void {
  const key = prebindGoalKey(chatId, sessionId);
  snapshots.delete(key);
  snapshots.set(key, { chatId, sessionId, goal });
  while (snapshots.size > limit) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

/** Consume a pre-bind goal only for the execution being adopted. `undefined`
 * means no snapshot; `null` is an authoritative goal clear. */
export function takePrebindGoalSnapshot(
  snapshots: Map<string, PrebindGoalSnapshot>,
  chatId: string,
  sessionId: string,
): AgentGoal | null | undefined {
  const key = prebindGoalKey(chatId, sessionId);
  const snapshot = snapshots.get(key);
  if (!snapshot) return undefined;
  snapshots.delete(key);
  return snapshot.goal;
}

export function clearPrebindGoalSnapshotsForChat(
  snapshots: Map<string, PrebindGoalSnapshot>,
  chatId: string,
): void {
  for (const [key, snapshot] of snapshots) {
    if (snapshot.chatId === chatId) snapshots.delete(key);
  }
}
