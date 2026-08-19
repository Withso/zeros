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

/** Map a failure classification to the UI session status. The single
 * definition, shared by the RPC paths in <AgentSessionsProvider> and by the
 * store's turn-state settle — those two must not be able to disagree about
 * what a recorded failure means. */
export function statusForFailure(failure: AgentFailure): SessionStatus {
  if (failure.kind === "auth-required") return "auth-required";
  if (isRecoverable(failure)) return "reconnecting";
  return "failed";
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
