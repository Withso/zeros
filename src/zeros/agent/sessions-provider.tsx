// ──────────────────────────────────────────────────────────
// AgentSessionsProvider — bridge-connected actions over the Zustand store
// ──────────────────────────────────────────────────────────
//
// Phase 0 step 3 split this file in two:
//   - sessions-store.ts owns *data* (per-chat slots, warm-agent set,
//     bridge-notification reducers). Subscribes via selectors so chat
//     A's stream doesn't re-render chat B's components.
//   - This file owns *actions that need the bridge* (ensureSession,
//     sendPrompt, …). It writes to the store via store actions.
//
// The public API (`useChatSession`, `useAgentSessions`) is unchanged
// from the caller's perspective. Internally, slot reads are now
// scoped to one chat via Zustand selectors, killing the cross-chat
// re-render cascade.
//
// ──────────────────────────────────────────────────────────

import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type {
  ContentBlock,
  InitializeResponse,
  SessionMode,
} from "../bridge/agent-events";
import type {
  AgentAgentsListMessage,
  AgentAgentInitializedMessage,
  AgentErrorMessage,
  AgentModeChangedMessage,
  AgentPromptBubble,
  AgentPromptCompleteMessage,
  AgentPromptFailedMessage,
  AgentSessionCreatedMessage,
  AgentSessionLoadedMessage,
  AgentSessionsListMessage,
  AgentSteeredMessage,
} from "../bridge/messages";
import { useBridge, useBridgeStatus } from "../bridge/use-bridge";
import {
  deriveProviderEnv,
  getProviderBinaryOverride,
} from "../panels/provider-prefs";
import { deriveMcpSecretEnv } from "./mcp-secrets";
import { deriveEnvVaultEnv } from "./env-vault";
import {
  type AgentMessage,
  type AgentTextMessage,
  type AgentUsage,
  type SessionStatus,
} from "./use-agent-session";
import {
  BLANK,
  buildQuestionStamp,
  MAX_MESSAGES_PER_CHAT,
  mergeWindowedTail,
  useSessionsStore,
} from "./sessions-store";
import {
  appendMessages as persistAppendMessages,
  clearChat as persistClearChat,
  windowMessages as persistWindowMessages,
} from "./agent-history-client";
import { toast } from "@/zeros/ui/primitives/elements";
import {
  classifyRpcError,
  isRecoverable as failureIsRecoverable,
  type AgentFailure,
} from "../bridge/failure";
import { findMatchingPolicy } from "./policies";
import {
  agentModeForPermission,
  chatEnvDriftKey,
  envForChat,
} from "./model-catalog";
import { agentAppliesConfigLive } from "./live-config-support";
import { useWorkspaceStore } from "../store/workspace-store";
import {
  buildAdditionalDirsSystemInstruction,
  prependSystemInstruction,
} from "@zeros/core/system-instructions";
import { resolveBridgeWorkspaceIdForCwd } from "../bridge/workspace-id-resolver";
import { synthesizeReplayPrompt } from "./replay";
import { ActionsCtx, type SessionsActions } from "./sessions-context";
import {
  trackAgentSessionStarted,
  trackAgentTurnStarted,
  trackAgentFirstResponse,
  trackAgentPromptCompleted,
  trackAgentSessionEnded,
  trackAgentFailed,
  trackAiGeneration,
} from "../analytics/agent-events";

// 2026-06-09: reconcile now runs on EVERY bind (new session, respawn, resume).
// It used to run at most once per chat to avoid clobbering a mode the user
// changed mid-session via the pill — but mid-session mode changes are now
// PERSISTED to chat.permissionMode (composer pill / "+" menu / plan toggle), so
// re-applying chat.permissionMode is idempotent and is exactly what restores
// the user's mode after an effort/model/fast force-respawn (which otherwise
// dropped it — e.g. plan mode silently reverted) and after an app restart.

/** Resolve the cwd to spawn/resume a chat's agent in, defensively. The caller
 *  (ChatBody) usually threads the right cwd, but several recovery paths spawn
 *  WITHOUT it (sendPrompt's `!sessionId` rebuild, a model-swap force respawn, a
 *  bridge-reconnect retry) and would otherwise reach the gateway with an empty
 *  cwd → "Agent cannot spawn: chat has no project folder bound", even though
 *  the chat itself knows its folder. So when the caller/slot didn't supply one,
 *  recover the chat's OWN `folder` and then the active scope (`newAgentFolder`)
 *  live from the workspace store — the same chain the renderer's useChatCwd
 *  uses. Returns null only when the chat genuinely has no folder anywhere, in
 *  which case the gateway's clear error still fires (and the renderer's
 *  NoFolderPanel / empty-composer CTA prompt the user to bind one). */
function resolveSpawnCwd(
  chatId: string,
  optionsCwd: string | undefined,
  existingCwd: string | null | undefined,
): string | null {
  if (optionsCwd && optionsCwd.length > 0) return optionsCwd;
  if (existingCwd && existingCwd.length > 0) return existingCwd;
  const ws = useWorkspaceStore.getState();
  const chat = ws.chats.find((c) => c.id === chatId);
  if (chat?.folder && chat.folder.length > 0) return chat.folder;
  if (ws.newAgentFolder && ws.newAgentFolder.length > 0)
    return ws.newAgentFolder;
  return null;
}

/** The chat's composer env (model/effort/fast/dirs via envForChat), read
 *  fresh from the workspace store. Undefined when the chat isn't in the
 *  store (e.g. a surface with no ChatThread yet). Used by sendPrompt's
 *  session recovery + settings-drift reconcile (2026-07-13) so a prompt can
 *  never run on a session whose env silently diverged from the pills. */
function chatComposerEnv(
  chatId: string,
  initialize: InitializeResponse | null,
): Record<string, string> | undefined {
  const chat = useWorkspaceStore.getState().chats.find((c) => c.id === chatId);
  return chat ? envForChat(chat, initialize) : undefined;
}

/** Resolve the engine `workspaceId` to thread into a spawn/resume RPC for a
 *  cwd. Managed worktrees embed their id in the path; the primary checkout
 *  needs the bridge workspace list so remote/cloud clients send `local-main`
 *  instead of a raw host path. */
function resolveSpawnWorkspaceId(
  bridge: NonNullable<ReturnType<typeof useBridge>>,
  cwd: string | null,
): Promise<string | null> {
  return resolveBridgeWorkspaceIdForCwd(bridge, cwd);
}

/** Apply a chat's pre-session permission posture (chosen in the empty
 *  composer, before any modes existed) to the agent's mode now that the
 *  session has bound and its modes are known. See agentModeForPermission
 *  for the posture→native mapping (a posture with no matching mode → no-op).
 *  Quiet by design: nothing is dropped into the timeline — the active mode
 *  shows on the composer pills. No-op
 *  when no safe target exists or the target already matches. */
async function reconcilePermissionModeAtBind(
  bridge: NonNullable<ReturnType<typeof useBridge>>,
  getStore: typeof useSessionsStore.getState,
  args: {
    chatId: string;
    agentId: string;
    sessionId: string;
    availableModes: SessionMode[];
    currentModeId: string | null;
  },
): Promise<void> {
  const { chatId, agentId, sessionId, availableModes, currentModeId } = args;
  if (availableModes.length === 0) return;
  // Chat threads (which carry permissionMode) live in the workspace store,
  // not the sessions store that `getStore` snapshots.
  const chat = useWorkspaceStore.getState().chats.find((c) => c.id === chatId);
  if (!chat) return;
  // Prefer the EXACT mode id the user last selected in-session (lastModeId) —
  // it round-trips losslessly, so bypass/auto/plan survive a respawn. Fall back
  // to the persisted POSTURE bucket for a chat with no in-session change yet.
  // Restoring the posture is safe: a new chat is born in the safe "auto" default,
  // and the "danger" posture only ever exists because the user picked it.
  const exact =
    chat.lastModeId && availableModes.find((m) => m.id === chat.lastModeId);
  const desired =
    exact ||
    agentModeForPermission(chat.permissionMode, availableModes, agentId);
  // No target (an agent that doesn't advertise the posture's mode → keep its
  // own default), or already in the desired mode → nothing to do. The
  // `=== currentModeId` short-circuit keeps the common idempotent re-bind a no-op.
  if (!desired || desired.id === currentModeId) return;
  getStore().patchSession(chatId, { currentModeId: desired.id });
  try {
    const resp = await bridge.request<
      AgentModeChangedMessage | AgentErrorMessage
    >(
      { type: "AGENT_SET_MODE", agentId, sessionId, modeId: desired.id },
      10_000,
    );
    if (resp.type === "AGENT_ERROR") {
      getStore().patchSession(chatId, { currentModeId });
    }
  } catch {
    getStore().patchSession(chatId, { currentModeId });
  }
}

/** How many messages we hydrate into memory per chat on first mount.
 *  Older messages stay on disk and load on scroll-up. 200 covers a
 *  multi-hour session without scrolling. */
const HYDRATE_WINDOW = 200;

// (MAX_MESSAGES_PER_CHAT no longer re-exported — Track 4.C: Vite Fast
// Refresh requires this file to export only React components / hooks
// to keep its HMR boundary clean. Consumers import the constant
// directly from `./sessions-store`.)

/** User-visible ceiling for session creation. Three attempts with
 *  exponential backoff so transient flakes (cold-start lock, brief
 *  network hiccup, slow process spawn) don't immediately surface as
 *  "Session failed". 10s per attempt gives Claude Agent and Codex
 *  enough room for their cold newSession RPC.
 *
 *  Phase 1 audit fix #6 — was previously a single attempt with no
 *  retry, which forced too many users to manually re-open chats on
 *  the very first cold spawn.  */
const ENSURE_SESSION_ATTEMPT_TIMEOUT_MS = 10_000;
const ENSURE_SESSION_ATTEMPTS = 3;
const ENSURE_SESSION_BACKOFF_MS = [0, 800, 2_000];

/** Long agent turns are allowed to run for hours. This watchdog only fires
 *  when the renderer sees no prompt activity at all: no streamed update,
 *  permission/question event, question settlement, or user response. */
const PROMPT_INACTIVITY_TIMEOUT_MS = 30 * 60_000;

/** Absolute per-turn backstop, independent of the inactivity reset above. The
 *  inactivity watchdog is disarmed by ANY streamed chunk, so a transport that
 *  half-opens mid-turn (a completion dropped under the request's `timeoutMs: 0`,
 *  or a sandbox proxy idle-reset that never surfaces as a socket `close`) could
 *  otherwise hold the prompt promise — and the `sendingChatsRef` lock it gates,
 *  which blocks EVERY later send for the chat via drainNextQueued — forever. This
 *  fires ONCE from turn start regardless of activity, so the promise (hence the
 *  lock) always settles within a bounded window. Set well beyond any real turn
 *  (turns may legitimately stream for hours) — a safety net, not a UX cap; the
 *  inactivity watchdog is the fast path for a genuinely idle stall. */
const PROMPT_ABSOLUTE_TIMEOUT_MS = 6 * 60 * 60_000;

/** How long to wait for the engine's AGENT_QUESTION_SETTLED echo after
 *  sending a question answer. The echo is the DELIVERY RECEIPT — the adapter
 *  emits it right after resolving the parked SDK promise, so on a local
 *  engine it lands in milliseconds. No echo means the answer was lost:
 *  ws-client.send() silently drops when the socket is mid-reconnect, or the
 *  engine settled/rebuilt the question underneath. Without this watchdog the
 *  turn just sits "loading" until the 30-min timeout and the user has no idea
 *  why (field report 2026-07-04). */
const ANSWER_ACK_TIMEOUT_MS = 10_000;

/** The guaranteed-delivery fallback: when the blocking answer channel fails
 *  twice (see the watchdog in respondToQuestion), the answer is delivered as
 *  a regular next-turn prompt instead. Plain text the model reads the same
 *  way it reads the deny-message — the question's outcome still lands. */
function questionFallbackPrompt(
  request: import("../bridge/agent-events").QuestionRequest,
  outcome: import("../bridge/agent-events").QuestionOutcome,
): string {
  if (outcome.outcome !== "answered") {
    return "I dismissed your question — proceed with your best judgment.";
  }
  const stamp = buildQuestionStamp(request, outcome);
  const lines = (stamp.answers ?? []).map((a) => `- ${a.prompt} → ${a.value}`);
  return `Answering your question(s):\n${lines.join("\n")}`;
}

function promptInactivityError(): Error & { code?: string } {
  const err = new Error("Agent response failure") as Error & { code?: string };
  err.code = "PROMPT_INACTIVITY";
  return err;
}

/** Pull the classified failure off an AGENT_ERROR bridge message when
 *  the engine populated it; otherwise classify from the free-form
 *  message so older engine builds still produce the right UI state. */
function failureFromAgentError(
  msg: AgentErrorMessage,
  fallbackStage: AgentFailure["stage"],
): AgentFailure {
  if (msg.failure) return msg.failure as AgentFailure;
  return classifyRpcError({
    agentId: msg.agentId,
    stage: fallbackStage ?? "initialize",
    error: new Error(msg.message),
  });
}

/** Map a failure classification to the UI session status. */
function statusForFailure(failure: AgentFailure): SessionStatus {
  if (failure.kind === "auth-required") return "auth-required";
  if (failureIsRecoverable(failure)) return "reconnecting";
  return "failed";
}

// SessionsActions / SessionsCtx / StartForChatOptions / ActionsCtx all
// live in ./sessions-context now — splitting them out kept Vite Fast
// Refresh's "this file exports only components" boundary clean
// (Track 5.C). Hooks live in ./sessions-hooks. This file is the
// component-only surface.

export function AgentSessionsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus();

  // Helper: snapshot the store. Used inside async actions to bypass
  // React's closure capture problem (state read pre-await is stale).
  const getStore = useSessionsStore.getState;

  // Per-chat in-flight ensureSession promises. Concurrent callers wait on
  // the existing promise instead of starting a duplicate. Force=true
  // bypasses (model swap intends a rebuild).
  const ensureInFlightRef = useRef(new Map<string, Promise<void>>());

  // Chats whose disk hydrate could NOT be trusted: the bridge was absent /
  // mid-reconnect (an engine respawn, a cold boot racing the socket, a dev
  // HMR swap) or the window RPC rejected. An empty read in that state is
  // indistinguishable from "no history", and treating it as authoritative
  // parked the chat on a permanently blank transcript while its tab stayed
  // visible (field report 2026-07-16). Parked ids re-hydrate on the next
  // bridge "connected" edge — see the drain effect below hydrateChat.
  const pendingHydratesRef = useRef(new Set<string>());
  // Intent prefetch and the retained ChatBody can request the same cold
  // transcript in one frame. Share that disk/DB window read per chat instead
  // of relying only on the post-await stale-write guard.
  const hydrateInFlightRef = useRef(new Map<string, Promise<void>>());
  // Warm retained chats reconcile against durable history in the background.
  // Hover intent followed by selection must share that same window read.
  const reconcileInFlightRef = useRef(new Map<string, Promise<void>>());

  // Phase 1 audit fix #8 — atomic guard against concurrent sendPrompt.
  // The Zustand `status === "streaming"` check is a read-then-act
  // pattern: two rapid Send-button clicks can both pass it before
  // either flips the flag. The ref-based set is updated synchronously
  // at the very top of sendPrompt, before any awaited operation, so
  // the second call sees the lock and bails immediately.
  const sendingChatsRef = useRef(new Set<string>());

  // Cursor "duplicate turn" guard. Tracks whether the in-flight turn for a
  // chat has already STREAMED assistant content (text / reasoning / a tool
  // call) via AGENT_SESSION_UPDATE. Reset at the top of every turn; flipped
  // true by the update listener on the first chunk. sendPrompt's recoverable-
  // failure handler reads it: when a prompt request fails *recoverably* — most
  // often a transport blip (forceReconnect / socket close) whose engine-side
  // turn is still alive — a cold rebuild + resend would run the SAME prompt on
  // a SECOND session and stream the turn twice. If output already landed, the
  // turn effectively completed, so we DON'T resend.
  const turnProducedOutputRef = useRef(new Map<string, boolean>());
  // Per-chat set of additional dirs already announced to the agent. The gateway
  // announces the dirs present at the FIRST turn (its preamble); this tracks
  // them so a dir added mid-conversation (/add-dir) gets a one-time awareness
  // notice on the next turn — and isn't re-announced after. See sendPrompt.
  const announcedDirsRef = useRef(new Map<string, Set<string>>());

  // Answer-ack watchdog (2026-07-04). questionId → the timer waiting for the
  // engine's AGENT_QUESTION_SETTLED delivery receipt after we sent an answer.
  // Cleared by the settled listener; fired = the answer was lost in transit
  // (ws-client.send drops silently when the socket is mid-reconnect) → the
  // question re-queues ONCE so the user can answer again instead of staring
  // at a turn that never resumes. `retried` tracks the one re-queue per id.
  const answerAcksRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const retriedAnswersRef = useRef(new Set<string>());
  const promptActivityRef = useRef(new Map<string, () => void>());
  const questionChatRef = useRef(new Map<string, string>());

  // Bridge listeners feed the store. Phase 0 step 5: notifications are
  // buffered into a ring of arrays and flushed once per animation frame
  // inside `startTransition`. Token-rate inputs (10–100/s during a
  // streaming response) collapse to ≤60 store updates per second, and
  // React tags those updates as non-urgent so typing/clicks always
  // pre-empt them. Pre-buffer the path was: 1 setState per chunk
  // = render storm; now: 1 setState per frame = smooth.
  useEffect(() => {
    if (!bridge) return;

    type SessionNotification =
      import("../bridge/agent-events").SessionNotification;
    type PermissionReq =
      import("../bridge/agent-events").RequestPermissionRequest;

    const updateBuffer: SessionNotification[] = [];
    const permBuffer: Array<{
      agentId: string;
      permissionId: string;
      request: PermissionReq;
    }> = [];
    const questionBuffer: Array<{
      agentId: string;
      questionId: string;
      request: import("../bridge/agent-events").QuestionRequest;
    }> = [];
    const questionSettledBuffer: Array<{
      questionId: string;
      outcome: import("../bridge/agent-events").QuestionOutcome;
    }> = [];
    const stderrBuffer: Array<{ agentId: string; line: string }> = [];
    const exitBuffer: Array<{
      agentId: string;
      sessionId: string | null;
      code: number | null;
      signal: string | null;
    }> = [];

    let rafHandle: number | null = null;

    const flush = () => {
      rafHandle = null;
      if (
        updateBuffer.length === 0 &&
        permBuffer.length === 0 &&
        questionBuffer.length === 0 &&
        questionSettledBuffer.length === 0 &&
        stderrBuffer.length === 0 &&
        exitBuffer.length === 0
      ) {
        return;
      }
      // Drain into local arrays so any new event arriving mid-flush
      // queues for the next frame instead of being lost or re-processed.
      const updates = updateBuffer.splice(0);
      const perms = permBuffer.splice(0);
      const questions = questionBuffer.splice(0);
      const questionSettles = questionSettledBuffer.splice(0);
      const stderrs = stderrBuffer.splice(0);
      const exits = exitBuffer.splice(0);

      // Permissions and exits are control-plane events — they affect
      // routing (session status, sign-in chip). Keep them URGENT so the
      // user sees the prompt / failure immediately. Token chunks and
      // stderr are content; they go through startTransition so React
      // can drop intermediate frames if a newer one arrives.
      const store = useSessionsStore.getState();

      for (const p of perms) {
        // Stage 6.2 — auto-respond if a chat policy matches the
        // incoming request. We need the chatId to look up policies,
        // which the store derives from request.sessionId. Mirror that
        // lookup here so we can intercept before the prompt UI lands.
        const sid = (p.request as { sessionId?: string }).sessionId;
        const chatId = sid ? store.sessionToChatId[sid] : undefined;
        const policies = chatId ? (store.chatPolicies[chatId] ?? []) : [];
        const tool = p.request.toolCall;
        const match = chatId
          ? findMatchingPolicy(policies, tool.kind ?? undefined, tool.title)
          : null;
        if (match) {
          // Map decision → wire option. Prefer allow_always /
          // reject_always (sticky on the engine side too); fall back
          // to the once-variants if the agent didn't expose the
          // always option for this request.
          const wantedKinds =
            match.decision === "allow"
              ? ["allow_always", "allow_once"]
              : ["reject_always", "reject_once"];
          let optionId: string | null = null;
          for (const k of wantedKinds) {
            const opt = p.request.options.find((o) => o.kind === k);
            if (opt) {
              optionId = opt.optionId;
              break;
            }
          }
          if (optionId) {
            bridge.send({
              type: "AGENT_PERMISSION_RESPONSE",
              permissionId: p.permissionId,
              response: {
                outcome: { outcome: "selected", optionId },
              },
            });
            if (chatId) promptActivityRef.current.get(chatId)?.();
            // Skip the regular set-pendingPermission path so the UI
            // never blinks the prompt. The auto-allow is deliberately
            // silent — no attribution chip (removed 2026-07-06).
            continue;
          }
        }
        store.applyBridgePermissionRequest(
          p.agentId,
          p.permissionId,
          p.request,
        );
      }
      for (const q of questions) {
        // No auto-policy path — questions are always shown (they carry no
        // allow/deny semantics an "always" rule could match).
        store.applyBridgeQuestionRequest(q.agentId, q.questionId, q.request);
      }
      for (const qs of questionSettles) {
        // Engine settled it (timeout / abort / another client) — evict the
        // parked card + stamp the record. No-op when already answered here.
        store.applyBridgeQuestionSettled(qs.questionId, qs.outcome);
      }
      for (const e of exits) {
        store.applyBridgeAgentExit(e.agentId, e.sessionId);
      }

      startTransition(() => {
        const s = useSessionsStore.getState();
        for (const n of updates) s.applyBridgeUpdate(n);
        for (const t of stderrs) s.applyBridgeStderr(t.agentId, t.line);
      });
    };

    const schedule = () => {
      if (rafHandle === null) {
        rafHandle = requestAnimationFrame(flush);
      }
    };

    const unsubUpdate = bridge.on("AGENT_SESSION_UPDATE", (raw) => {
      const msg = raw as {
        agentId: string;
        notification: SessionNotification;
        chatId?: string;
      };
      const state = useSessionsStore.getState();
      // Engine-authoritative chatId wins over the (possibly stale) local
      // sessionId→chatId index, so a live update is never dropped mid
      // force-respawn / create-load / early session emit.
      // (The old loadSession content-suppression that lived here was removed
      // 2026-06-08 — no current adapter replays on resume, so it only ever
      // swallowed live turns. See the note in sessions-store.ts.)
      const chatId =
        msg.chatId ?? state.sessionToChatId[msg.notification.sessionId];
      // TTFT: the first streamed output of an in-flight turn (assistant text,
      // reasoning, or a tool call — whichever lands first) emits
      // agent_first_response with the elapsed time since the prompt was sent.
      // Measured HERE at receive time — before the rAF buffer — so the latency
      // isn't skewed by up to a frame of batching. trackAgentFirstResponse
      // no-ops after the first chunk and when no turn is armed, so it's one
      // event per turn. (Load-replay content events already returned above.)
      if (chatId) {
        promptActivityRef.current.get(chatId)?.();
        const su = (msg.notification.update as { sessionUpdate?: string })
          .sessionUpdate;
        if (su === "agent_message_chunk")
          trackAgentFirstResponse(chatId, "message");
        else if (su === "agent_thought_chunk")
          trackAgentFirstResponse(chatId, "thought");
        else if (su === "tool_call")
          trackAgentFirstResponse(chatId, "tool_call");
        // Record that THIS turn streamed visible content (text / reasoning / a
        // tool call). sendPrompt's recoverable-failure handler reads this so a
        // transport blip that rejects the in-flight prompt — while the engine-
        // side turn is still alive and has already produced its answer — does
        // NOT trigger a cold rebuild + resend that would stream the same turn
        // a second time (the cursor "duplicate turn" bug).
        if (
          su === "agent_message_chunk" ||
          su === "agent_thought_chunk" ||
          su === "tool_call"
        )
          turnProducedOutputRef.current.set(chatId, true);
      }
      // Carry the engine's chatId through the rAF buffer so applyBridgeUpdate
      // routes by it too (same anti-drop reasoning as above).
      updateBuffer.push(
        msg.chatId
          ? ({ ...msg.notification, chatId: msg.chatId } as SessionNotification)
          : msg.notification,
      );
      schedule();
    });

    const unsubPerm = bridge.on("AGENT_PERMISSION_REQUEST", (raw) => {
      const msg = raw as {
        agentId: string;
        permissionId: string;
        request: PermissionReq;
      };
      const sid = (msg.request as { sessionId?: string }).sessionId;
      const chatId = sid
        ? useSessionsStore.getState().sessionToChatId[sid]
        : undefined;
      if (chatId) promptActivityRef.current.get(chatId)?.();
      permBuffer.push({
        agentId: msg.agentId,
        permissionId: msg.permissionId,
        request: msg.request,
      });
      schedule();
    });

    const unsubQuestion = bridge.on("AGENT_QUESTION_REQUEST", (raw) => {
      const msg = raw as {
        agentId: string;
        questionId: string;
        request: import("../bridge/agent-events").QuestionRequest;
      };
      const chatId =
        useSessionsStore.getState().sessionToChatId[msg.request.sessionId];
      if (chatId) {
        questionChatRef.current.set(msg.questionId, chatId);
        promptActivityRef.current.get(chatId)?.();
      }
      questionBuffer.push({
        agentId: msg.agentId,
        questionId: msg.questionId,
        request: msg.request,
      });
      schedule();
    });

    const unsubQuestionSettled = bridge.on("AGENT_QUESTION_SETTLED", (raw) => {
      const msg = raw as {
        questionId: string;
        outcome: import("../bridge/agent-events").QuestionOutcome;
      };
      const chatId = questionChatRef.current.get(msg.questionId);
      if (chatId) {
        promptActivityRef.current.get(chatId)?.();
        questionChatRef.current.delete(msg.questionId);
      }
      // Delivery receipt for the answer-ack watchdog — clear it HERE (not in
      // the rAF flush) so a slow frame can't fire a false "answer lost".
      const ackTimer = answerAcksRef.current.get(msg.questionId);
      if (ackTimer) {
        clearTimeout(ackTimer);
        answerAcksRef.current.delete(msg.questionId);
      }
      retriedAnswersRef.current.delete(msg.questionId);
      questionSettledBuffer.push({
        questionId: msg.questionId,
        outcome: msg.outcome,
      });
      schedule();
    });

    const unsubStderr = bridge.on("AGENT_AGENT_STDERR", (raw) => {
      const msg = raw as { agentId: string; line: string };
      stderrBuffer.push({ agentId: msg.agentId, line: msg.line });
      schedule();
    });

    const unsubExit = bridge.on("AGENT_AGENT_EXITED", (raw) => {
      const msg = raw as {
        agentId: string;
        sessionId?: string | null;
        code: number | null;
        signal: string | null;
      };
      // Agent subprocess exited. The ENGINE owns respawn entirely (see
      // the always-warm pool in session-manager.ts). The UI's job is
      // just to reflect the blip — mark chats `reconnecting` and clear
      // the dead sessionId. The next user action triggers ensureSession,
      // which lands on the (by-then) respawned subprocess.
      //
      // `sessionId` (when present) scopes the blip to ONE chat — Codex runs
      // one app-server child per chat, so a crash must not flip every open
      // Codex chat to reconnecting.
      //
      // We intentionally do NOT schedule an automatic retry. Loops here
      // produced "reconnecting forever" bugs when revival was impossible
      // (e.g. missing auth).
      exitBuffer.push({
        agentId: msg.agentId,
        sessionId: msg.sessionId ?? null,
        code: msg.code,
        signal: msg.signal,
      });
      schedule();
    });

    return () => {
      // Flush anything still queued so a tear-down (e.g. provider remount,
      // bridge swap on engine respawn) doesn't drop final permission
      // prompts or exit events that the next listener can't observe.
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
      flush();
      unsubUpdate();
      unsubPerm();
      unsubQuestion();
      unsubQuestionSettled();
      unsubStderr();
      unsubExit();
      // Answer-ack watchdogs are deliberately NOT cleared here: a bridge swap
      // is the very failure the watchdog guards against (the send dropped on
      // the dying socket). The timer's own status guard ("streaming" only)
      // keeps a stale fire from resurrecting a card on a dead/reset chat.
    };
  }, [bridge]);

  // ── Actions ─────────────────────────────────────────────

  const listAgents = useCallback<SessionsActions["listAgents"]>(
    async (force = false) => {
      if (!bridge) return [];
      const resp = await bridge.request<AgentAgentsListMessage>(
        { type: "AGENT_LIST_AGENTS", force },
        30_000,
      );
      return resp.agents;
    },
    [bridge],
  );

  const initAgent = useCallback<SessionsActions["initAgent"]>(
    async (agentId) => {
      if (!bridge) throw new Error("Engine not connected");
      // 5 min ceiling on the bridge request covers first-time npx/uvx
      // cold starts. The engine's always-warm pool keeps subsequent
      // calls sub-second.
      const resp = await bridge.request<
        AgentAgentInitializedMessage | AgentErrorMessage
      >({ type: "AGENT_INIT_AGENT", agentId }, 5 * 60_000);
      if (resp.type === "AGENT_ERROR") {
        getStore().setWarmAgent(agentId, false);
        const failure = failureFromAgentError(resp, "initialize");
        const err = new Error(failure.message) as Error & {
          failure?: AgentFailure;
        };
        err.failure = failure;
        throw err;
      }
      getStore().setWarmAgent(agentId, true);
      return resp.initialize;
    },
    [bridge, getStore],
  );

  // ensureSession is referenced by sendPrompt's recovery path (and could
  // be by future bridge handlers); a ref breaks the circular dependency
  // without re-arranging the component.
  const ensureSessionRef = useRef<SessionsActions["ensureSession"] | null>(
    null,
  );
  /** Self-ref so sendPrompt's turn-completion flush can re-invoke it for the
   *  next queued send (a useCallback can't reference itself in its body). */
  const sendPromptRef = useRef<SessionsActions["sendPrompt"] | null>(null);
  /** Per-chat FIFO of sends that arrived while a turn was already in flight.
   *  Flushed one at a time as each turn completes, so the engine only ever
   *  sees a single turn (no "prompt already in flight" rejection) and the
   *  user's follow-up is never silently dropped (the prior behavior). */
  const sendQueueRef = useRef(
    new Map<
      string,
      Array<{
        args: Parameters<SessionsActions["sendPrompt"]>;
        /** Id of the greyed placeholder bubble shown while this send waits. */
        bubbleId: string;
      }>
    >(),
  );

  // When a queued send flushes, the finally below hands its placeholder bubble
  // id to the re-entrant sendPrompt via this map (chatId → bubbleId). sendPrompt
  // then PROMOTES that placeholder into a live bubble at the transcript end
  // (queued messages render in the composer's queued-card, not the transcript,
  // so the promoted bubble must land after the previous turn's tail events) —
  // and, if the session can't be re-established, demotes it to a normal bubble
  // so the user's text is never silently dropped.
  const flushBubbleRef = useRef(new Map<string, string>());

  /** Chats whose send queue is PARKED because the user is editing a queued
   *  message (holdQueue/releaseQueue). While held, a settling turn leaves the
   *  queue in place instead of draining it — the edit target can't be sent
   *  out from under the user mid-edit. releaseQueue drains if idle+ready. */
  const queueHeldRef = useRef(new Set<string>());

  /** Flush the HEAD of a chat's send queue if (and only if) it may fire now:
   *  not held, nothing in flight, session ready. The single drain entry point
   *  — the turn-completion finally, releaseQueue, and a send parked behind an
   *  idle queue all funnel here so FIFO order holds everywhere. */
  const drainNextQueued = useCallback(
    (chatId: string): void => {
      if (queueHeldRef.current.has(chatId)) return;
      if (sendingChatsRef.current.has(chatId)) return;
      const q = sendQueueRef.current.get(chatId);
      if (!q || q.length === 0) return;
      if (getStore().sessions[chatId]?.status !== "ready") return;
      const next = q.shift()!;
      if (q.length === 0) sendQueueRef.current.delete(chatId);
      flushBubbleRef.current.set(chatId, next.bubbleId);
      void sendPromptRef.current?.(...next.args);
    },
    [getStore],
  );

  const ensureSession = useCallback<SessionsActions["ensureSession"]>(
    async (chatId, agentId, options) => {
      if (!bridge) return;
      const store = getStore();
      const existing = store.sessions[chatId];

      // Already wired up and healthy — nothing to do unless the caller
      // forces a rebuild. `reconnecting` and `auth-required` count as
      // "not healthy" so user interaction kicks retry.
      if (
        !options?.force &&
        existing &&
        existing.sessionId &&
        existing.agentId === agentId &&
        (existing.status === "ready" || existing.status === "streaming")
      ) {
        return;
      }

      // De-dup concurrent calls. A user clicking Send while initial
      // creation is mid-warming would otherwise kick off a parallel
      // newSession, orphaning the first sessionId. Wait on the existing
      // promise instead. Force still bypasses.
      if (!options?.force) {
        const inflight = ensureInFlightRef.current.get(chatId);
        if (inflight) return inflight;
      }

      // Resolve cwd ONCE so the slot and the bridge call agree. Earlier
      // versions persisted `options?.cwd ?? existing?.cwd` on the slot
      // but sent only `options?.cwd` to the bridge — meaning a force
      // rebuild that omitted cwd (sendPrompt's `!sessionId` recovery)
      // landed at the gateway with cwd=undefined and triggered "chat
      // has no project folder bound" even though the slot remembered
      // the right path. resolveSpawnCwd additionally recovers the chat's
      // OWN folder / active scope from the store, so a spawn from ANY
      // recovery path lands in the right folder instead of throwing.
      const resolvedCwd = resolveSpawnCwd(chatId, options?.cwd, existing?.cwd);

      const work = (async () => {
        getStore().setSession(chatId, {
          ...BLANK,
          agentId,
          agentName: options?.agentName ?? agentId,
          cwd: resolvedCwd,
          status: "warming",
          messages: existing?.messages ?? [],
          // Carry the context-gauge reading across a rebuild of the SAME
          // agent (model/effort swap force-respawn, silent retry). The old
          // numbers stay honest — nothing was sent yet on the new session —
          // and the first settled turn overwrites them; blanking here made
          // the ring vanish on every model change (user report 2026-07-12).
          // A different agent's numbers never carry.
          usage: existing?.agentId === agentId ? existing.usage : BLANK.usage,
        });

        // Race the bridge request against an outer setTimeout. The
        // ws-client has its own reconnect-queue window
        // (RECONNECT_GRACE_MS, ~7s) which would otherwise mask the cap
        // we pass down — the race makes it absolute.
        let lastFailure: AgentFailure | null = null;
        const attemptOnce = async (): Promise<
          AgentSessionCreatedMessage | AgentErrorMessage
        > => {
          const timer = new Promise<never>((_, reject) => {
            window.setTimeout(
              () =>
                reject(
                  new Error(
                    `Request timeout: AGENT_NEW_SESSION (${ENSURE_SESSION_ATTEMPT_TIMEOUT_MS}ms cap)`,
                  ),
                ),
              ENSURE_SESSION_ATTEMPT_TIMEOUT_MS,
            );
          });
          // Merge env from Settings → Providers (auth method +
          // gateway URL) with any explicit env the caller supplied.
          // Explicit env (e.g. from the AuthModal first-time flow)
          // wins on conflict.
          const presetEnv = await deriveProviderEnv(agentId);
          // MCP secret env vars (Keychain, user + this cwd's repo scope)
          // couriered into the agent's process env so stdio MCP servers
          // inherit them — never written into MCP config.
          const mcpSecretEnv = await deriveMcpSecretEnv(bridge, resolvedCwd);
          // Environment vault (user scope + this cwd's repo scope) — ALL
          // UI-managed env vars, Keychain-only. Under provider/session env.
          const envVaultEnv = await deriveEnvVaultEnv(bridge, resolvedCwd);
          const mergedEnv =
            options?.env ||
            Object.keys(presetEnv).length > 0 ||
            Object.keys(mcpSecretEnv).length > 0 ||
            Object.keys(envVaultEnv).length > 0
              ? {
                  ...mcpSecretEnv,
                  ...envVaultEnv,
                  ...presetEnv,
                  ...(options?.env ?? {}),
                }
              : undefined;
          const cliBinaryOverride = getProviderBinaryOverride(agentId);

          const spawnWorkspaceId = await resolveSpawnWorkspaceId(
            bridge,
            resolvedCwd,
          );

          const request = bridge.request<
            AgentSessionCreatedMessage | AgentErrorMessage
          >(
            {
              type: "AGENT_NEW_SESSION",
              agentId,
              chatId, // Phase 2b: bind the session→chat so the engine persists by chat
              cwd: resolvedCwd ?? undefined,
              workspaceId: spawnWorkspaceId ?? undefined,
              env: mergedEnv,
              cliBinary: cliBinaryOverride,
            },
            ENSURE_SESSION_ATTEMPT_TIMEOUT_MS,
          );
          return Promise.race([request, timer]);
        };

        for (let attempt = 1; attempt <= ENSURE_SESSION_ATTEMPTS; attempt++) {
          // Backoff between attempts. Index 0 is the first try (no
          // wait); indices 1-2 are the retry waits.
          const backoff = ENSURE_SESSION_BACKOFF_MS[attempt - 1] ?? 2_000;
          if (backoff > 0) {
            await new Promise((r) => setTimeout(r, backoff));
          }
          try {
            const resp = await attemptOnce();
            if (resp.type === "AGENT_ERROR") {
              lastFailure = failureFromAgentError(resp, "newSession");
              console.warn(
                `[Zeros ensureSession] attempt ${attempt}/${ENSURE_SESSION_ATTEMPTS} for ${agentId}: AGENT_ERROR kind=${lastFailure.kind} message=${lastFailure.message}`,
              );
              if (!failureIsRecoverable(lastFailure)) break;
              continue;
            }
            getStore().patchSession(chatId, {
              status: "ready",
              sessionId: resp.session.sessionId,
              session: resp.session,
              initialize: resp.initialize,
              availableModes: resp.session.modes?.availableModes ?? [],
              currentModeId: resp.session.modes?.currentModeId ?? null,
              // usage deliberately NOT reset here: the warming setSession
              // above already blanked or carried it (same-agent rebuild
              // keeps the gauge reading; the next settled turn refreshes it).
              error: null,
              failure: null,
              // Settings-drift guard: record the chat env this session was
              // ACTUALLY created with, so sendPrompt can detect a stale
              // session (model/effort changed while warming) and respawn.
              appliedChatEnvKey: chatEnvDriftKey(options?.env),
            });
            getStore().setWarmAgent(agentId, true);
            trackAgentSessionStarted(agentId, chatId);
            // Honour a permission posture picked in the empty composer
            // (before modes existed) now that the session's modes are known.
            if (bridge) {
              void reconcilePermissionModeAtBind(bridge, getStore, {
                chatId,
                agentId,
                sessionId: resp.session.sessionId,
                availableModes: resp.session.modes?.availableModes ?? [],
                currentModeId: resp.session.modes?.currentModeId ?? null,
              });
            }
            // A queue parked while this chat was down — a held queued-edit, or a
            // send stranded because recovery landed via ensureSession rather than
            // a turn-completion — drains now that the session is ready again;
            // otherwise it sits until the user sends another message. A no-op mid
            // rebuild (sendingChatsRef still set) and self-gated (ready + idle +
            // not held) inside drainNextQueued, so it can't spawn-storm.
            drainNextQueued(chatId);
            return;
          } catch (err) {
            lastFailure = classifyRpcError({
              agentId,
              stage: "newSession",
              error: err,
            });
            console.warn(
              `[Zeros ensureSession] attempt ${attempt}/${ENSURE_SESSION_ATTEMPTS} for ${agentId} threw: kind=${lastFailure.kind} msg=${lastFailure.message}`,
            );
            if (!failureIsRecoverable(lastFailure)) break;
          }
        }

        // Both attempts exhausted (or fast-failed). Route by
        // classification: recoverable → reconnecting (muted),
        // auth-required → Sign-in chip, else → failed (red).
        const failure =
          lastFailure ??
          classifyRpcError({
            agentId,
            stage: "newSession",
            error: new Error("No response"),
          });
        getStore().patchSession(chatId, {
          status: statusForFailure(failure),
          error: failure.message,
          failure,
        });
      })();

      ensureInFlightRef.current.set(chatId, work);
      try {
        await work;
      } finally {
        ensureInFlightRef.current.delete(chatId);
      }
    },
    [bridge, getStore, drainNextQueued],
  );

  useEffect(() => {
    ensureSessionRef.current = ensureSession;
  }, [ensureSession]);

  const sendPrompt = useCallback<SessionsActions["sendPrompt"]>(
    async (
      chatId,
      text,
      displayText,
      attachments,
      bubbleAttachments,
      segments,
      autoAction,
    ) => {
      if (!bridge) return;
      // Atomic lock — fix #8. Two synchronous Enter presses both
      // observed `status !== "streaming"` before either could flip
      // it; the second prompt overrode the first's pendingTurn and
      // the first's response was lost. ref.add() is synchronous so
      // the second call sees the lock immediately.
      // If this call is the FIFO flush of a queued send, the finally handed us
      // the placeholder's bubble id (see flushBubbleRef). Read EARLY so the
      // enqueue branch below can't re-queue a flush (a flush must bypass the
      // "park behind an existing queue" condition or the head would loop).
      // Declared OUTSIDE the try so the finally can demote the placeholder if
      // we bail before committing a live bubble.
      const flushBubbleId = flushBubbleRef.current.get(chatId);
      if (flushBubbleId) flushBubbleRef.current.delete(chatId);
      // A turn is already in flight for this chat (sendingChatsRef stays set
      // for the whole turn) — OR earlier sends are still queued/parked (a
      // holdQueue edit, or a queue awaiting drain): QUEUE this send FIFO and
      // flush it in order — instead of silently dropping it (the prior
      // behavior that made "send while the agent is working" vanish with no
      // feedback). The engine still only ever sees one turn at a time, so
      // there's no "prompt already in flight" rejection. Queued sends render
      // in the composer's queued-messages card (not the transcript).
      if (
        !flushBubbleId &&
        (sendingChatsRef.current.has(chatId) ||
          (sendQueueRef.current.get(chatId)?.length ?? 0) > 0 ||
          queueHeldRef.current.has(chatId))
      ) {
        const bubbleId = `queued-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const queuedMsg: AgentTextMessage = {
          id: bubbleId,
          kind: "text",
          role: "user",
          text: displayText ?? text,
          createdAt: Date.now(),
          queued: true,
          // The composer-based edit flow rebuilds the wire text through the
          // normal send pipeline (mentions re-expand), so an @-mention
          // expansion no longer blocks editing. The ONE remaining unsafe case
          // is a send whose wire text carries an invisible import preamble
          // (<from_previous_chat> blocks) — editing would silently drop it.
          queuedEditable:
            !autoAction && !text.trimStart().startsWith("<from_previous_chat"),
          ...(bubbleAttachments && bubbleAttachments.length > 0
            ? { attachments: bubbleAttachments }
            : {}),
          ...(segments && segments.length > 0 ? { segments } : {}),
          ...(autoAction ? { autoAction } : {}),
        };
        const slot = getStore().sessions[chatId];
        if (slot) {
          getStore().patchSession(chatId, {
            messages: capUserAppend(
              slot.messages,
              queuedMsg,
              slot.historyExpanded,
            ),
          });
        }
        const q = sendQueueRef.current.get(chatId) ?? [];
        q.push({
          args: [
            chatId,
            text,
            displayText,
            attachments,
            bubbleAttachments,
            segments,
            autoAction,
          ],
          bubbleId,
        });
        sendQueueRef.current.set(chatId, q);
        // The queue may be parked in an IDLE chat (nothing in flight to
        // trigger the turn-completion drain) — kick it so this send isn't
        // stranded. No-op while held/in-flight/non-ready.
        drainNextQueued(chatId);
        return;
      }
      sendingChatsRef.current.add(chatId);
      try {
        let current = getStore().sessions[chatId];
        if (!current || !current.agentId) return;
        if (current.status === "streaming") return;

        // If the session bounced (engine respawn, agent crashed mid-turn)
        // await one rebuild before dropping the prompt. Thread the slot's
        // cwd through — the chat may have been opened via loadIntoChat,
        // which is the only path that writes cwd to the slot from the
        // chat metadata, so without this the rebuild would land at the
        // gateway with cwd=undefined and surface "chat has no project
        // folder bound" the moment the engine respawned.
        //
        // 2026-07-13 fix: the rebuild must ALSO carry the chat's composer env
        // (model/effort/fast/dirs via envForChat). This path used to pass cwd
        // only, minting a session with NO model env at all — the engine then
        // ran the CLI's own default model while the pill showed the chat's
        // pick (the "pill says Haiku, turn ran Opus" bug, e.g. via the
        // dispatcher auto-send racing ahead of the chat view's spawn effect).
        if (!current.sessionId && ensureSessionRef.current) {
          try {
            await ensureSessionRef.current(chatId, current.agentId, {
              cwd: current.cwd ?? undefined,
              env: chatComposerEnv(chatId, current.initialize),
            });
          } catch {
            /* ensureSession patches the slot with the failure */
          }
          current = getStore().sessions[chatId];
          if (!current || !current.sessionId) return;
        }
        if (!current.sessionId) return;

        // Settings-drift reconcile (2026-07-13): the composer's model/effort
        // pills can change while a session is warming — the live
        // setModel/updateConfig calls silently no-op without a sessionId, and
        // the chat view's envKey respawn detector can be poisoned by an
        // already-existing session (it stamps the current key without
        // verifying what the session was created with). This is the single
        // choke point every prompt passes through, so verify HERE: if the
        // chat's current env differs from what the live session was actually
        // created/updated with, force-respawn with the right env first (the
        // rebuild resumes — Claude session id / Codex thread / Cursor agent —
        // so the conversation survives). Undefined appliedChatEnvKey = legacy
        // slot from before this guard → skip rather than respawn on unknowns.
        {
          const expected = chatComposerEnv(chatId, current.initialize);
          if (
            expected &&
            current.agentId &&
            current.appliedChatEnvKey !== undefined &&
            current.appliedChatEnvKey !== chatEnvDriftKey(expected) &&
            ensureSessionRef.current
          ) {
            try {
              await ensureSessionRef.current(chatId, current.agentId, {
                cwd: current.cwd ?? undefined,
                env: expected,
                force: true,
              });
            } catch {
              /* ensureSession patches the slot with the failure */
            }
            current = getStore().sessions[chatId];
            if (!current || !current.sessionId) return;
          }
        }

        const userMessage: AgentTextMessage = {
          id: `user-${Date.now()}`,
          kind: "text",
          role: "user",
          text: displayText ?? text,
          createdAt: Date.now(),
          // Phase D2 (2026-05-07) iter 4: persist attachment chips on
          // the user bubble so the timeline shows them right above the
          // text — matches what the user staged in the composer.
          // Empty array → undefined so we don't bloat persisted JSON
          // for prompts without attachments.
          ...(bubbleAttachments && bubbleAttachments.length > 0
            ? { attachments: bubbleAttachments }
            : {}),
          ...(segments && segments.length > 0 ? { segments } : {}),
          ...(autoAction ? { autoAction } : {}),
        };
        // Mid-chat /add-dir awareness. The gateway's first-turn preamble already
        // names the dirs present when the chat started (and a resumed chat has
        // them in its transcript); here we tell the agent about a dir ADDED LATER,
        // once, on the next turn it sends. Prepended to the AGENT text only — the
        // displayed bubble (userMessage.text, above) stays clean.
        const chatDirs =
          useWorkspaceStore.getState().chats.find((c) => c.id === chatId)
            ?.additionalDirectories ?? [];
        const announced = announcedDirsRef.current.get(chatId);
        let dirNotice = "";
        if (!announced) {
          // First send for this chat (new OR reopened): seed with the current set
          // — already announced by the preamble / present in the resumed history.
          announcedDirsRef.current.set(chatId, new Set(chatDirs));
        } else {
          const fresh = chatDirs.filter((d) => !announced.has(d));
          if (fresh.length > 0) {
            dirNotice = buildAdditionalDirsSystemInstruction(fresh);
            for (const d of fresh) announced.add(d);
          }
        }
        const prompt: ContentBlock[] = [
          { type: "text", text: prependSystemInstruction(dirNotice, text) },
          ...(attachments ?? []),
        ];
        // Faithful-bubble payload: the engine persists this onto the user
        // message so a REOPENED chat re-renders inline mention/attachment pills
        // exactly as composed. Without it the engine only knows the wire
        // `prompt` text and a reloaded bubble falls back to plain backtick text
        // (the "pills disappear on reopen" bug). Omitted when there's nothing
        // rich to carry so plain prompts don't bloat the wire.
        //
        // displayText ALSO shields the persisted bubble from the wire prompt's
        // <system_instruction> dir notice: persistUserPrompt stores the wire text
        // VERBATIM whenever the bubble carries no displayText, so a notice-bearing
        // turn would otherwise render the raw block inside the user's own message
        // on reopen. When a notice is present we carry the clean text (the
        // mention/import displayText if any, else `text`) so the engine persists
        // THAT, not the notice. The live optimistic bubble is already clean.
        const bubbleDisplayText = displayText ?? (dirNotice ? text : null);
        const bubble: AgentPromptBubble | undefined =
          (segments && segments.length > 0) ||
          (bubbleAttachments && bubbleAttachments.length > 0) ||
          (bubbleDisplayText != null && bubbleDisplayText !== text) ||
          autoAction != null ||
          dirNotice !== ""
            ? {
                ...(bubbleDisplayText != null
                  ? { displayText: bubbleDisplayText }
                  : {}),
                ...(segments && segments.length > 0 ? { segments } : {}),
                ...(bubbleAttachments && bubbleAttachments.length > 0
                  ? { attachments: bubbleAttachments }
                  : {}),
                ...(autoAction != null ? { autoAction } : {}),
              }
            : undefined;

        // Append the user bubble immediately for instant UX feedback.
        getStore().patchSession(chatId, {
          status: "streaming",
          error: null,
          lastStopReason: null,
          // On a queued-send flush, PROMOTE the placeholder: remove the
          // greyed bubble (its array slot is mid-previous-turn — queued
          // messages render in the composer's queued-card, not the
          // transcript) and append the live bubble at the end, where the new
          // turn actually starts. Otherwise append normally.
          messages: flushBubbleId
            ? promoteToEnd(
                current.messages,
                flushBubbleId,
                userMessage,
                current.historyExpanded,
              )
            : capUserAppend(
                current.messages,
                userMessage,
                current.historyExpanded,
              ),
        });
        // New turn → no streamed output yet. The update listener flips this true
        // on the first assistant chunk; the recoverable-failure handler below
        // reads it to decide whether a resend would duplicate the turn.
        turnProducedOutputRef.current.set(chatId, false);

        // Phase B2 (2026-05-07): the prompt argument is now parameterised
        // so rebuildAndRetry can prepend a <previous_conversation> replay
        // preamble to it on session-expired fallbacks. Pre-Phase-B2 the
        // closure baked in a single ContentBlock[]; the retry path now
        // builds a different one.
        const runPrompt = async (
          sessionId: string,
          promptToSend: ContentBlock[],
        ): Promise<AgentPromptCompleteMessage | AgentPromptFailedMessage> =>
          new Promise((resolve, reject) => {
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | null = null;
            let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
            let settled = false;

            const cleanup = () => {
              settled = true;
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              if (absoluteTimer) {
                clearTimeout(absoluteTimer);
                absoluteTimer = null;
              }
              if (promptActivityRef.current.get(chatId) === touchActivity) {
                promptActivityRef.current.delete(chatId);
              }
            };
            const finishResolve = (
              value: AgentPromptCompleteMessage | AgentPromptFailedMessage,
            ) => {
              if (settled) return;
              cleanup();
              resolve(value);
            };
            const finishReject = (err: unknown) => {
              if (settled) return;
              cleanup();
              reject(err);
            };
            const touchActivity = () => {
              if (settled) return;
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                const err = promptInactivityError();
                controller.abort();
                finishReject(err);
              }, PROMPT_INACTIVITY_TIMEOUT_MS);
            };

            promptActivityRef.current.set(chatId, touchActivity);
            touchActivity();
            // Absolute ceiling: set ONCE, never reset by touchActivity, so a
            // half-open transport under `timeoutMs: 0` (below) can't hold this
            // promise — and the sendingChatsRef lock gating every later send —
            // forever. See PROMPT_ABSOLUTE_TIMEOUT_MS. Reuses the inactivity
            // error so the settle reads as a hard stall (→ failed, retry-by-send).
            absoluteTimer = setTimeout(() => {
              controller.abort();
              finishReject(promptInactivityError());
            }, PROMPT_ABSOLUTE_TIMEOUT_MS);

            void bridge
              .request<AgentPromptCompleteMessage | AgentPromptFailedMessage>(
                {
                  type: "AGENT_PROMPT",
                  agentId: current.agentId!,
                  sessionId,
                  prompt: promptToSend,
                  // Persist the user msg under the renderer's id so turn ids align
                  // (the footer + reset key on it) without a transcript re-window.
                  userMessageId: userMessage.id,
                  ...(bubble ? { bubble } : {}),
                },
                { timeoutMs: 0, signal: controller.signal },
              )
              .then(finishResolve, finishReject);
          });

        // Whether there's genuine prior context to preserve on a rebuild.
        // A brand-new chat (no agent turn yet) has nothing to "continue", so
        // we never replay or show the "Continuing session" notice for it —
        // that banner on a first "hi" was pure confusion.
        const hasPriorContext = current.messages.some(
          (m) => m.kind === "text" && m.role === "agent",
        );

        // Re-establish the SAME session id in the (usually freshly-respawned)
        // engine via loadSession, then retry THIS prompt on it. --resume gives
        // the agent its context from Claude's own on-disk transcript, so NO
        // replay preamble / "Continuing session" banner is needed. Returns the
        // prompt result, or null if loadSession didn't re-establish (caller
        // then falls back to a cold rebuild).
        const tryResumeSameSession = async (
          sessionId: string,
        ): Promise<
          AgentPromptCompleteMessage | AgentPromptFailedMessage | null
        > => {
          try {
            const presetEnv = await deriveProviderEnv(current.agentId!);
            const mcpSecretEnv = await deriveMcpSecretEnv(
              bridge,
              current.cwd ?? null,
            );
            const envVaultEnv = await deriveEnvVaultEnv(
              bridge,
              current.cwd ?? null,
            );
            const mergedEnv =
              Object.keys(presetEnv).length > 0 ||
              Object.keys(mcpSecretEnv).length > 0 ||
              Object.keys(envVaultEnv).length > 0
                ? {
                    ...mcpSecretEnv,
                    ...envVaultEnv,
                    ...presetEnv,
                  }
                : undefined;
            const resumeWorkspaceId = await resolveSpawnWorkspaceId(
              bridge,
              current.cwd ?? null,
            );
            const loaded = await bridge.request<
              AgentSessionLoadedMessage | AgentErrorMessage
            >(
              {
                type: "AGENT_LOAD_SESSION",
                agentId: current.agentId!,
                chatId,
                sessionId,
                cwd: current.cwd ?? undefined,
                workspaceId: resumeWorkspaceId ?? undefined,
                env: mergedEnv,
                cliBinary: getProviderBinaryOverride(current.agentId!),
              },
              60_000,
            );
            if (loaded.type !== "AGENT_SESSION_LOADED") return null;
            return await runPrompt(sessionId, prompt);
          } catch {
            return null;
          }
        };

        const rebuildAndRetry = async (opts?: {
          replayHistory?: boolean;
        }): Promise<
          AgentPromptCompleteMessage | AgentPromptFailedMessage | null
        > => {
          // ── True-resume fast path ───────────────────────────────
          // The session is almost always just gone from a restarted engine
          // (a dev HMR respawn on a src/engine save, or the watchdog) — NOT a
          // genuine vendor-side expiry. Re-attach the SAME session id and
          // retry with --resume: full context, NO replay preamble, NO
          // "Continuing session" banner. Only when there's prior context to
          // preserve — a fresh chat falls straight through to a cold start.
          if (opts?.replayHistory && current.sessionId && hasPriorContext) {
            getStore().patchSession(chatId, {
              status: "warming",
              error: null,
              failure: null,
            });
            const resumed = await tryResumeSameSession(current.sessionId);
            if (resumed) {
              const resumeFailedRecoverably =
                resumed.type === "AGENT_PROMPT_FAILED" &&
                failureIsRecoverable(
                  failureFromAgentError(
                    {
                      ...resumed,
                      message: resumed.error,
                    } as unknown as AgentErrorMessage,
                    "prompt",
                  ),
                );
              // Clean success (or a non-recoverable failure the user must
              // see) ends here. Only a recoverable RE-failure (a real
              // --resume rejection: "no conversation found") falls through to
              // the cold rebuild + replay-preamble path below.
              if (!resumeFailedRecoverably) {
                getStore().patchSession(chatId, {
                  status: "streaming",
                  error: null,
                  failure: null,
                });
                return resumed;
              }
            }
          }

          // ── Cold rebuild (fresh session) ────────────────────────
          getStore().patchSession(chatId, {
            status: "warming",
            error: null,
            failure: null,
          });
          try {
            // Phase 2 chat overhaul (2026-05-07): thread the chat's
            // original cwd through the rebuild so the strict gateway
            // doesn't reject the force-call with "chat has no project
            // folder bound." `current` is the pre-rebuild slot snapshot
            // captured at sendPrompt entry — its cwd was set when the
            // chat first warmed (see ensureSession's setSession block).
            await ensureSessionRef.current?.(chatId, current.agentId!, {
              force: true,
              cwd: current.cwd ?? undefined,
            });
          } catch {
            /* surfaces via store below */
          }
          const rebuilt = getStore().sessions[chatId];
          if (!rebuilt?.sessionId || rebuilt.status !== "ready") return null;

          // Phase B2: when the rebuild was triggered by session-expired,
          // prepend the prior conversation as a replay preamble so the
          // fresh agent has context. The stitch is INVISIBLE by design
          // (2026-07-06 user spec): no "Continuing session" notice, no
          // divider — the user just keeps typing and it works. Replay
          // ONLY when there's real prior context to restore; a fresh
          // chat (no agent turn yet) reaching the cold-rebuild path just
          // starts clean. Reaching here WITH hasPriorContext means the
          // true-resume fast path above couldn't restore the session
          // (genuine --resume rejection), so replaying is the correct
          // fallback to avoid agent amnesia.
          let promptToSend: ContentBlock[] = prompt;
          let messagesAfterRebuild = rebuilt.messages;
          const userMsgIndex = rebuilt.messages.findIndex(
            (m) => m.id === userMessage.id,
          );
          if (opts?.replayHistory && hasPriorContext) {
            const replay = synthesizeReplayPrompt(rebuilt.messages);
            if (replay.text) {
              promptToSend = [{ type: "text", text: replay.text }, ...prompt];
            }
          }
          if (userMsgIndex < 0) {
            // Defensive fallback — userMessage was somehow pruned from
            // the slot (it's normally already there via capUserAppend
            // pre-runPrompt). Re-append so the prompt stays visible.
            messagesAfterRebuild = capUserAppend(
              rebuilt.messages,
              userMessage,
              rebuilt.historyExpanded,
            );
          }

          getStore().patchSession(chatId, {
            status: "streaming",
            error: null,
            failure: null,
            lastStopReason: null,
            messages: messagesAfterRebuild,
          });
          return runPrompt(rebuilt.sessionId, promptToSend);
        };

        const turnStartedAt = Date.now();
        // Arm TTFT for this turn — the first streamed chunk (detected in the
        // AGENT_SESSION_UPDATE listener above) emits agent_first_response with
        // the time since now. Covers any rebuild/retry below, so it reflects the
        // user-perceived "send → first token" latency.
        trackAgentTurnStarted(current.agentId!, chatId);
        try {
          let resp:
            | AgentPromptCompleteMessage
            | AgentPromptFailedMessage
            | null;
          try {
            resp = await runPrompt(current.sessionId, prompt);
          } catch (firstErr) {
            const failure = classifyRpcError({
              agentId: current.agentId!,
              stage: "prompt",
              error: firstErr,
            });
            if (!failureIsRecoverable(failure)) {
              getStore().patchSession(chatId, {
                status: statusForFailure(failure),
                error: failure.message,
                failure,
              });
              return;
            }
            // Cursor duplicate-turn guard: if this turn ALREADY streamed
            // assistant content, the recoverable error is a transport blip
            // (forceReconnect / socket close) whose engine-side turn is still
            // alive — it produced its answer, which already landed via
            // AGENT_SESSION_UPDATE. Re-running the prompt on a fresh session
            // would stream the same turn a second time. Treat it as complete.
            if (turnProducedOutputRef.current.get(chatId)) {
              getStore().patchSession(chatId, {
                status: "ready",
                error: null,
                failure: null,
              });
              return;
            }
            // Phase B2: only replay history when the failure indicates
            // the agent's session is gone. transport-closed / timeout
            // are network glitches — the agent's context is still alive
            // on the other end of the rebuild, so no replay needed.
            resp = await rebuildAndRetry({
              replayHistory: failure.kind === "session-expired",
            });
            if (!resp) return;
          }

          if (resp.type === "AGENT_PROMPT_FAILED") {
            // If the user just clicked Cancel, this PROMPT_FAILED is the
            // expected exit of the SIGTERM'd subprocess — not a real
            // failure. The cancel handler already optimistically flipped
            // status to ready; just clear the flag and bail.
            if (getStore().cancellingChats.has(chatId)) {
              getStore().setCancelling(chatId, false);
              return;
            }
            const failure = failureFromAgentError(
              { ...resp, message: resp.error } as unknown as AgentErrorMessage,
              "prompt",
            );
            // Phase 2 chat overhaul (2026-05-07): if the agent reported a
            // recoverable failure (most often `session-expired` — Codex
            // "no rollout found", Claude "session not found"), silently
            // rebuild a fresh session and retry the same prompt instead
            // of surfacing a hard error to the user. Pattern B from
            // docs/research/09_session_resume_patterns.md. Without this
            // hop, the user saw an "Error: Session expired" pill and a
            // disabled composer — for what should be self-healing.
            if (failureIsRecoverable(failure)) {
              // Same cursor duplicate-turn guard as the throw path above: a
              // recoverable AGENT_PROMPT_FAILED for a turn that already streamed
              // content means the answer is in; don't rebuild + resend.
              if (turnProducedOutputRef.current.get(chatId)) {
                getStore().patchSession(chatId, {
                  status: "ready",
                  error: null,
                  failure: null,
                });
                return;
              }
              const retried = await rebuildAndRetry({
                replayHistory: failure.kind === "session-expired",
              });
              if (!retried) return;
              if (retried.type === "AGENT_PROMPT_FAILED") {
                // The retry itself failed — surface the second failure
                // without a third attempt. Two strikes is enough.
                const retryFailure = failureFromAgentError(
                  {
                    ...retried,
                    message: retried.error,
                  } as unknown as AgentErrorMessage,
                  "prompt",
                );
                getStore().patchSession(chatId, {
                  status: statusForFailure(retryFailure),
                  error: retryFailure.message,
                  failure: retryFailure,
                });
                return;
              }
              resp = retried;
            } else {
              getStore().patchSession(chatId, {
                status: statusForFailure(failure),
                error: failure.message,
                failure,
              });
              return;
            }
          }

          // Fold per-turn usage counters into the running session total.
          // Read the incoming wire object with the CANONICAL TurnUsage field
          // names the engine actually sends (cacheReadTokens / cacheWriteTokens
          // / reasoningTokens) — NOT the store's AgentUsage names. These match
          // the analytics block below; keeping the two casts in sync is what
          // prevents the "cache always 0" drift this fold used to have.
          const turnUsage = (resp.response as { usage?: unknown } | undefined)
            ?.usage as
            | {
                inputTokens?: number;
                outputTokens?: number;
                cacheReadTokens?: number;
                cacheWriteTokens?: number;
                reasoningTokens?: number;
              }
            | undefined;
          const slot = getStore().sessions[chatId];
          if (!slot) return;
          const wasCancelling = getStore().cancellingChats.has(chatId);
          if (wasCancelling) getStore().setCancelling(chatId, false);
          const u = slot.usage;
          const nextUsage: AgentUsage = turnUsage
            ? {
                ...u,
                inputTokens: u.inputTokens + (turnUsage.inputTokens ?? 0),
                outputTokens: u.outputTokens + (turnUsage.outputTokens ?? 0),
                cachedReadTokens:
                  u.cachedReadTokens + (turnUsage.cacheReadTokens ?? 0),
                cachedWriteTokens:
                  u.cachedWriteTokens + (turnUsage.cacheWriteTokens ?? 0),
                thoughtTokens:
                  u.thoughtTokens + (turnUsage.reasoningTokens ?? 0),
              }
            : u;
          getStore().patchSession(chatId, {
            status: "ready",
            lastStopReason: wasCancelling
              ? "cancelled"
              : resp.type === "AGENT_PROMPT_COMPLETE"
                ? resp.stopReason
                : null,
            usage: nextUsage,
          });
          // Live model-list refresh. Some agents (Claude) only learn their real
          // model list AFTER the first prompt — query.supportedModels() needs a
          // live query — so the initialize captured at newSession is the
          // cold-start floor (`_meta.modelsDynamic` set, no `_meta.models`). Once
          // discovery lands, the agent-level initialize re-poll carries the live
          // list; re-fetch it here and patch THIS already-open chat so its picker
          // stops showing the floor. Fire-and-forget + self-limiting: the guard is
          // false once models are present (or for static / already-populated
          // agents like Codex, whose session initialize has models at
          // newSession), so it stops firing after at most a turn or two.
          void (async () => {
            const refreshAgentId = current.agentId;
            if (!refreshAgentId || !bridge) return;
            const stale = getStore().sessions[chatId]?.initialize?._meta as
              | { models?: unknown; modelsDynamic?: unknown }
              | undefined;
            const stillFloored =
              !!stale?.modelsDynamic &&
              !(Array.isArray(stale.models) && stale.models.length > 0);
            if (!stillFloored) return;
            try {
              const initResp = await bridge.request<
                AgentAgentInitializedMessage | AgentErrorMessage
              >({ type: "AGENT_INIT_AGENT", agentId: refreshAgentId }, 30_000);
              if (initResp.type === "AGENT_ERROR") return;
              const freshMeta = initResp.initialize?._meta as
                | { models?: unknown }
                | undefined;
              if (
                !Array.isArray(freshMeta?.models) ||
                freshMeta.models.length === 0
              ) {
                return; // discovery not done yet — a later turn retries
              }
              // Re-check the chat is still floored before patching (don't clobber
              // a concurrent update / a live model the user just picked).
              const cur = getStore().sessions[chatId]?.initialize?._meta as
                | { models?: unknown }
                | undefined;
              if (!(Array.isArray(cur?.models) && cur.models.length > 0)) {
                getStore().patchSession(chatId, {
                  initialize: initResp.initialize,
                });
              }
            } catch {
              /* best-effort — the picker keeps the cold-start floor */
            }
          })();
          // Analytics: a prompt turn completed. Metadata only — model NAME,
          // token counts, cost (best-effort per agent). No content.
          // Read usage with the CANONICAL TurnUsage field names the engine
          // sends (cacheReadTokens/reasoningTokens), not the store's
          // AgentUsage names used by the folding cast above.
          const tu = (
            resp.response as
              | {
                  usage?: {
                    inputTokens?: number;
                    outputTokens?: number;
                    cacheReadTokens?: number;
                    cacheWriteTokens?: number;
                    reasoningTokens?: number;
                    totalCostUsd?: number;
                  };
                }
              | undefined
          )?.usage;
          const chatModel =
            useWorkspaceStore.getState().chats.find((c) => c.id === chatId)
              ?.model ?? null;
          const completedStopReason =
            resp.type === "AGENT_PROMPT_COMPLETE" ? resp.stopReason : undefined;
          const turnDurationMs = Date.now() - turnStartedAt;
          trackAgentPromptCompleted({
            agentId: current.agentId!,
            chatId,
            stopReason: completedStopReason,
            durationMs: turnDurationMs,
            model: chatModel,
            inputTokens: tu?.inputTokens,
            outputTokens: tu?.outputTokens,
            costUsd: tu?.totalCostUsd,
          });
          // PostHog native LLM Analytics — populates the cost/token/latency
          // dashboards for every agent that now reports usage.
          trackAiGeneration({
            agentId: current.agentId!,
            model: chatModel,
            traceId: slot.sessionId,
            latencyMs: turnDurationMs,
            inputTokens: tu?.inputTokens,
            outputTokens: tu?.outputTokens,
            cacheReadTokens: tu?.cacheReadTokens,
            cacheWriteTokens: tu?.cacheWriteTokens,
            reasoningTokens: tu?.reasoningTokens,
            costUsd: tu?.totalCostUsd,
          });
        } catch (err) {
          // Same cancel-suppression as the AGENT_PROMPT_FAILED branch
          // above: the await chain may reject (timeout, transport-closed)
          // because the subprocess died from our SIGTERM, not from a
          // real fault. Don't surface as agent-error.
          if (getStore().cancellingChats.has(chatId)) {
            getStore().setCancelling(chatId, false);
            return;
          }
          const failure = classifyRpcError({
            agentId: current.agentId!,
            stage: "prompt",
            error: err,
          });
          getStore().patchSession(chatId, {
            status: statusForFailure(failure),
            error: failure.message,
            failure,
          });
        }
      } finally {
        sendingChatsRef.current.delete(chatId);
        // Drop a STRANDED plan-review card. A plan gate BLOCKS its turn, so in
        // the happy path Approve / a typed follow-up cleared pendingPermission
        // before we reached here — this only bites when the turn hit a terminal
        // state with the gate still pending (the adapter's 30-min auto-deny, or
        // a turn that died mid-plan), which would otherwise leave the
        // PlanReviewCard up with buttons that click into an already-resolved
        // gate. Gated to plan reviews (a real Allow/Deny gate is untouched).
        // Status is terminal by here, so a pending plan gate is stranded by
        // definition — see clearStrandedPlanReview.
        getStore().clearStrandedPlanReview(chatId);
        // If this was a queued-send flush that bailed BEFORE committing a live
        // bubble (e.g. the session couldn't be re-established under engine
        // churn), the placeholder is still present and greyed. Demote it to a
        // normal bubble — moved to the transcript END, since a queued
        // placeholder is invisible in the transcript (it lives in the
        // composer's queued-card) and its array slot is mid-old-turn — so the
        // user's typed text isn't silently lost; the chat already shows the
        // failure/reconnecting status. On the success path the placeholder was
        // already promoted, so this is a no-op. (Demoting clears `queued`, so
        // it now persists like any other user message.)
        if (flushBubbleId) {
          const slot = getStore().sessions[chatId];
          const ph = slot?.messages.find((m) => m.id === flushBubbleId);
          if (ph && ph.kind === "text" && ph.queued) {
            getStore().patchSession(chatId, {
              messages: capUserAppend(
                slot!.messages.filter((m) => m.id !== flushBubbleId),
                { ...ph, queued: false },
                slot!.historyExpanded,
              ),
            });
          }
        }
        // Flush the next queued send (FIFO) — but ONLY when the turn settled
        // HEALTHY and the queue isn't parked by an in-progress queued-message
        // edit. By here status is "ready" (success) or a failure state
        // (failed / reconnecting / auth-required), never "streaming".
        //
        // Draining into an UNHEALTHY chat is what turns a stuck turn into a
        // spawn storm: each queued send fires into the dead/rebuilding
        // session, hits a recoverable failure, and triggers a `force:true`
        // rebuild — which bypasses ensureSession's de-dup — so every queued
        // send mints a fresh AGENT_NEW_SESSION. Dozens of codex app-server
        // children pile up, the machine thrashes, turns hang, and the
        // composer freezes with an ever-growing queue that never sends.
        // When the turn didn't recover, STOP draining: drop the pending
        // queue and remove its greyed placeholders (mirrors cancel()) so the
        // user resends deliberately once the chat is healthy again.
        const settled = getStore().sessions[chatId];
        const queued = sendQueueRef.current.get(chatId);
        if (queued && queued.length > 0) {
          if (queueHeldRef.current.has(chatId)) {
            // Parked mid-edit: leave the queue (and its card rows) exactly as
            // they are — releaseQueue() drains once the edit resolves. Held
            // queues survive an unhealthy settle too; they only drain through
            // drainNextQueued, which re-checks status === "ready".
          } else if (settled?.status === "ready") {
            drainNextQueued(chatId);
          } else {
            // Turn settled UNHEALTHY (failed / reconnecting / auth-required) with
            // sends still queued behind it. Dropping (not draining) is deliberate:
            // draining into a broken chat spawn-storms, and KEEPING the queue would
            // freeze the composer (every fresh send parks behind an un-drainable
            // queue). But dropping SILENTLY meant the user's typed follow-ups just
            // vanished with no trace (field report). Same drop as before — now with
            // a toast so it's visible and the user knows to resend once healthy.
            const ids = new Set(queued.map((e) => e.bubbleId));
            sendQueueRef.current.delete(chatId);
            if (settled) {
              getStore().patchSession(chatId, {
                messages: settled.messages.filter(
                  (m) => !(m.kind === "text" && ids.has(m.id)),
                ),
              });
            }
            const n = queued.length;
            toast.warning(
              n === 1
                ? "A queued message wasn’t sent"
                : `${n} queued messages weren’t sent`,
              {
                description:
                  "This chat hit an error before your follow-up could go out — resend once it reconnects.",
              },
            );
          }
        }
      }
    },
    [bridge, getStore, drainNextQueued],
  );
  sendPromptRef.current = sendPrompt;

  const cancel = useCallback<SessionsActions["cancel"]>(
    async (chatId) => {
      if (!bridge) return;
      // Cancelling the active turn discards any sends queued behind it —
      // the user explicitly stopped, so the follow-ups shouldn't fire. Also
      // drop their greyed placeholder bubbles.
      const pendingQ = sendQueueRef.current.get(chatId);
      if (pendingQ?.length) {
        const ids = new Set(pendingQ.map((e) => e.bubbleId));
        const slot = getStore().sessions[chatId];
        if (slot) {
          getStore().patchSession(chatId, {
            messages: slot.messages.filter(
              (m) => !(m.kind === "text" && ids.has(m.id)),
            ),
          });
        }
      }
      sendQueueRef.current.delete(chatId);
      const current = getStore().sessions[chatId];
      if (!current?.agentId || !current.sessionId) return;
      // Optimistic state transition: cancel is intentional, the chat
      // should immediately be ready for the next prompt. The flag
      // suppresses the AGENT_PROMPT_FAILED that arrives when the
      // SIGTERM'd subprocess exits — we'd otherwise mark the chat as
      // failed and the user gets stuck behind an "agent error" tag.
      // The flag is cleared inside the prompt-failure handler when
      // the expected exit lands (or the next handler if a real failure
      // races in).
      getStore().setCancelling(chatId, true);
      getStore().patchSession(chatId, {
        status: "ready",
        error: null,
        failure: null,
        lastStopReason: "cancelled",
        // Drop any open permission prompt — the engine releases the gate on
        // cancel (adapter.cancel resolves pendingPermissions), so the inline
        // card would otherwise be stranded + clickable against a dead turn.
        pendingPermission: null,
        // Same for parked questions — adapter.cancel dismisses them engine-
        // side, so a leftover card would keep replacing the composer and
        // answer into a dead resolver.
        pendingQuestions: [],
      });
      bridge.send({
        type: "AGENT_CANCEL",
        agentId: current.agentId,
        sessionId: current.sessionId,
      });
    },
    [bridge, getStore],
  );

  const respondToPermission = useCallback<
    SessionsActions["respondToPermission"]
  >(
    (chatId, response) => {
      if (!bridge) return;
      const current = getStore().sessions[chatId];
      if (!current?.pendingPermission) return;
      bridge.send({
        type: "AGENT_PERMISSION_RESPONSE",
        permissionId: current.pendingPermission.permissionId,
        response,
      });
      promptActivityRef.current.get(chatId)?.();
      getStore().patchSession(chatId, { pendingPermission: null });
    },
    [bridge, getStore],
  );

  const respondToQuestion = useCallback<SessionsActions["respondToQuestion"]>(
    (chatId, response) => {
      if (!bridge) return;
      const current = getStore().sessions[chatId];
      const head = current?.pendingQuestions?.[0];
      if (!head) return;
      bridge.send({
        type: "AGENT_QUESTION_RESPONSE",
        questionId: head.questionId,
        response,
        // Vendor-id fallback: lets the adapter settle the ask even when its
        // questionId went stale (replay / session rebuild minted a fresh one
        // while this client deduped and kept the original).
        nativeRequestId: head.request.nativeRequestId,
      });
      promptActivityRef.current.get(chatId)?.();
      // Durable record: stamp the resolution onto the transcript tool message
      // — ANSWERED with per-question answers, or SKIPPED on dismiss — so the
      // read-only card shows the outcome after the composer card is gone
      // (best-effort — no-op if the tool message hasn't landed).
      const toolCallId = head.request.toolCallId;
      if (toolCallId) {
        getStore().stampQuestionAnswer(
          chatId,
          toolCallId,
          buildQuestionStamp(head.request, response.outcome),
        );
      }
      // Dequeue the head only — the next queued question (if any) surfaces.
      getStore().patchSession(chatId, {
        pendingQuestions: current.pendingQuestions.slice(1),
      });

      // Delivery watchdog (v2 — SELF-HEALING, 2026-07-04 field feedback: the
      // v1 re-queue+toast flow made the user re-answer in a loop). The engine
      // echoes AGENT_QUESTION_SETTLED right after resolving the parked SDK
      // promise — no echo means the answer never landed (dropped send during
      // a socket blip, or the engine settled/rebuilt the question
      // underneath). Recovery is now automatic and invisible:
      //   miss 1 → silently RE-SEND the same response (the socket usually
      //            healed; the engine drops a duplicate loudly-but-harmlessly).
      //   miss 2 → guaranteed-delivery fallback: release the stuck turn and
      //            deliver the answer as a regular next prompt. One toast
      //            explains what happened; the user never re-answers.
      //
      // CAPABILITY-GATED on request.expiresAt: only engines that stamp the
      // skip deadline also emit the settled echo (both shipped together). An
      // OLDER engine delivers answers fine but never echoes — arming the
      // watchdog against it would cry "stuck" on every healthy answer
      // (field report 2026-07-04, mixed-version dev run).
      if (typeof head.request.expiresAt !== "number") return;
      const questionId = head.questionId;
      const answeredAt = Date.now();
      const armWatchdog = () => {
        const prevTimer = answerAcksRef.current.get(questionId);
        if (prevTimer) clearTimeout(prevTimer);
        const timer = setTimeout(() => {
          answerAcksRef.current.delete(questionId);
          const slot = getStore().sessions[chatId];
          // Turn already over (finished / cancelled / crashed) — the missing
          // echo doesn't matter anymore.
          if (!slot || slot.status !== "streaming") return;
          // Echo-lost-but-answer-landed guard: if the agent visibly resumed
          // (any timeline activity after the answer), the answer WAS
          // delivered and only the receipt went missing — do nothing.
          const progressed = slot.messages.some(
            (m) =>
              (m as { updatedAt?: number }).updatedAt !== undefined &&
              (m as { updatedAt: number }).updatedAt > answeredAt + 500,
          );
          if (progressed) return;
          if (!retriedAnswersRef.current.has(questionId)) {
            // Miss 1 — silent re-send over the (hopefully healed) socket.
            retriedAnswersRef.current.add(questionId);
            bridge.send({
              type: "AGENT_QUESTION_RESPONSE",
              questionId,
              response,
              nativeRequestId: head.request.nativeRequestId,
            });
            armWatchdog();
            return;
          }
          // Miss 2 — the blocking channel is gone. Deliver the answer the
          // guaranteed way: stop the parked turn, send it as a prompt.
          retriedAnswersRef.current.delete(questionId);
          toast.warning("Answer didn't reach the agent", {
            description:
              "Delivering it as a message instead — no action needed.",
          });
          void (async () => {
            try {
              await cancel(chatId);
            } catch {
              /* best-effort — the send below still lands as the next turn */
            }
            try {
              await sendPromptRef.current?.(
                chatId,
                questionFallbackPrompt(head.request, response.outcome),
              );
            } catch {
              /* sendPrompt errors surface via session.error */
            }
          })();
        }, ANSWER_ACK_TIMEOUT_MS);
        answerAcksRef.current.set(questionId, timer);
      };
      armWatchdog();
    },
    [bridge, getStore, cancel],
  );

  const setMode = useCallback<SessionsActions["setMode"]>(
    async (chatId, modeId) => {
      if (!bridge) return;
      const current = getStore().sessions[chatId];
      if (!current?.agentId || !current.sessionId) return;
      // Optimistic flip; engine echoes back via AGENT_MODE_CHANGED or AGENT_ERROR.
      const previousModeId = current.currentModeId;
      getStore().patchSession(chatId, { currentModeId: modeId });
      // No timeline banner for the switch (user feedback 2026-06-10): a
      // "Switched mode X → Y" row per toggle was pure noise — the active
      // mode already shows on the Plan toggle + Permissions menu. The flip
      // above is the only state change; the engine round-trip below
      // confirms or reverts it.
      try {
        const resp = await bridge.request<
          AgentModeChangedMessage | AgentErrorMessage
        >(
          {
            type: "AGENT_SET_MODE",
            agentId: current.agentId,
            sessionId: current.sessionId,
            modeId,
          },
          10_000,
        );
        if (resp.type === "AGENT_ERROR") {
          getStore().patchSession(chatId, {
            currentModeId: previousModeId,
            error: resp.message,
          });
        }
      } catch (err) {
        getStore().patchSession(chatId, {
          currentModeId: previousModeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [bridge, getStore],
  );

  const setModel = useCallback<SessionsActions["setModel"]>(
    (chatId, model) => {
      if (!bridge || !model) return;
      const current = getStore().sessions[chatId];
      // Only meaningful for a LIVE session. The chat's model is already
      // persisted (UPDATE_CHAT_SETTINGS); this applies it to the running
      // session so it takes effect on the next turn without a rebuild.
      // Fire-and-forget — model changes are non-critical and the SDK
      // applies it on the next turn. Adapters without live model selection
      // ignore it (the choice still applies on the next session creation).
      if (!current?.agentId || !current.sessionId) return;
      bridge.send({
        type: "AGENT_SET_MODEL",
        agentId: current.agentId,
        sessionId: current.sessionId,
        model,
      });
    },
    [bridge, getStore],
  );

  const compactContext = useCallback<SessionsActions["compactContext"]>(
    (chatId) => {
      if (!bridge) return;
      const current = getStore().sessions[chatId];
      // Only meaningful for a LIVE session with a real compaction RPC
      // (agent-chat gates the trigger to Codex; Claude compacts via its
      // CLI-native "/compact" prompt instead). Fire-and-forget: the
      // "Compacting.." → "Context compacted" row streams back through the
      // normal session-update path.
      if (!current?.agentId || !current.sessionId) return;
      bridge.send({
        type: "AGENT_COMPACT",
        agentId: current.agentId,
        sessionId: current.sessionId,
      });
    },
    [bridge, getStore],
  );

  const updateConfig = useCallback<SessionsActions["updateConfig"]>(
    (chatId) => {
      if (!bridge) return;
      const current = getStore().sessions[chatId];
      // Only meaningful for a LIVE session. The chat's config (effort / fast /
      // ultracode / additionalDirectories / allow-deny / maxTurns) is already
      // persisted (UPDATE_CHAT_SETTINGS); this applies it to the running
      // session so it takes effect on the next turn without a rebuild.
      // No-op (just the persisted chat.* state stands) when there is no live
      // session yet — the config then applies on the next session creation.
      // Fire-and-forget — adapters without live config changes ignore it.
      if (!current?.agentId || !current.sessionId) return;
      // Config thread (carrying model/effort/fast/dirs/permissionMode) lives in
      // the workspace store, not the sessions store that `getStore` snapshots.
      const chat = useWorkspaceStore
        .getState()
        .chats.find((c) => c.id === chatId);
      if (!chat) return;
      // Build the full composer env via the SAME encoder session-creation uses,
      // so the live update and a respawn carry an identical config map.
      // `current.initialize` is passed for the same reason: sendPrompt's
      // reconcile compares against envForChat(chat, initialize), and a stamp
      // built WITHOUT it reads as drift for any agent that overrides its model
      // env var via _meta — which force-respawns the session COLD on the next
      // send (no resume, so the agent loses the conversation) for a change
      // that had already been applied live. The two must be built identically.
      const env = envForChat(chat, current.initialize);
      bridge.send({
        type: "AGENT_UPDATE_CONFIG",
        agentId: current.agentId,
        sessionId: current.sessionId,
        env,
      });
      // Settings-drift guard: this env is now live-applied — stamp it so
      // sendPrompt's reconcile doesn't ALSO force-respawn for the same change.
      //
      // Only stamp when the agent ACTUALLY applies config live. The gateway
      // silently no-ops AGENT_UPDATE_CONFIG for adapters without the optional
      // hook (cursor today), so stamping unconditionally would record a change
      // that never landed — sendPrompt would then skip its reconcile and run
      // the turn on the stale model/effort. Leaving the key stale is the
      // correct signal: the reconcile respawns at send time, once, instead of
      // on every pill click.
      if (!agentAppliesConfigLive(current.agentId)) return;
      getStore().patchSession(chatId, {
        appliedChatEnvKey: chatEnvDriftKey(env),
      });
    },
    [bridge, getStore],
  );

  const removeQueued = useCallback<SessionsActions["removeQueued"]>(
    (chatId, messageId) => {
      // Drop the pending queued send (by its placeholder bubble id) before
      // it flushes, and remove the greyed bubble from the transcript.
      const q = sendQueueRef.current.get(chatId);
      if (q) {
        const filtered = q.filter((e) => e.bubbleId !== messageId);
        if (filtered.length > 0) sendQueueRef.current.set(chatId, filtered);
        else sendQueueRef.current.delete(chatId);
      }
      const slot = getStore().sessions[chatId];
      if (slot) {
        getStore().patchSession(chatId, {
          messages: slot.messages.filter((m) => m.id !== messageId),
        });
      }
    },
    [getStore],
  );

  const editQueued = useCallback<SessionsActions["editQueued"]>(
    (chatId, messageId, payload) => {
      const text = payload.text.trim();
      const hasAttachments =
        (payload.attachments?.length ?? 0) > 0 ||
        (payload.bubbleAttachments?.length ?? 0) > 0 ||
        (payload.segments?.length ?? 0) > 0;
      // Empty edits are a no-op — use removeQueued to cancel a pending send.
      // Attachment-only edits are valid and must replace the queued payload.
      if (!text && !hasAttachments) return;
      const q = sendQueueRef.current.get(chatId);
      if (!q?.some((e) => e.bubbleId === messageId)) return;
      const displayText = payload.displayText ?? text;
      // Replace the still-pending send's FULL payload so the edit takes
      // effect when it flushes. The payload was built by the composer's
      // normal send pipeline (mentions re-expanded into `text`, attachments
      // re-encoded), so nothing from the original entry needs preserving —
      // including a (theoretical) autoAction: an edited message is
      // user-authored, so the 7th arg is deliberately dropped. (In practice
      // auto-sent bubbles are queued with queuedEditable=false, so this
      // path can't see one.)
      sendQueueRef.current.set(
        chatId,
        q.map((e) =>
          e.bubbleId === messageId
            ? {
                ...e,
                args: [
                  e.args[0],
                  text,
                  displayText,
                  payload.attachments,
                  payload.bubbleAttachments,
                  payload.segments,
                ] as Parameters<SessionsActions["sendPrompt"]>,
              }
            : e,
        ),
      );
      // Reflect the edit in the queued placeholder bubble (the card row).
      // Attachments/segments are replaced WHOLESALE — an edit that removed
      // the last attachment must clear the stale chip row too.
      const slot = getStore().sessions[chatId];
      if (slot) {
        getStore().patchSession(chatId, {
          messages: slot.messages.map((m) =>
            m.id === messageId && m.kind === "text"
              ? {
                  ...m,
                  text: displayText,
                  attachments:
                    payload.bubbleAttachments &&
                    payload.bubbleAttachments.length > 0
                      ? payload.bubbleAttachments
                      : undefined,
                  segments:
                    payload.segments && payload.segments.length > 0
                      ? payload.segments
                      : undefined,
                }
              : m,
          ),
        });
      }
    },
    [getStore],
  );

  const holdQueue = useCallback<SessionsActions["holdQueue"]>((chatId) => {
    queueHeldRef.current.add(chatId);
  }, []);

  const releaseQueue = useCallback<SessionsActions["releaseQueue"]>(
    (chatId) => {
      queueHeldRef.current.delete(chatId);
      // The turn may have settled while the queue was parked (the finally
      // skipped its drain) — pick the flush back up if the chat is idle.
      drainNextQueued(chatId);
    },
    [drainNextQueued],
  );

  const steerQueued = useCallback<SessionsActions["steerQueued"]>(
    async (chatId, messageId) => {
      if (!bridge) return false;
      const q = sendQueueRef.current.get(chatId);
      const entry = q?.find((e) => e.bubbleId === messageId);
      if (!entry) return false;
      const slot = getStore().sessions[chatId];
      if (!slot?.agentId) return false;

      // Claim the entry FIRST so a turn settling while the steer round-trips
      // can't ALSO flush it (double-send). Re-queued at the head on failure —
      // unless the placeholder vanished meanwhile (cancel dropped the queue).
      const claim = () => {
        const cur = sendQueueRef.current.get(chatId);
        if (!cur) return;
        const filtered = cur.filter((e) => e.bubbleId !== messageId);
        if (filtered.length > 0) sendQueueRef.current.set(chatId, filtered);
        else sendQueueRef.current.delete(chatId);
      };
      const unclaim = () => {
        const stillShown = getStore().sessions[chatId]?.messages.some(
          (m) => m.id === messageId,
        );
        if (!stillShown) return;
        const cur = sendQueueRef.current.get(chatId) ?? [];
        sendQueueRef.current.set(chatId, [entry, ...cur]);
      };

      // Idle chat (queue parked behind a hold, or a non-ready settle): "send
      // now" is a plain out-of-order flush through the normal prompt path.
      if (!sendingChatsRef.current.has(chatId)) {
        claim();
        flushBubbleRef.current.set(chatId, messageId);
        void sendPromptRef.current?.(...entry.args);
        return true;
      }

      if (!slot.sessionId) return false;
      const [
        ,
        text,
        displayText,
        attachments,
        bubbleAttachments,
        segments,
        autoAction,
      ] = entry.args;
      // Same wire shape sendPrompt builds — minus the /add-dir notice, which
      // is a next-real-prompt one-shot and shouldn't burn on a steer.
      const prompt: ContentBlock[] = [
        { type: "text", text },
        ...(attachments ?? []),
      ];
      const bubble: AgentPromptBubble | undefined =
        (segments && segments.length > 0) ||
        (bubbleAttachments && bubbleAttachments.length > 0) ||
        autoAction != null ||
        (displayText != null && displayText !== text)
          ? {
              ...(displayText != null ? { displayText } : {}),
              ...(segments && segments.length > 0 ? { segments } : {}),
              ...(bubbleAttachments && bubbleAttachments.length > 0
                ? { attachments: bubbleAttachments }
                : {}),
              ...(autoAction != null ? { autoAction } : {}),
            }
          : undefined;
      claim();
      try {
        const resp = await bridge.request<
          AgentSteeredMessage | AgentErrorMessage
        >(
          {
            type: "AGENT_STEER",
            agentId: slot.agentId,
            sessionId: slot.sessionId,
            prompt,
            userMessageId: messageId,
            ...(bubble ? { bubble } : {}),
          },
          // Bounded: an engine that predates AGENT_STEER drops the frame
          // (no reply), and the queued message must resurface promptly.
          { timeoutMs: 15_000 },
        );
        if (resp.type !== "AGENT_STEERED") {
          unclaim();
          return false;
        }
      } catch {
        unclaim();
        return false;
      }
      // Delivered into the running turn. Promote the placeholder to a live
      // user bubble at the transcript END — events that stream in after it
      // group under it as the steered turn (mirrors the flush promotion).
      const fresh = getStore().sessions[chatId];
      const ph = fresh?.messages.find((m) => m.id === messageId);
      if (fresh && ph && ph.kind === "text") {
        getStore().patchSession(chatId, {
          messages: promoteToEnd(
            fresh.messages,
            messageId,
            {
              ...ph,
              queued: false,
              queuedEditable: undefined,
              createdAt: Date.now(),
            },
            fresh.historyExpanded,
          ),
        });
      }
      return true;
    },
    [bridge, getStore],
  );

  const reset = useCallback<SessionsActions["reset"]>(
    (chatId) => {
      getStore().removeSession(chatId);
      // Drop on-disk transcript too so a "reset" really starts clean.
      void persistClearChat(chatId).catch((err) => {
        console.warn("[Zeros agent-history] reset clear failed:", err);
      });
    },
    [getStore],
  );

  // Cross-device message sync: re-window a chat against the engine when its
  // transcript changed on ANOTHER device. The robust backbone behind "messages
  // sync Mac↔web" — independent of live AGENT_SESSION_UPDATE routing, which
  // drops updates for an unopened chat or mid force-respawn. Skips a chat that
  // is actively streaming HERE (the live turn is canonical) and no-ops when the
  // window already matches, so it's cheap to call on every nudge.
  const reconcileChatMessages = useCallback(
    (chatId: string): Promise<void> => {
      if (!chatId) return Promise.resolve();
      const existingRequest = reconcileInFlightRef.current.get(chatId);
      if (existingRequest) return existingRequest;
      const request = (async () => {
        const store = getStore();
        const slot = store.sessions[chatId];
        if (!slot) return; // not open here → hydrates fresh when opened
        if (slot.status === "streaming") return; // live turn here is canonical
        try {
          const windowed = dedupeConsecutiveMessages(
            await persistWindowMessages(chatId, HYDRATE_WINDOW),
          );
          const fresh = store.sessions[chatId];
          if (!fresh || fresh.status === "streaming") return; // re-check post-await
          const cur = fresh.messages;
          // No-op guard: same count + same last id → nothing new, skip re-render.
          if (
            cur.length === windowed.length &&
            cur[cur.length - 1]?.id === windowed[windowed.length - 1]?.id
          ) {
            return;
          }
          // Merge the engine's authoritative window into the local slot: keep
          // scrolled-up history, drop a remotely-truncated tail, and don't let a
          // transient empty read wipe the slot. See mergeWindowedTail.
          const next: AgentMessage[] = mergeWindowedTail(cur, windowed);
          store.setSession(chatId, { ...fresh, messages: next });
        } catch (err) {
          console.warn("[Zeros agent-history] message reconcile failed:", err);
        }
      })().finally(() => {
        if (reconcileInFlightRef.current.get(chatId) === request) {
          reconcileInFlightRef.current.delete(chatId);
        }
      });
      reconcileInFlightRef.current.set(chatId, request);
      return request;
    },
    [getStore],
  );

  const hydrateChat = useCallback<SessionsActions["hydrateChat"]>(
    (chatId) => {
      const existingRequest = hydrateInFlightRef.current.get(chatId);
      if (existingRequest) return existingRequest;
      const request = (async () => {
        // Fix #2 — refresh the device-local policy slice alongside message
        // hydration. The store mutator preserves its reference when unchanged.
        void getStore().hydrateChatPolicies(chatId);

        const slot = getStore().sessions[chatId];
        // Already populated — but it may be STALE: newer messages can land on
        // another device while this slot sits idle. Reconcile against the engine
        // (a no-op when already current; skips a live in-flight turn) instead of
        // blindly trusting the in-memory snapshot, so re-opening shows the latest.
        if (slot && slot.messages.length > 0) {
          void reconcileChatMessages(chatId);
          return;
        }
        // The slot is cold, so this read DECIDES what the user sees. An empty
        // result is only trustworthy on a connected bridge — transport absence
        // and mid-respawn requests reject. Park the chat and let the
        // connected-edge drain retry, instead
        // of committing a blank transcript that nothing ever repairs.
        if (!bridge || bridge.status !== "connected") {
          pendingHydratesRef.current.add(chatId);
          return;
        }
        try {
          const messages = await persistWindowMessages(chatId, HYDRATE_WINDOW);
          pendingHydratesRef.current.delete(chatId);
          if (messages.length === 0) return;
          // Pre-fix builds (before 2026-04-26) wrote agent replay events
          // to disk on every reopen, so existing chats have stacked
          // duplicates. Collapse runs of identical consecutive messages
          // before showing them. New duplicates can't accrue anymore — no
          // current adapter replays its transcript on resume — so this is
          // purely cleanup of pre-existing disk content + the safety net
          // should a future adapter ever start replaying.
          const deduped = dedupeConsecutiveMessages(messages);
          // Re-read the slot after the await — the user may have started
          // typing while we were fetching, in which case live state wins.
          const fresh = getStore().sessions[chatId];
          if (fresh && fresh.messages.length > 0) return;
          getStore().setSession(chatId, {
            ...BLANK,
            ...(fresh ?? {}),
            messages: deduped,
          });
        } catch (err) {
          // Rejected read (timeout / engine swap mid-request) — same rule as the
          // disconnected case above: retry on the next connected edge.
          pendingHydratesRef.current.add(chatId);
          console.warn("[Zeros agent-history] hydrate failed:", err);
        }
      })().finally(() => {
        if (hydrateInFlightRef.current.get(chatId) === request) {
          hydrateInFlightRef.current.delete(chatId);
        }
      });
      hydrateInFlightRef.current.set(chatId, request);
      return request;
    },
    [bridge, getStore, reconcileChatMessages],
  );

  // Drain parked hydrates when the bridge (re)connects. Only chats that still
  // exist and whose slot is still empty re-fetch — a chat the user closed, or
  // one a live stream populated meanwhile, is skipped. hydrateChat re-parks on
  // failure, so a flapping socket converges instead of dropping the retry.
  useEffect(() => {
    if (bridgeStatus !== "connected") return;
    if (pendingHydratesRef.current.size === 0) return;
    const parked = [...pendingHydratesRef.current];
    pendingHydratesRef.current.clear();
    const chats = useWorkspaceStore.getState().chats;
    for (const id of parked) {
      if (!chats.some((c) => c.id === id)) continue;
      const slot = getStore().sessions[id];
      if (slot && slot.messages.length > 0) continue;
      void hydrateChat(id);
    }
  }, [bridgeStatus, hydrateChat, getStore]);

  // Apply the engine's transcript-changed nudge. When a turn runs (or an edit
  // happens) on ANOTHER device, the engine broadcasts DB_CHANGED({kinds:
  // ["messages"], chatIds}) (debounced); re-window each named open chat so it
  // shows up here — the cross-device "messages sync" path, robust to live-stream
  // routing gaps. Desktop ignores its OWN nudges (running slot) and reflects a
  // remote device's edits the same way the web reflects the Mac's.
  useEffect(() => {
    if (!bridge) return;
    const unsub = bridge.on("DB_CHANGED", (raw) => {
      const m = raw as { kinds?: unknown; chatIds?: unknown };
      const kinds = Array.isArray(m.kinds) ? (m.kinds as string[]) : [];
      if (!kinds.includes("messages")) return;
      const ids = Array.isArray(m.chatIds) ? (m.chatIds as string[]) : [];
      // chatIds is always set for "messages"; fall back to every open chat.
      const targets = ids.length > 0 ? ids : Object.keys(getStore().sessions);
      for (const id of targets) void reconcileChatMessages(id);
    });
    return unsub;
  }, [bridge, getStore, reconcileChatMessages]);

  const listSessionsFor = useCallback<SessionsActions["listSessionsFor"]>(
    async (agentId, opts) => {
      if (!bridge) throw new Error("Engine not connected");
      const resp = await bridge.request<
        AgentSessionsListMessage | AgentErrorMessage
      >(
        {
          type: "AGENT_LIST_SESSIONS",
          agentId,
          cwd: opts?.cwd,
          cursor: opts?.cursor,
        },
        30_000,
      );
      if (resp.type === "AGENT_ERROR") throw new Error(resp.message);
      return {
        sessions: resp.sessions,
        nextCursor: resp.nextCursor ?? null,
      };
    },
    [bridge],
  );

  const loadIntoChat = useCallback<SessionsActions["loadIntoChat"]>(
    async (chatId, agentId, sessionId, options) => {
      if (!bridge) return;
      // Preserve any messages already in the slot (typically just put
      // there by hydrateChat) — wiping them here is what produced the
      // "chat empty on reopen" bug for agents whose loadSession doesn't
      // replay (Codex, Cursor). Disk is the source of truth.
      const existing = getStore().sessions[chatId];
      // Persist cwd on the slot so any later rebuild path (sendPrompt
      // recovery, rebuildAndRetry, env-change force respawn) can reuse
      // it. Before this fix, loadIntoChat's spread `...BLANK` clobbered
      // cwd to null even though the bridge call below carried it
      // correctly — so the FIRST send worked but a session-expired
      // rebuild minutes later threw "chat has no project folder bound."
      // resolveSpawnCwd also recovers the chat's own folder from the store.
      const resolvedCwd = resolveSpawnCwd(chatId, options?.cwd, existing?.cwd);
      getStore().setSession(chatId, {
        ...BLANK,
        agentId,
        agentName: options?.agentName ?? agentId,
        sessionId,
        cwd: resolvedCwd,
        status: "warming",
        messages: existing?.messages ?? [],
      });
      try {
        // Resume must honour the same Provider prefs as new sessions:
        // env injection for API-key mode + binary-path override for the
        // /Settings → Advanced disclosure.
        const presetEnv = await deriveProviderEnv(agentId);
        const mcpSecretEnv = await deriveMcpSecretEnv(bridge, resolvedCwd);
        const envVaultEnv = await deriveEnvVaultEnv(bridge, resolvedCwd);
        const mergedEnv =
          options?.env ||
          Object.keys(presetEnv).length > 0 ||
          Object.keys(mcpSecretEnv).length > 0 ||
          Object.keys(envVaultEnv).length > 0
            ? {
                ...mcpSecretEnv,
                ...envVaultEnv,
                ...presetEnv,
                ...(options?.env ?? {}),
              }
            : undefined;
        const cliBinaryOverride = getProviderBinaryOverride(agentId);

        const resumeWorkspaceId = await resolveSpawnWorkspaceId(
          bridge,
          resolvedCwd,
        );

        const resp = await bridge.request<
          AgentSessionLoadedMessage | AgentErrorMessage
        >(
          {
            type: "AGENT_LOAD_SESSION",
            agentId,
            chatId, // Phase 2b: bind the resumed session→chat for engine persistence
            sessionId,
            cwd: resolvedCwd ?? undefined,
            workspaceId: resumeWorkspaceId ?? undefined,
            env: mergedEnv,
            cliBinary: cliBinaryOverride,
          },
          5 * 60_000,
        );
        if (resp.type === "AGENT_ERROR") {
          // Classify so transport-closed / session-expired / timeout
          // route to status="reconnecting" (silent self-heal) rather
          // than a hard "Agent error" toast. Without this, an engine
          // swap during chat-open fires
          //   "Codex: Agent error / Engine swapping — request aborted"
          // even though every other code path correctly maps that to
          // transport-closed. Same shape as sendPrompt's catch.
          const failure = failureFromAgentError(resp, "loadSession");
          getStore().patchSession(chatId, {
            status: statusForFailure(failure),
            error: failure.message,
            failure,
          });
          return;
        }
        getStore().patchSession(chatId, {
          status: "ready",
          sessionId: resp.sessionId,
          availableModes: resp.response.modes?.availableModes ?? [],
          currentModeId: resp.response.modes?.currentModeId ?? null,
          error: null,
          failure: null,
          // Settings-drift guard: same stamp as ensureSession — the chat env
          // this resumed session was actually loaded with.
          appliedChatEnvKey: chatEnvDriftKey(options?.env),
        });
        // Re-apply the chat's persisted permission posture on resume too. The
        // agent's resumed session starts at its OWN default mode (permission
        // mode is a runtime setting, not part of the on-disk transcript), so
        // without this an app restart would silently drop the user's mode
        // (e.g. plan). reconcile is idempotent — a no-op when already matching.
        if (bridge) {
          void reconcilePermissionModeAtBind(bridge, getStore, {
            chatId,
            agentId,
            sessionId: resp.sessionId,
            availableModes: resp.response.modes?.availableModes ?? [],
            currentModeId: resp.response.modes?.currentModeId ?? null,
          });
        }
        // Recovery drain (same reasoning as ensureSession): a send parked while
        // this chat was reconnecting flushes now that loadSession restored it to
        // ready. Self-gated + lock-guarded inside drainNextQueued.
        drainNextQueued(chatId);
      } catch (err) {
        // Classify the raw rejection (engine-swap rejections carry
        // code:"ENGINE_SWAPPING"; WS-disconnect timeouts match
        // TIMEOUT_RX) so the renderer's reconnect chip surfaces for
        // recoverable cases instead of the hard-failure toast.
        const failure = classifyRpcError({
          agentId,
          stage: "loadSession",
          error: err,
        });
        getStore().patchSession(chatId, {
          status: statusForFailure(failure),
          error: failure.message,
          failure,
        });
      }
    },
    [bridge, getStore, drainNextQueued],
  );

  const getSession = useCallback<SessionsActions["getSession"]>(
    (chatId) => getStore().sessions[chatId],
    [getStore],
  );

  const disposeAll = useCallback<SessionsActions["disposeAll"]>(() => {
    getStore().clearAll();
    // Note: we deliberately do NOT clear the disk transcript here.
    // disposeAll is called on engine respawn (in-place project swap),
    // when the in-memory sessionIds become stale but the user still
    // wants their history when chats reopen on the new engine.
  }, [getStore]);

  const closeSession = useCallback<SessionsActions["closeSession"]>(
    (chatId) => {
      if (!bridge) return;
      const slot = getStore().sessions[chatId];
      // Only sessions the engine actually started have something to tear
      // down. The on-disk transcript is untouched, so reopening the chat
      // re-resumes via loadSession.
      if (slot?.agentId && slot.sessionId) {
        bridge.send({
          type: "AGENT_CLOSE_SESSION",
          agentId: slot.agentId,
          sessionId: slot.sessionId,
        });
        // Drop the now-stale in-memory slot. Without this, reopening the
        // chat sees a populated `sessionId` and skips loadSession, leaving
        // the renderer pointed at a session the engine just tore down. The
        // on-disk transcript is untouched, so reopen re-resumes via
        // loadSession (the persisted-sessionId path).
        getStore().removeSession(chatId);
      }
    },
    [bridge, getStore],
  );

  // The actions object is stable across renders. No `sessions` field —
  // consumers reach into the store directly via useChatSession (sliced)
  // or useAgentSessions (full snapshot via subscription).
  const actions = useMemo<SessionsActions>(
    () => ({
      getSession,
      listAgents,
      initAgent,
      ensureSession,
      sendPrompt,
      cancel,
      respondToPermission,
      respondToQuestion,
      setMode,
      setModel,
      compactContext,
      updateConfig,
      removeQueued,
      editQueued,
      steerQueued,
      holdQueue,
      releaseQueue,
      reset,
      listSessionsFor,
      loadIntoChat,
      hydrateChat,
      closeSession,
      disposeAll,
    }),
    [
      getSession,
      listAgents,
      initAgent,
      ensureSession,
      sendPrompt,
      cancel,
      respondToPermission,
      respondToQuestion,
      setMode,
      setModel,
      compactContext,
      updateConfig,
      removeQueued,
      editQueued,
      steerQueued,
      holdQueue,
      releaseQueue,
      reset,
      listSessionsFor,
      loadIntoChat,
      hydrateChat,
      closeSession,
      disposeAll,
    ],
  );

  // ── Persistence subscription ────────────────────────────
  //
  // Fires after every store mutation (which is rAF-coalesced via the
  // bridge effect above). Diffs each chat's message list against the
  // last-persisted reference map and writes only the changed entries.
  // Streaming text chunks share a stable msgId, so the main process
  // upserts in place — no row explosion.
  //
  // Reference equality is the dirty marker: the store's reducers return
  // identical state when nothing changed, so unchanged chats short-circuit
  // before any diffing.
  useEffect(() => {
    let prevSessions = useSessionsStore.getState().sessions;
    const lastWritten = new Map<string, Map<string, AgentMessage>>();

    const unsubscribe = useSessionsStore.subscribe((state) => {
      if (state.sessions === prevSessions) return;
      const nextSessions = state.sessions;

      for (const [chatId, slot] of Object.entries(nextSessions)) {
        if (slot === prevSessions[chatId]) continue; // unchanged
        let chatMap = lastWritten.get(chatId);
        if (!chatMap) {
          chatMap = new Map();
          lastWritten.set(chatId, chatMap);
        }
        const toWrite: AgentMessage[] = [];
        for (const m of slot.messages) {
          // Never persist a still-queued send — it's an ephemeral greyed
          // placeholder; it becomes a real (persisted) message only once it
          // flushes. Without this, a reload could resurrect a queued bubble
          // with no live queue behind it (greyed forever).
          if (m.kind === "text" && m.queued) continue;
          // Reference identity tells us if this message was touched.
          // The store does immutable updates: a streaming chunk produces
          // a new message object, completed cards produce a new tool
          // object. Pristine messages keep the same ref → no write.
          if (chatMap.get(m.id) !== m) {
            toWrite.push(m);
            chatMap.set(m.id, m);
          }
        }
        if (toWrite.length > 0) {
          void persistAppendMessages(chatId, toWrite).catch((err) => {
            console.warn(
              `[Zeros agent-history] append failed for ${chatId}:`,
              err,
            );
          });
        }
        // (Phase 2c) The agent_chat_meta side-car write was removed: it was
        // write-only (getChatMeta had no readers), and the agentId/sessionId
        // that drive resume already live on the chat ROW — column2-chat-view
        // dispatches UPDATE_CHAT_SETTINGS on a new sessionId, which the chats
        // persistence mirrors via dbUpsertChat.
      }

      // Drop entries from lastWritten for chats that disappeared (reset).
      // Lets the next ensureSession/hydrate write a full transcript again
      // instead of relying on stale diff state.
      for (const chatId of lastWritten.keys()) {
        if (!(chatId in nextSessions)) {
          lastWritten.delete(chatId);
        }
      }

      prevSessions = nextSessions;
    });

    return () => unsubscribe();
  }, []);

  // ── Analytics: agent failures ───────────────────────────
  //
  // Single choke point for `agent_failed` across every path
  // (ensureSession, sendPrompt, loadSession): observe when a slot's
  // `failure` becomes newly set. Deduped per chat by kind:stage so a
  // re-render of an already-failed slot doesn't re-emit; cleared when
  // the slot recovers (failure → null) so a later identical failure
  // counts again. Recoverable failures that self-heal clear `failure`
  // mid-retry, so only genuine end-state failures are reported.
  // Metadata only (kind + stage + a HASH of the technical message,
  // never the text): the UI shows simplified copy, so the hash is what
  // keeps distinct faults distinguishable in PostHog.
  useEffect(() => {
    let prev = useSessionsStore.getState().sessions;
    const lastSig = new Map<string, string>();
    const unsub = useSessionsStore.subscribe((state) => {
      if (state.sessions === prev) return;
      const next = state.sessions;
      for (const [chatId, slot] of Object.entries(next)) {
        if (slot === prev[chatId]) continue;
        const f = slot.failure;
        if (f) {
          const sig = `${f.kind}:${f.stage ?? ""}`;
          if (lastSig.get(chatId) !== sig) {
            lastSig.set(chatId, sig);
            trackAgentFailed({
              agentId: slot.agentId ?? "unknown",
              failure: f,
            });
          }
        } else if (lastSig.has(chatId)) {
          lastSig.delete(chatId);
        }
      }
      // Session end: a slot present last tick is gone now (closeSession /
      // reset / dispose all call removeSession). Only count slots that
      // actually started a session; outcome from the last-known failure.
      for (const [chatId, slot] of Object.entries(prev)) {
        if (next[chatId]) continue;
        lastSig.delete(chatId);
        if (!slot.agentId || !slot.sessionId) continue;
        trackAgentSessionEnded({
          agentId: slot.agentId,
          chatId,
          outcome: slot.failure ? "error" : "completed",
        });
      }
      prev = next;
    });
    return () => unsub();
  }, []);

  return <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>;
}

/** Append the user's just-sent bubble to a message list, preserving the
 *  per-chat cap. Extracted because it's used in two places (initial
 *  send + retry-after-rebuild). `uncapped` mirrors slot.historyExpanded —
 *  while the user holds paged-in older history, trimming here would pull
 *  the transcript out from under them just like a live append would. */
function capUserAppend(
  messages: AgentMessage[],
  userMessage: AgentTextMessage,
  uncapped?: boolean,
): AgentMessage[] {
  const next = [...messages, userMessage];
  if (uncapped || next.length <= MAX_MESSAGES_PER_CHAT) return next;
  return next.slice(-MAX_MESSAGES_PER_CHAT);
}

/** Remove the placeholder with `id` and append `userMessage` at the END.
 *  Used when a queued send flushes/steers: the placeholder was appended
 *  mid-previous-turn (streamed events landed after it in the array), and
 *  queued messages render in the composer's queued-card rather than the
 *  transcript — so the promoted live bubble must start its turn AFTER the
 *  previous turn's tail events, not at the stale enqueue slot. */
function promoteToEnd(
  messages: AgentMessage[],
  id: string,
  userMessage: AgentTextMessage,
  uncapped?: boolean,
): AgentMessage[] {
  return capUserAppend(
    messages.filter((m) => m.id !== id),
    userMessage,
    uncapped,
  );
}

/** Collapse runs of consecutive content-equal messages into one. Used
 *  by hydrateChat to clean up pre-existing on-disk duplicates from
 *  builds where the agent's loadSession replay landed in the store on
 *  every reopen. Conservative — only consecutive duplicates are
 *  removed, so a user who legitimately repeats themselves across
 *  separate turns keeps both bubbles. */
function dedupeConsecutiveMessages(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length < 2) return messages;
  const out: AgentMessage[] = [];
  let prev: AgentMessage | null = null;
  for (const m of messages) {
    if (prev && messagesContentEqual(prev, m)) continue;
    out.push(m);
    prev = m;
  }
  return out;
}

function messagesContentEqual(a: AgentMessage, b: AgentMessage): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "text" && b.kind === "text") {
    return a.role === b.role && a.text === b.text;
  }
  if (a.kind === "tool" && b.kind === "tool") {
    if (a.title !== b.title) return false;
    if (a.toolKind !== b.toolKind) return false;
    // Stringified rawInput catches "same tool, same arguments" — the
    // shape replay always reproduces identically. We don't compare
    // status because a replayed tool can land in a different terminal
    // state (completed vs failed-but-retried) and we'd rather keep
    // both than collapse a real second invocation.
    try {
      return JSON.stringify(a.rawInput) === JSON.stringify(b.rawInput);
    } catch {
      return false;
    }
  }
  return false;
}

// Hooks `useChatSession` + `useAgentSessions` live in ./sessions-hooks
// (Track 5.C). This file is now component-only so Vite Fast Refresh
// hot-swaps the provider on edit instead of full-reloading the page.
// Warm-agent state lives in ./sessions-store (`warmAgentIds`). Type
// re-exports of `AgentMessage` etc. happen via ./sessions-hooks where
// the hooks live.
