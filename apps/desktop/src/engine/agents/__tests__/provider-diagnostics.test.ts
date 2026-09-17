import { describe, expect, it } from "vitest";

import {
  configurationProvenanceFor,
  mergeCodexRateLimitSnapshot,
  normalizeCodexQuota,
  provenanceFromCodexLayers,
} from "../provider-diagnostics";

describe("provider configuration provenance", () => {
  it("reports native source layers and the Zeros injection without paths", () => {
    expect(
      configurationProvenanceFor("cursor", {
        protectedTerritory: false,
        suppressUnsafeSources: false,
      }),
    ).toEqual({
      providerId: "cursor",
      protectedTerritory: false,
      sources: [
        { id: "user", label: "User", status: "loaded" },
        { id: "project", label: "Project", status: "loaded" },
        { id: "team", label: "Team", status: "loaded" },
        { id: "mdm", label: "Device management", status: "loaded" },
        { id: "plugins", label: "Plugins", status: "loaded" },
        {
          id: "zeros-session",
          label: "Zeros session settings",
          status: "injected",
        },
      ],
    });
  });

  it("keeps protected-territory suppression authoritative", () => {
    const snapshot = configurationProvenanceFor("claude", {
      protectedTerritory: true,
      suppressUnsafeSources: true,
    });
    expect(snapshot.sources.filter((source) => source.status === "loaded"))
      .toHaveLength(0);
    expect(snapshot.sources.filter((source) => source.status === "suppressed"))
      .toHaveLength(3);
    expect(snapshot.sources.at(-1)).toMatchObject({
      id: "zeros-session",
      status: "injected",
    });
  });

  it("does not let selected account sources override boundary suppression", () => {
    const snapshot = configurationProvenanceFor("cursor", {
      protectedTerritory: true,
      suppressUnsafeSources: true,
      nativeMcpRequiresImport: true,
      nativeSettingSources: ["team"],
    });
    expect(
      snapshot.sources.filter((source) => source.status === "loaded"),
    ).toHaveLength(0);
    expect(
      snapshot.sources.find((source) => source.id === "team"),
    ).toMatchObject({
      status: "suppressed",
      reason: "Suppressed to preserve protected workspace boundaries",
    });
  });

  it("maps Codex layers to stable labels and never returns native paths", () => {
    const snapshot = provenanceFromCodexLayers(
      [
        {
          name: { type: "user", file: "/Users/alice/.codex/config.toml" },
          disabledReason: null,
        },
        {
          name: { type: "project", dotCodexFolder: "/secret/.codex" },
          disabledReason: "disabled by policy",
        },
        { name: { type: "sessionFlags" }, disabledReason: null },
      ],
      false,
    );
    expect(snapshot.sources).toEqual([
      { id: "user", label: "User", status: "loaded" },
      {
        id: "project",
        label: "Project",
        status: "suppressed",
        reason: "Disabled by provider policy",
      },
      {
        id: "session-flags",
        label: "Session flags",
        status: "loaded",
      },
      {
        id: "zeros-session",
        label: "Zeros session settings",
        status: "injected",
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("/Users/alice");
    expect(JSON.stringify(snapshot)).not.toContain("/secret");
  });
});

describe("Codex provider quota", () => {
  const baseline = {
    limitId: "codex",
    limitName: "Codex",
    primary: {
      usedPercent: 42,
      windowDurationMins: 300,
      resetsAt: 1_800_000_000,
    },
    secondary: {
      usedPercent: 18,
      windowDurationMins: 10_080,
      resetsAt: 1_800_500_000,
    },
    credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    individualLimit: null,
    spendControlReached: false,
    planType: "pro",
    rateLimitReachedType: null,
  };

  it("normalizes seconds, clamps percentages, and preserves text balances", () => {
    const quota = normalizeCodexQuota({
      ...baseline,
      primary: { ...baseline.primary, usedPercent: 130 },
    });
    expect(quota).toMatchObject({
      providerId: "codex",
      primary: {
        usedPercent: 100,
        resetsAt: 1_800_000_000_000,
        windowDurationMinutes: 300,
      },
      secondary: { usedPercent: 18 },
      credits: { available: true, unlimited: false, balance: "12.50" },
      plan: "pro",
    });
  });

  it("merges sparse rolling updates without clearing account metadata", () => {
    const merged = mergeCodexRateLimitSnapshot(baseline, {
      ...baseline,
      primary: { ...baseline.primary, usedPercent: 57 },
      secondary: null,
      credits: null,
      planType: null,
    });
    expect(merged.primary?.usedPercent).toBe(57);
    expect(merged.secondary).toEqual(baseline.secondary);
    expect(merged.credits).toEqual(baseline.credits);
    expect(merged.planType).toBe("pro");
  });

  it.each([false, true, null])(
    "preserves authoritative included-usage permission %s and the quota model alias",
    (ordinaryUsageAllowed) => {
      const quota = normalizeCodexQuota({
        ...baseline,
        ordinaryUsageAllowed,
        normalModelSlug: "gpt-5.6-sol",
        accountId: "private-account",
      });
      expect(quota).toMatchObject({
        ordinaryUsageAllowed,
        normalModelSlug: "gpt-5.6-sol",
      });
      expect(JSON.stringify(quota)).not.toContain("private-account");
    },
  );

  it("does not infer permission recovery from a percentage reset or lose the alias in a sparse update", () => {
    const merged = mergeCodexRateLimitSnapshot(
      {
        ...baseline,
        ordinaryUsageAllowed: false,
        normalModelSlug: "gpt-5.6-sol",
      },
      {
        ...baseline,
        primary: { ...baseline.primary, usedPercent: 0, resetsAt: 1 },
      },
    );
    expect(normalizeCodexQuota(merged)).toMatchObject({
      ordinaryUsageAllowed: false,
      normalModelSlug: "gpt-5.6-sol",
    });
  });

  it("never inherits another account's or quota bucket's counters", () => {
    const previous = {
      ...baseline,
      accountId: "a",
      ordinaryUsageAllowed: false,
      normalModelSlug: "model-a",
    };
    const incoming = {
      ...baseline,
      accountId: "b",
      secondary: null,
      credits: null,
      planType: null,
    };
    expect(mergeCodexRateLimitSnapshot(previous, incoming)).toEqual(incoming);
    const otherBucket = mergeCodexRateLimitSnapshot(previous, {
      ...baseline,
      limitId: "other",
      secondary: null,
      credits: null,
      normalModelSlug: null,
    });
    expect(otherBucket).toMatchObject({
      secondary: null,
      credits: null,
      normalModelSlug: null,
      ordinaryUsageAllowed: false,
    });
  });

  it("keeps explicit unknown permission distinct from a confirmed recovery", () => {
    const previous = { ...baseline, ordinaryUsageAllowed: false };
    expect(
      mergeCodexRateLimitSnapshot(previous, {
        ...baseline,
        ordinaryUsageAllowed: null,
      }).ordinaryUsageAllowed,
    ).toBeNull();
    expect(
      mergeCodexRateLimitSnapshot(previous, {
        ...baseline,
        ordinaryUsageAllowed: true,
      }).ordinaryUsageAllowed,
    ).toBe(true);
  });

});
