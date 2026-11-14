import { describe, expect, it } from "vitest";

import {
  isWorkspacePrSyncEligible,
  prDiscoveryPollMs,
  shouldProbeWorkspacePr,
} from "../use-workspace-pr-sync";

describe("idle is quiet: PR discovery while a workspace stays visible", () => {
  it("polls a cloud workspace every 5 min (refs changes and returning to the window still probe at once); Local keeps 1 min", () => {
    expect(prDiscoveryPollMs(false)).toBe(300_000);
    expect(prDiscoveryPollMs(true)).toBe(60_000);
  });
});

describe("isWorkspacePrSyncEligible", () => {
  it("rejects the synthetic Local-main row before it reaches gh.prSync", () => {
    expect(
      isWorkspacePrSyncEligible({
        id: "local:acme-widgets",
        repoSlug: "acme-widgets",
        prNumber: null,
      }),
    ).toBe(false);
  });

  it("accepts only an engine workspace without a recorded PR", () => {
    expect(
      isWorkspacePrSyncEligible({
        id: "ws_feature",
        repoSlug: "acme-widgets",
        prNumber: null,
      }),
    ).toBe(true);
    expect(
      isWorkspacePrSyncEligible({
        id: "ws_feature",
        repoSlug: "acme-widgets",
        prNumber: 191,
      }),
    ).toBe(false);
  });
});

describe("shouldProbeWorkspacePr", () => {
  it("probes a never-seen workspace and every new Git refresh generation", () => {
    expect(shouldProbeWorkspacePr(undefined, 1, 100, "refresh")).toBe(true);
    expect(
      shouldProbeWorkspacePr({ refreshKey: 1, at: 99 }, 2, 100, "refresh"),
    ).toBe(true);
  });

  it("rate-limits navigation/focus thrash but probes promptly on resume", () => {
    const previous = { refreshKey: 1, at: 10_000 };
    expect(shouldProbeWorkspacePr(previous, 1, 11_999, "resume")).toBe(false);
    expect(shouldProbeWorkspacePr(previous, 1, 12_000, "resume")).toBe(true);
    expect(shouldProbeWorkspacePr(previous, 1, 69_999, "poll")).toBe(false);
    expect(shouldProbeWorkspacePr(previous, 1, 70_000, "poll")).toBe(true);
  });
});
