import { describe, expect, it } from "vitest";

import { runSessionId } from "@zeros/core/run-actions";

import {
  RUN_ADD_SUBTAB,
  resolveTerminalPanelTab,
} from "../terminal-tab-selection";

describe("resolveTerminalPanelTab", () => {
  it("lands a fresh workspace on Setup even after a plain shell is seeded", () => {
    expect(
      resolveTerminalPanelTab({
        activeId: null,
        configuredRunIds: [],
        sessionIds: ["pty-plain"],
        showRunAdd: true,
      }),
    ).toBe("setup");
  });

  it("preserves valid Setup, Run, and terminal selections", () => {
    const runId = runSessionId("/repo", "dev");
    const shared = {
      configuredRunIds: [runId],
      sessionIds: ["pty-plain", runId],
      showRunAdd: false,
    };
    expect(resolveTerminalPanelTab({ ...shared, activeId: "setup" })).toBe(
      "setup",
    );
    expect(
      resolveTerminalPanelTab({
        ...shared,
        activeId: "pty-setup-retired",
      }),
    ).toBe("setup");
    expect(resolveTerminalPanelTab({ ...shared, activeId: runId })).toBe(runId);
    expect(resolveTerminalPanelTab({ ...shared, activeId: "pty-plain" })).toBe(
      "pty-plain",
    );
  });

  it("routes a removed run to discoverability and every other stale id to Setup", () => {
    const removedRun = runSessionId("/repo", "removed");
    expect(
      resolveTerminalPanelTab({
        activeId: removedRun,
        configuredRunIds: [],
        sessionIds: [],
        showRunAdd: true,
      }),
    ).toBe(RUN_ADD_SUBTAB);
    const survivingRun = runSessionId("/repo", "surviving");
    expect(
      resolveTerminalPanelTab({
        activeId: removedRun,
        configuredRunIds: [survivingRun],
        sessionIds: [],
        showRunAdd: false,
      }),
    ).toBe(survivingRun);
    expect(
      resolveTerminalPanelTab({
        activeId: "gone",
        configuredRunIds: [],
        sessionIds: [],
        showRunAdd: false,
      }),
    ).toBe("setup");
  });
});
