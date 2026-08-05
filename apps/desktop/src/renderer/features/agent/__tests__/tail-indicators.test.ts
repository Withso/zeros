// The shimmer and the workflow row share a tail but not a gate. These lock the
// DIVERGENCE: a pending gate must silence the "agent is working" cue without
// taking the running workflow's progress and Stop action with it.

import { describe, expect, it } from "vitest";

import { tailIndicators } from "../tail-indicators";

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
