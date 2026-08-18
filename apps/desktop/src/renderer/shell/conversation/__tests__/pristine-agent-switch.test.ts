import { describe, expect, it } from "vitest";

import {
  adoptedPristineSpawnBind,
  INITIAL_PRISTINE_SPAWN_BIND,
  nextPristineSpawnDecision,
  type PristineSpawnBind,
  type PristineSpawnInput,
} from "../pristine-agent-switch";

/** A chat the user has never used: empty slot, never-promoted title. */
function pristineRun(
  agentId: string,
  bind: PristineSpawnBind,
  overrides: Partial<PristineSpawnInput> = {},
): PristineSpawnInput {
  return {
    agentId,
    bind,
    hasTranscript: false,
    messageCount: 0,
    chatTitle: "Untitled",
    pendingAutoSend: false,
    composerHasText: false,
    ...overrides,
  };
}

describe("pristine agent switch", () => {
  it("spawns for the first agent a chat binds", () => {
    const decision = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    );
    expect(decision.defer).toBe(false);
    expect(decision.bind).toEqual({
      boundAgent: "claude",
      pristineSwitch: false,
    });
  });

  it("defers the admission when an untouched chat switches agents", () => {
    const bound = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;

    const switched = nextPristineSpawnDecision(pristineRun("codex", bound));
    expect(switched.defer).toBe(true);
  });

  it("keeps deferring when the effect re-runs for the same agent", () => {
    // The spawn effect also re-fires on cwd / surfaceActive / provisioning
    // changes. Without the sticky flag the saving would evaporate on the first
    // unrelated re-run.
    let bind = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;
    bind = nextPristineSpawnDecision(pristineRun("codex", bind)).bind;

    const rerun = nextPristineSpawnDecision(pristineRun("codex", bind));
    expect(rerun.defer).toBe(true);
  });

  it("keeps deferring when the user switches back to the original agent", () => {
    let bind = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;
    bind = nextPristineSpawnDecision(pristineRun("codex", bind)).bind;

    const back = nextPristineSpawnDecision(pristineRun("claude", bind));
    expect(back.defer).toBe(true);
  });

  it("defers every hop through the picker, not just the first", () => {
    let bind = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;
    for (const agentId of ["codex", "cursor", "claude", "codex"]) {
      const decision = nextPristineSpawnDecision(pristineRun(agentId, bind));
      expect(decision.defer).toBe(true);
      bind = decision.bind;
    }
  });

  it("ends the deferral at the first keystroke, not at Send", () => {
    // Deferring all the way to Send stacks the whole admission in front of the
    // send AND swaps the queued-message card for a blocking spinner. Typing is
    // the earliest honest intent signal, so the spawn starts there.
    let bind = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;
    bind = nextPristineSpawnDecision(pristineRun("codex", bind)).bind;

    const typed = nextPristineSpawnDecision(
      pristineRun("codex", bind, { composerHasText: true }),
    );
    expect(typed.defer).toBe(false);
    expect(typed.bind).toEqual({ boundAgent: "codex", pristineSwitch: false });
  });

  it("keeps the spawn armed once typing has started", () => {
    // The effect re-runs for unrelated reasons after the keystroke; it must not
    // fall back into deferring and orphan the admission it just started.
    let bind = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;
    bind = nextPristineSpawnDecision(pristineRun("codex", bind)).bind;
    bind = nextPristineSpawnDecision(
      pristineRun("codex", bind, { composerHasText: true }),
    ).bind;

    expect(
      nextPristineSpawnDecision(
        pristineRun("codex", bind, { composerHasText: true }),
      ).defer,
    ).toBe(false);
  });

  it("still defers a switch made while the composer is empty", () => {
    // Clearing the composer and stepping through the picker again is browsing.
    let bind = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;
    bind = nextPristineSpawnDecision(
      pristineRun("codex", bind, { composerHasText: false }),
    ).bind;

    expect(
      nextPristineSpawnDecision(pristineRun("cursor", bind)).defer,
    ).toBe(true);
  });

  it("never defers an auto-send — that is explicit intent", () => {
    const bound = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;

    const decision = nextPristineSpawnDecision(
      pristineRun("codex", bound, { pendingAutoSend: true }),
    );
    expect(decision.defer).toBe(false);
    expect(decision.bind).toEqual({
      boundAgent: "codex",
      pristineSwitch: false,
    });
  });

  it("never defers a chat that has been used", () => {
    const bound = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;

    for (const used of [
      { messageCount: 1 },
      { hasTranscript: true },
      { chatTitle: "Fix the zoom glitch" },
    ]) {
      expect(
        nextPristineSpawnDecision(pristineRun("codex", bound, used)).defer,
      ).toBe(false);
    }
  });

  it("re-arms the eager spawn once the deferred chat is actually used", () => {
    let bind = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;
    bind = nextPristineSpawnDecision(pristineRun("codex", bind)).bind;

    // The user sends; the send path admits and the chat gains a message.
    const used = nextPristineSpawnDecision(
      pristineRun("codex", bind, { messageCount: 1 }),
    );
    expect(used.defer).toBe(false);
    expect(used.bind).toEqual({ boundAgent: "codex", pristineSwitch: false });
  });

  it("treats an adopted live session as a real bind, so the next switch defers", () => {
    // Reopening a tab short-circuits on the live session before the decision
    // runs. That path must still record the bind, or the following switch
    // would read as a first bind and spawn eagerly.
    const adopted = adoptedPristineSpawnBind("claude");
    expect(nextPristineSpawnDecision(pristineRun("codex", adopted)).defer).toBe(
      true,
    );
  });

  it("does not defer a chat whose slot is empty only because history is hydrating", () => {
    // An engine respawn empties the slot while disk history loads. The
    // promoted title is what keeps that from reading as pristine.
    const bound = nextPristineSpawnDecision(
      pristineRun("claude", INITIAL_PRISTINE_SPAWN_BIND),
    ).bind;

    expect(
      nextPristineSpawnDecision(
        pristineRun("codex", bound, {
          hasTranscript: false,
          messageCount: 0,
          chatTitle: "Earlier conversation",
        }),
      ).defer,
    ).toBe(false);
  });
});
