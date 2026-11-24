// ──────────────────────────────────────────────────────────
// pristine-session-retire.ts — when a hidden, untouched chat gives up its session
// ──────────────────────────────────────────────────────────
//
// The focused chat admits eagerly (lazy-boot-resume.ts), so every workspace
// the user opens boots one provider session for its empty first chat. Leaving
// the workspace used to keep that session alive indefinitely: each one is a
// supervisor plus a provider process, a couple of hundred megabytes, and they
// accumulated one per workspace visited.
//
// The rule this module owns:
//
//   - Only a PRISTINE session is ever retired: nothing sent, nothing typed,
//     nothing queued, no turn or background work, no permission or question
//     card, and a never-promoted title. Anything else is someone's work and
//     stays exactly as it is, however long it is hidden.
//   - At most ONE hidden pristine session stays alive — the most recently
//     hidden — so quick back-and-forth between two workspaces stays warm. It
//     retires once it has been hidden for HIDDEN_PRISTINE_SESSION_GRACE_MS.
//     Every other hidden pristine session retires immediately, once the
//     commit that hid it has finished.
//   - Showing the chat again cancels its pending retirement. A retired chat
//     re-admits through the ordinary chat-view path when it is shown again,
//     exactly as it did on first open.
//   - A pristine chat with nothing live yet (DORMANT: no slot, an idle slot,
//     a failure the user should still see, or a transcript still loading) is
//     not retired and does not occupy the kept slot, but it is re-read until
//     its own grace period ends: an admission that was already in flight can
//     still go live after the chat was hidden.
//
// Classification is re-read from current state at every decision, never from
// the moment the chat was hidden, so a session that gained work while hidden
// is never retired. Kept pure and separate from chat-view for the same reason
// as pristine-agent-switch.ts.
// ──────────────────────────────────────────────────────────

import type { SessionStatus } from "../../features/agent/use-agent-session";

export const HIDDEN_PRISTINE_SESSIONS_KEPT = 1;
export const HIDDEN_PRISTINE_SESSION_GRACE_MS = 2 * 60_000;

export interface PristineSessionSnapshot {
  /** The chat's live session status; null when it has no session slot. */
  readonly status: SessionStatus | null;
  readonly hasTranscript: boolean;
  readonly transcriptLoading: boolean;
  readonly messageCount: number;
  /** "Untitled" for a never-promoted title, as nextPristineSpawnDecision reads it. */
  readonly chatTitle: string | undefined;
  /** The composer holds text or attachments. */
  readonly composerHasText: boolean;
  readonly pendingAutoSend: boolean;
  /** A send in flight, a foreground turn, or background work and workflows. */
  readonly running: boolean;
  /** Prompts queued behind this session, including ones waiting on admission. */
  readonly queuedCount: number;
  /** A permission or question card awaits the user. */
  readonly pendingInteraction: boolean;
  /** Cloud only: the worker already holds turn, binding or outbox state. */
  readonly cloudActivity: boolean;
}

/** `live` may be retired; `dormant` has nothing to retire yet; `busy` is
 *  never retired by this policy. */
export type HiddenSessionState = "live" | "dormant" | "busy";

export function classifyHiddenChatSession(
  snapshot: PristineSessionSnapshot,
): HiddenSessionState {
  const pristine =
    !snapshot.hasTranscript &&
    snapshot.messageCount === 0 &&
    snapshot.chatTitle === "Untitled" &&
    !snapshot.composerHasText &&
    !snapshot.pendingAutoSend &&
    !snapshot.running &&
    snapshot.status !== "streaming" &&
    snapshot.queuedCount === 0 &&
    !snapshot.pendingInteraction &&
    !snapshot.cloudActivity;
  if (!pristine) return "busy";
  if (snapshot.transcriptLoading) return "dormant";
  if (snapshot.status === "ready" || snapshot.status === "warming") return "live";
  return "dormant";
}

export interface HiddenChat {
  readonly chatId: string;
  readonly hiddenAt: number;
}

export interface PristineRetirementPlan {
  /** Close these sessions now. */
  readonly retire: readonly string[];
  /** Stop tracking these chats without closing anything. */
  readonly release: readonly string[];
  /** When the plan must be recomputed, or null when nothing is pending. */
  readonly nextCheckAt: number | null;
}

/** `hidden` is in hide order, oldest first; a later entry is more recent even
 *  when timestamps tie. */
export function planHiddenPristineRetirement(
  hidden: readonly HiddenChat[],
  classify: (chatId: string) => HiddenSessionState,
  now: number,
): PristineRetirementPlan {
  const retire: string[] = [];
  const release: string[] = [];
  let nextCheckAt: number | null = null;
  let kept = 0;
  for (let i = hidden.length - 1; i >= 0; i--) {
    const { chatId, hiddenAt } = hidden[i]!;
    const deadline = hiddenAt + HIDDEN_PRISTINE_SESSION_GRACE_MS;
    const state = classify(chatId);
    if (state === "busy") {
      release.push(chatId);
      continue;
    }
    const expired = now >= deadline;
    if (state === "dormant") {
      if (expired) release.push(chatId);
      else nextCheckAt = Math.min(nextCheckAt ?? deadline, deadline);
      continue;
    }
    if (!expired && kept < HIDDEN_PRISTINE_SESSIONS_KEPT) {
      kept++;
      nextCheckAt = Math.min(nextCheckAt ?? deadline, deadline);
      continue;
    }
    retire.push(chatId);
  }
  return { retire, release, nextCheckAt };
}

export interface HiddenChatHandlers {
  /** Re-read this chat's session from current state. */
  classify(): HiddenSessionState;
  /** Close the session through the intentional close path. */
  retire(): void;
}

export interface PristineSessionRetirer {
  shown(chatId: string): void;
  hidden(chatId: string, handlers: HiddenChatHandlers): void;
}

export function createPristineSessionRetirer(
  now: () => number = () => Date.now(),
): PristineSessionRetirer {
  // A chat can be surfaced by more than one view at once (a workbench side
  // chat beside its pane); it is hidden only when the last one hides.
  const visible = new Map<string, number>();
  const hidden = new Map<string, HiddenChat & { handlers: HiddenChatHandlers }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sweepQueued = false;

  const sweep = () => {
    sweepQueued = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const at = now();
    // Sweeps run inside React effect cleanups; an unreadable session must
    // not throw out of an unmount, and is left alone rather than guessed at.
    const plan = planHiddenPristineRetirement(
      [...hidden.values()],
      (chatId) => {
        try {
          return hidden.get(chatId)!.handlers.classify();
        } catch {
          return "busy";
        }
      },
      at,
    );
    for (const chatId of plan.release) hidden.delete(chatId);
    for (const chatId of plan.retire) {
      const entry = hidden.get(chatId)!;
      hidden.delete(chatId);
      try {
        entry.handlers.retire();
      } catch {
        // The close path publishes its own failure state on the chat.
      }
    }
    if (plan.nextCheckAt !== null)
      timer = setTimeout(sweep, Math.max(0, plan.nextCheckAt - at));
  };
  // A remount hides and shows the same views within one commit. Deciding
  // after the commit keeps two remounting chats from retiring each other.
  const queueSweep = () => {
    if (sweepQueued) return;
    sweepQueued = true;
    void Promise.resolve().then(sweep);
  };

  return {
    shown(chatId) {
      visible.set(chatId, (visible.get(chatId) ?? 0) + 1);
      if (hidden.delete(chatId)) queueSweep();
    },
    hidden(chatId, handlers) {
      const count = (visible.get(chatId) ?? 1) - 1;
      if (count > 0) {
        visible.set(chatId, count);
        return;
      }
      visible.delete(chatId);
      hidden.delete(chatId);
      hidden.set(chatId, { chatId, hiddenAt: now(), handlers });
      queueSweep();
    },
  };
}

export const pristineSessionRetirer = createPristineSessionRetirer();
