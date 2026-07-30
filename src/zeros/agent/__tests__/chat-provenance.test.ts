import { describe, it, expect } from "vitest";

import { setupRowState } from "../chat-provenance";

// The empty chat's setup line has three shapes and one "say nothing yet".
// Both edges below were deliberate calls, so pin them.

describe("setupRowState", () => {
  it("says nothing until the setup read lands", () => {
    // hasCommand === null is "not known yet", NOT "no command". Collapsing the
    // two made every chat flash "Configure setup script" before correcting
    // itself a frame later.
    expect(setupRowState({ hasCommand: null, state: null })).toBe("unknown");
    expect(setupRowState({ hasCommand: null, state: "running" })).toBe(
      "unknown",
    );
  });

  it("offers to configure one when the repo has no setup command", () => {
    expect(setupRowState({ hasCommand: false, state: null })).toBe(
      "not-configured",
    );
  });

  it("reports a live run", () => {
    expect(setupRowState({ hasCommand: true, state: "running" })).toBe(
      "running",
    );
  });

  it("reads passed, failed and stopped alike as completed", () => {
    // This row states that the create-time step is behind you — the Setup tab
    // owns pass/fail, with the log to explain it. A red failure here would
    // alarm the user on a surface they came to type in and can't act from.
    expect(setupRowState({ hasCommand: true, state: "passed" })).toBe(
      "completed",
    );
    expect(setupRowState({ hasCommand: true, state: "failed" })).toBe(
      "completed",
    );
    expect(setupRowState({ hasCommand: true, state: "stopped" })).toBe(
      "completed",
    );
  });

  it("reads a configured-but-never-run script as completed, not running", () => {
    // A workspace created before the script was configured has hasCommand:true
    // and state:null. "Setup script is running" would be a lie (nothing is);
    // the honest reading is that there is nothing in flight.
    expect(setupRowState({ hasCommand: true, state: null })).toBe("completed");
  });
});
