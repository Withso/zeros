// ──────────────────────────────────────────────────────────
// lazy-boot-resume.ts — which restored chats may admit a boundary at app start
// ──────────────────────────────────────────────────────────
//
// A split layout surfaces one chat per pane, and every surfaced chat used to
// take the same route on mount: hydrate the transcript from disk, then ask the
// engine to load its session. After a renderer-only reload that is free — the
// engine still owns each execution and re-adopts it without admitting anything.
// After an ENGINE restart (a dev reload, an update, a crash) there is nothing to
// adopt, so each of those loads minted a fresh execution: a full ZSR admission
// (policy, provider HOME projection, private Git, live canary) per pane, all at
// once, in front of whatever the user actually wanted to do. That is most of the
// boot burst measured on 2026-08-17 — 14 admissions squeezed through a 2-slot
// gate, ~98 s of queue wait, and the worst line spending 30.8 s queued for 1.06 s
// of work.
//
// The rule this module owns:
//
//   - The FOCUSED chat admits eagerly. Someone is looking at it; it should be
//     warm before they type.
//   - Every other surfaced chat asks to ADOPT ONLY (see
//     AgentLoadSessionMessage.adoptOnly). If the engine still owns its execution
//     it is re-adopted exactly as before — a running turn keeps streaming, its
//     permission cards replay, nothing regresses. If not, the chat stays `idle`
//     with its persisted transcript and provider binding intact, and NOTHING is
//     admitted.
//   - A deferred chat admits the moment it is worth it: it becomes focused, or
//     the user types into it, or a queued first message needs it. All three are
//     already inputs the chat view re-runs on.
//   - The deferral is NOT sticky. Unlike a pristine agent switch, there is no
//     "keep skipping" state to protect: focus is the trigger, and once a chat
//     has been admitted it has a live session and never reaches this decision
//     again.
//
// Kept pure and separate from chat-view for the same reason as
// pristine-agent-switch.ts: the interesting part is the policy, and a policy
// buried in a React effect cannot be tested.
// ──────────────────────────────────────────────────────────

export interface LazyBootResumeInput {
  /** This chat is the workspace's focused conversation. */
  readonly isFocusedChat: boolean;
  /** A queued create-intent message is waiting to be sent into this chat. */
  readonly pendingAutoSend: boolean;
  /** The user has typed into this chat's composer (keystroke-armed spawn). */
  readonly composerHasText: boolean;
  /** The chat view is only warming DOM for a hover-prepared surface. It never
   *  spawns at all, so this decision does not apply. */
  readonly preparing: boolean;
}

/** Whether this chat's session load must stop short of minting an execution.
 *
 *  `true` ⇒ send `adoptOnly` and treat a miss as "leave it idle, admit later".
 *  `false` ⇒ the ordinary eager path: adopt if possible, otherwise admit now. */
export function deferBootSessionAdmission(input: LazyBootResumeInput): boolean {
  if (input.preparing) return false;
  if (input.isFocusedChat) return false;
  if (input.pendingAutoSend || input.composerHasText) return false;
  return true;
}
