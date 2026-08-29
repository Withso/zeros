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

/** Resolve the exact live route that may be torn down and resumed to pick up a
 * provider boot capability. This is intentionally narrower than ordinary
 * session recovery: only native Codex and Claude bindings for the same adapter
 * are safe. A legacy locator could mint a different conversation, while
 * Cursor's browser lifecycle is outside Zeros and must never enter this path. */
export function providerCapabilityRefreshExecution(input: {
  providerFamily: string;
  agentId: string | null;
  executionId?: string | null;
  sessionId?: string | null;
  providerBinding?: ProviderBinding | null;
}): string | null {
  const binding = input.providerBinding;
  if (
    (input.providerFamily !== "codex" && input.providerFamily !== "claude") ||
    !input.agentId ||
    binding?.kind !== "native" ||
    binding.providerId !== input.agentId ||
    !binding.resumeId.trim()
  ) {
    return null;
  }
  return input.executionId ?? input.sessionId ?? null;
}

/** Decide whether a Browser setting edge changes provider boot arguments.
 * Claude requires an explicit `--chrome`/`--no-chrome` process argument on
 * both edges. Codex only needs a reboot when enabling its boot-time plugin;
 * disabling is enforced immediately by Zeros' browser policy gate. */
export function providerCapabilityRefreshNeeded(input: {
  providerFamily: string;
  previousEnabled: boolean | null;
  enabled: boolean;
}): boolean {
  if (
    input.previousEnabled === null ||
    input.previousEnabled === input.enabled
  ) {
    return false;
  }
  if (input.providerFamily === "claude") return true;
  return (
    input.providerFamily === "codex" &&
    input.previousEnabled === false &&
    input.enabled
  );
}

/** A queued boot-capability refresh belongs to the provider family that
 * observed the setting edge. If the chat switches agents before it becomes
 * idle, refreshing the replacement provider would apply an unrelated setting
 * and could unnecessarily tear down a newly-created session. */
export function providerCapabilityRefreshStillTargetsFamily(input: {
  requestedFamily: "codex" | "claude";
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
 * durable provider binding. The next ordinary admission must therefore resume
 * that binding before it is allowed to create a new provider conversation. */
export function admissionRouteWithoutFlight(input: {
  force: boolean;
  hasProviderBinding: boolean;
  canLoad: boolean;
}): "resume" | "create" {
  return !input.force && input.hasProviderBinding && input.canLoad
    ? "resume"
    : "create";
}

/** Map a failure classification to the UI session status. The single
 * definition, shared by the RPC paths in <AgentSessionsProvider> and by the
 * store's turn-state settle — those two must not be able to disagree about
 * what a recorded failure means. */
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

/** How a terminal engine `turn_state` settles the slot.
 *
 * The engine emits terminal turn_state for EVERY turn, not just re-adopted
 * ones — and it rides the rAF-buffered update path, so for a locally-issued
 * prompt it lands a frame AFTER sendPrompt already recorded the classified
 * failure from AGENT_PROMPT_FAILED. Clearing error/failure here therefore
 * erased the real reason a turn died one frame after the user saw it: the chat
 * read as healthy with no explanation, and an auth-required turn lost its
 * Sign-in button (the footer derives it from `session.failure`).
 *
 * So the settle is non-destructive: a failure this renderer already classified
 * wins. A slot with nothing recorded — the genuinely re-adopted turn, which has
 * no local RPC result to recover a classification from — still flattens to
 * `ready` and lets the durable failed turn row tell the history. */
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
  hasLocalSend: boolean;
  hasQueuedSends: boolean;
  queueHeld: boolean;
  flushing: boolean;
}): boolean {
  if (input.flushing) return false;
  return (
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

/** A protection failure is the one admission failure that owns a durable turn
 * footer requested by product: keep its active prompt so the exact stopped
 * label has an anchor. Ordinary provider/startup failures restore the text to
 * the composer, and true follow-ups remain disposable queue rows. */
export function shouldPreserveAdmissionPromptOnFailure(
  failureKind: string | null | undefined,
  presentation: "active-turn" | "queued-card" | undefined,
): boolean {
  return (
    failureKind === "design-protection-failed" && presentation === "active-turn"
  );
}

/** A first prompt waiting only for admission already owns the visible turn.
 * Stop must settle that prompt in place so the transcript and STOPPED BY USER
 * footer agree with what the user saw. True follow-ups are still discarded:
 * they were queued behind work the user explicitly cancelled. */
export function cancelledQueuedMessageAction(
  presentation: "active-turn" | "queued-card" | undefined,
): "preserve-as-turn" | "drop" {
  return presentation === "active-turn" ? "preserve-as-turn" : "drop";
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

/** Whether an explicit send must rebuild the chat's session BEFORE the message
 * can go anywhere — the composer's retry affordance for a chat sitting in
 * `failed` / `auth-required` / `reconnecting` (or one that never spawned).
 *
 * `warming` and `streaming` are deliberately NOT recovery states: something is
 * already in flight for them, and shouldQueuePrompt above is what owns that
 * case. Treating `warming` as recovery is what made a send into a slow-spawning
 * chat (a cold Cursor host: up to three 10s attempts) look broken — the send sat
 * on the spawn with the text still in the composer and no bubble anywhere, so
 * every further Enter re-entered and enqueued another copy of the same message.
 * Parking it instead shows the message immediately in the queued card and
 * dispatches it the moment the session is ready. */
export function sendNeedsSessionRecovery(status: SessionStatus): boolean {
  return status !== "ready" && status !== "warming" && status !== "streaming";
}

/** How a send that needs a session should pay for it.
 *
 * `await` is the old universal behavior: block the send, spinner on the button,
 * the user's text hostage in the composer for the whole admission. It is kept
 * for exactly one case — a chat whose last spawn ENDED BADLY
 * (`failed` / `auth-required`). There the send is the user's explicit retry
 * after fixing something, the likely outcome is another failure, and the honest
 * place for that failure is the send itself rather than a queued card that
 * would be dropped a second later.
 *
 * `park` is the new default for a chat that simply has no session yet
 * (`idle` — first send in a fresh chat, or a chat whose engine restarted, or
 * `reconnecting` after a transport bounce). Nothing failed; the session just
 * has to be built. So: kick the build in the background, accept the message
 * into the queued card immediately, and let the existing readiness drain
 * dispatch it. That makes EVERY send accepted in <100 ms regardless of what
 * admission costs — the pre-ZSR feeling, without weakening admission. */
export function sendSessionRecoveryMode(
  status: SessionStatus,
): "none" | "park" | "await" {
  if (!sendNeedsSessionRecovery(status)) return "none";
  return status === "failed" || status === "auth-required" ? "await" : "park";
}

/** Whether a send that has already passed shouldQueuePrompt still needs an
 * ADMISSION before it can dispatch — and must therefore park in the queued
 * card rather than fall into the turn body.
 *
 * The turn body used to pay for these inline: "!sessionId → await
 * ensureSession" and the settings-drift force-respawn each awaited a FULL ZSR
 * admission after runSend had already cleared the composer and before any
 * bubble was appended. The user's first send into a new chat was invisible for
 * the whole admission, while a SECOND send — queueing behind the first's local
 * send lock — rendered a queued card immediately. Deciding it here, before the
 * local send lock is taken, gives every admission-needing send the same
 * visible park.
 *
 * `session-build` — no live session (fresh chat whose spawn is still
 * admitting, an engine restart, a pristine agent switch racing the
 * keystroke-armed spawn). `drift-respawn` — a live session whose recorded env
 * stamp no longer matches the composer pills (model/effort changed while it
 * was warming); the respawn resumes the provider thread. An unstamped
 * (legacy) slot never reads as drift, mirroring the in-turn reconcile. */
export function sendAdmissionPark(input: {
  hasAgent: boolean;
  hasSession: boolean;
  status: SessionStatus;
  appliedChatEnvKey: string | undefined;
  /** chatEnvDriftKey(composer env), undefined when the chat has no thread. */
  expectedEnvKey: string | undefined;
}): "session-build" | "drift-respawn" | null {
  if (!input.hasAgent || input.status === "streaming") return null;
  if (!input.hasSession) return "session-build";
  if (
    input.expectedEnvKey !== undefined &&
    input.appliedChatEnvKey !== undefined &&
    input.appliedChatEnvKey !== input.expectedEnvKey
  ) {
    return "drift-respawn";
  }
  return null;
}

/** The counterpart to shouldQueuePrompt: what becomes of a parked queue once
 * whatever it was parked behind has finished.
 *
 * Every park site needs a release site. `warming` became a park reason above, and
 * the only automatic drain (drainNextQueued) requires `ready` — so a warm that
 * ends failed/auth-required/reconnecting would strand the queue AND freeze the
 * composer, because each later send parks behind a queue that can never drain.
 *
 * `drop` rather than `drain` for an unhealthy chat is the long-standing policy:
 * draining into a dead/rebuilding session makes every queued send force a
 * rebuild, so the queue turns into a spawn storm. The drop is announced. */
export function queueReleaseAction(input: {
  status: SessionStatus;
  queueHeld: boolean;
}): "hold" | "drain" | "drop" {
  // Parked mid-edit: releaseQueue() owns it — the edit target must not be sent
  // out from under the user, and a held queue survives an unhealthy settle.
  if (input.queueHeld) return "hold";
  return input.status === "ready" ? "drain" : "drop";
}

/** What to do with a send that arrived while this chat's transcript could not
 * be read — a failed cold read, an engine mid-respawn, a dropped transport.
 *
 * Appending a user bubble to a partial transcript is not an option (it would
 * be written into a history Zeros has not finished reading), so this send
 * cannot go out now. What it MUST NOT do is what it used to: return, in
 * silence, with the text still in the composer and nothing anywhere saying the
 * send did not happen — indistinguishable, to the user, from a broken Enter
 * key. Reported as the other half of "I sent it before the workspace was ready
 * and it never went".
 *
 * `park` — the composer still holds the payload, so keep it as the chat's
 *   draft and arm the one-shot auto-send: the readiness drain dispatches it
 *   when the read succeeds. Exactly one automatic retry per disconnect
 *   (`alreadyRetried`), because the drain re-enters the same send path and a
 *   second failure would otherwise cycle park → drain → park at hydrate-RPC
 *   speed.
 * `report` — cannot be parked usefully: a hand-off payload lives outside the
 *   composer, the one retry is spent, or the session ended terminally so no
 *   drain will ever come. Say so instead of promising a delivery.
 * `ignore` — nothing to send; Enter on an empty composer has nothing to
 *   report. */
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

/** The longest a parked FIRST turn may wait before Zeros reports that it did
 * not go out. See queuedFirstTurnAction — deliberately the same span as
 * PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS (state/persist-composer-drafts), which
 * decides whether a park survives a restart at all.
 *
 * Sized against what a legitimate pre-ready wait actually costs — a worktree
 * checkout, a ZSR admission, a cold provider host, an engine respawn — with
 * room to spare. Anything past it is not slow, it is stuck. */
export const QUEUED_FIRST_TURN_MAX_WAIT_MS = 10 * 60_000;

/** What to do with a first turn parked BEFORE its chat could run it (the
 * "Message queued: it will send as soon as this workspace finishes setting up"
 * park — REQUEST_AUTO_SEND, kept as the chat's own composer draft).
 *
 * This is the same doctrine as queueReleaseAction one function up, applied to
 * the earlier park: every park site needs a release site. It had none. The
 * only drain condition was `status === "ready"`, so a park whose spawn ended
 * `failed` / `auth-required` — or whose session never settled at all — stayed
 * armed with the user's text in the composer, no bubble in the transcript, and
 * nothing anywhere saying the promise had not been kept.
 *
 * `send` — the session is ready and the composer still holds the payload.
 * `release` — hand it back: retire the intent, keep the text where it is, and
 *   say so. Terminal statuses qualify immediately; anything else qualifies once
 *   it has out-waited the bound, which is the only signal a session that never
 *   settles will ever produce.
 * `wait` — a real pre-ready state (`idle`, `warming`, `reconnecting`, an
 *   unfinished checkout). Waiting is what the user was promised.
 *
 * Provisioning suppresses `release` for a failed status on purpose: chat-view
 * refuses to spawn into an announced-but-unchecked-out path, so such a failure
 * belongs to an earlier attempt and the create is still on its way. The bound
 * still applies — it has to, or an abandoned create would strand the park. */
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

/** Stop is a promise, and a send is not atomic: sendPrompt may await a session
 * rebuild, a settings-drift respawn, or a resume-and-retry before its
 * AGENT_PROMPT ever reaches the engine — all while the chat already reads
 * `streaming` and the composer shows Stop. A cancel in that window used to be
 * addressed at a session that had no live turn yet (or none at all), so the
 * pending prompt dispatched anyway and the agent started working right after the
 * user stopped it.
 *
 * So cancellation is a per-chat GENERATION rather than a flag: a send captures
 * it once at entry and re-reads it after every await. Monotonic, so it can
 * neither be missed nor consumed by the wrong send, and a chat with no session
 * still records the intent.
 */
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
