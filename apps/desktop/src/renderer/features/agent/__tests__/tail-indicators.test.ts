// The shimmer and the workflow row share a tail but not a gate. These lock the
// DIVERGENCE: a pending gate must silence the "agent is working" cue without
// taking the running workflow's progress and Stop action with it.

import { describe, expect, it } from "vitest";

import { tailIndicators, tailTurnInFlight } from "../tail-indicators";

const at = (overrides: Partial<Parameters<typeof tailIndicators>[0]> = {}) =>
  tailIndicators({
    live: true,
    showActivity: true,
    awaitingUserInput: false,
    ...overrides,
  });

describe("tailIndicators", () => {
  it("shows both while the agent works uninterrupted", () => {
    expect(at()).toEqual({ shimmer: true, workflow: true });
  });

  it("keeps the workflow row while a gate silences the shimmer", () => {
    // The regression: a helper's permission gate or blocking question used to
    // hide the whole tail, so a running workflow's Stop vanished exactly when
    // the user was deciding whether to let it continue.
    expect(at({ awaitingUserInput: true })).toEqual({
      shimmer: false,
      workflow: true,
    });
  });

  it("shows neither once the turn is no longer live", () => {
    expect(at({ live: false })).toEqual({ shimmer: false, workflow: false });
    expect(at({ live: false, awaitingUserInput: true })).toEqual({
      shimmer: false,
      workflow: false,
    });
  });

  it("shows neither on an older segment of a steered turn", () => {
    // Only the newest visual segment owns the tail, so earlier segments must
    // not duplicate either indicator around each steer bubble.
    expect(at({ showActivity: false })).toEqual({
      shimmer: false,
      workflow: false,
    });
    expect(at({ showActivity: false, awaitingUserInput: true })).toEqual({
      shimmer: false,
      workflow: false,
    });
  });
});

// Reported twice: stop the agent, then reload the app / switch chat tabs /
// switch workspaces, and the finished turn came back to life — agent shimmer
// plus a timer counting from the original prompt — before flipping to STOPPED BY
// USER. Every one of those routes re-resumes the session, and liveness was
// inferred from `status === "warming" && no events yet`, which a turn stopped
// before it produced any output satisfies forever.
describe("tailTurnInFlight", () => {
  const inFlight = (
    overrides: Partial<Parameters<typeof tailTurnInFlight>[0]> = {},
  ) =>
    tailTurnInFlight({
      sessionStreaming: false,
      pendingLocalTurn: false,
      hasEvents: false,
      ...overrides,
    });

  it("leaves a reopened chat's stopped, output-less turn settled", () => {
    // The reopen: session warming/resuming, no send of ours in flight, and a
    // turn that never got to emit anything.
    expect(inFlight()).toBe(false);
    // Which is what keeps the tail quiet and lets the footer render its pill.
    expect(
      tailIndicators({
        live: inFlight(),
        showActivity: true,
        awaitingUserInput: false,
      }),
    ).toEqual({ shimmer: false, workflow: false });
  });

  it("keeps the just-sent turn live while its session is still (re)building", () => {
    // The case the old warming clause existed for: the prompt is committed to
    // the transcript, the agent hasn't started, and the footer must not flash a
    // settled "0s" reading.
    expect(inFlight({ pendingLocalTurn: true })).toBe(true);
  });

  it("is live whenever the session has a turn running", () => {
    expect(inFlight({ sessionStreaming: true })).toBe(true);
    expect(inFlight({ sessionStreaming: true, hasEvents: true })).toBe(true);
  });

  it("does not re-open an already-answered turn during a rebuild", () => {
    // A turn that streamed content is not brought back into the working feed by
    // a session rebuild — the reconnect notice covers that window.
    expect(inFlight({ pendingLocalTurn: true, hasEvents: true })).toBe(false);
  });

  it("ignores another chat's pending turn", () => {
    // pendingLocalTurn is resolved per TURN id by the caller, so a send in a
    // different chat (or an earlier turn of this one) cannot light this tail.
    expect(inFlight({ pendingLocalTurn: false, hasEvents: true })).toBe(false);
  });
});
