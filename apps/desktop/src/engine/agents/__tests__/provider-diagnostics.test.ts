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
});
