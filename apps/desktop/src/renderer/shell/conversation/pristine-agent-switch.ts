// ──────────────────────────────────────────────────────────
// pristine-agent-switch.ts — when an agent swap may skip the spawn
// ──────────────────────────────────────────────────────────
//
// Every session spawn costs a real ZSR boundary admission (policy, private
// Git, provider HOME, live canary). That is worth paying while the user is
// typing into a chat they mean to use. It is pure waste when they are only
// stepping through the agent picker on a chat that has never been used: the
// pristine in-place switch (agent-chat's switchAgentModel) closes the live
// session and restamps agentId, so every hop paid one admission plus the
// outgoing session's proven teardown for a thread with nothing in it.
//
// The rule this module owns:
//
//   - The FIRST agent a chat binds always spawns. It warms while the user
//     types and it is what paints the Design-boundary pill.
//   - A switch AWAY from that agent, on a thread still untouched, defers.
//   - The deferral is STICKY. Switching back to the original agent, or
//     leaving and re-entering the tab, must not silently re-arm the eager
//     spawn — otherwise the saving disappears the moment the effect re-runs
//     for an unrelated dependency.
//   - It ends at the first sign of INTENT: an auto-send, or a keystroke in
//     the composer.
//
// That last rule is load-bearing and was learned the hard way. Deferring all
// the way to Send looked equivalent — agent-chat self-heals a missing session
// (sendNeedsSessionRecovery → startSession) — but it is not, for two reasons.
// It stacks the whole admission in front of Send instead of overlapping it
// with typing; and it changes the affordance, because a send with no session
// blocks on a spinner with the text stuck in the composer, while a send into a
// warming session is accepted immediately into the queued-message card. Ending
// the deferral on the first keystroke keeps the saving for someone merely
// stepping through the picker, and gives everyone else the identical
// "accepted" behaviour they get from an eagerly spawned chat.
//
// Kept pure and separate from chat-view so the sticky bookkeeping — the part
// that is easy to get wrong and invisible in a React effect — is testable.
// ──────────────────────────────────────────────────────────

/** What the chat view remembers about its binding, across effect runs. */
export interface PristineSpawnBind {
  /** The agent this view actually spawned for or adopted live. */
  readonly boundAgent: string | null;
  /** A pristine switch has already been deferred for this chat. */
  readonly pristineSwitch: boolean;
}

export const INITIAL_PRISTINE_SPAWN_BIND: PristineSpawnBind = {
  boundAgent: null,
  pristineSwitch: false,
};

export interface PristineSpawnInput {
  readonly agentId: string;
  readonly bind: PristineSpawnBind;
  /** Live session slice. A chat whose slot was cleared reads as empty here,
   *  which is why the title below is also consulted. */
  readonly hasTranscript: boolean;
  readonly messageCount: number;
  /** The durable tell that a first message ever happened. After an engine
   *  respawn the sessions slot is empty while disk history hydrates, so
   *  emptiness alone would misread a real conversation as pristine. Matches
   *  the pristine test agent-chat's switchAgentModel already applies. */
  readonly chatTitle: string | undefined;
  readonly pendingAutoSend: boolean;
  /** The user has typed into this chat's composer. Kept separate from
   *  `pendingAutoSend` because they are different evidence of the same thing,
   *  and reading both at the decision point is clearer than one merged flag. */
  readonly composerHasText: boolean;
}

export interface PristineSpawnDecision {
  /** Skip the spawn this run; first use will admit instead. */
  readonly defer: boolean;
  /** Bind state to carry into the next run. */
  readonly bind: PristineSpawnBind;
}

/** Decide whether this effect run may skip its session spawn, and what the
 *  view should remember afterwards. Callers must persist `bind` even when
 *  deferring — that is what makes the deferral sticky. */
export function nextPristineSpawnDecision(
  input: PristineSpawnInput,
): PristineSpawnDecision {
  const pristine =
    !input.hasTranscript &&
    input.messageCount === 0 &&
    input.chatTitle === "Untitled";
  const switchedAgents =
    input.bind.boundAgent !== null && input.bind.boundAgent !== input.agentId;
  const intent = input.pendingAutoSend || input.composerHasText;

  if (pristine && !intent && (switchedAgents || input.bind.pristineSwitch)) {
    return {
      defer: true,
      // boundAgent deliberately keeps naming the agent this view last really
      // bound. Overwriting it here would make the NEXT switch look like a
      // first bind and spawn eagerly again.
      bind: { boundAgent: input.bind.boundAgent, pristineSwitch: true },
    };
  }
  return {
    defer: false,
    bind: { boundAgent: input.agentId, pristineSwitch: false },
  };
}

/** The chat view has a live session for `agentId` — nothing to spawn, and the
 *  chat is now genuinely bound to it. */
export function adoptedPristineSpawnBind(agentId: string): PristineSpawnBind {
  return { boundAgent: agentId, pristineSwitch: false };
}
