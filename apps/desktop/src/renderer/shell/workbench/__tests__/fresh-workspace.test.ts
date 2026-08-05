import { describe, expect, it } from "vitest";

import {
  FRESH_WORKSPACE_WINDOW_MS,
  shouldInitializeFreshWorkspace,
} from "../fresh-workspace";

describe("fresh Workbench workspace initialization", () => {
  it("initializes a workspace created during the current renderer session", () => {
    expect(
      shouldInitializeFreshWorkspace({
        sessionStartedAt: 1_000,
        createdAt: 2_000,
        now: 2_500,
      }),
    ).toBe(true);
  });

  it("does not reset restored tabs after a quick app restart", () => {
    expect(
      shouldInitializeFreshWorkspace({
        sessionStartedAt: 2_000,
        createdAt: 1_500,
        now: 2_500,
      }),
    ).toBe(false);
  });

  it("rejects a creation event after the freshness window", () => {
    expect(
      shouldInitializeFreshWorkspace({
        sessionStartedAt: 1_000,
        createdAt: 2_000,
        now: 2_000 + FRESH_WORKSPACE_WINDOW_MS + 1,
      }),
    ).toBe(false);
  });
});
