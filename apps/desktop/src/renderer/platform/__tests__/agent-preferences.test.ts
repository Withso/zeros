import { beforeEach, describe, expect, it, vi } from "vitest";

describe("agent settings outbox", () => {
  beforeEach(() => {
    vi.resetModules();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    });
  });
  it("retains failed saves through reload and does not acknowledge a newer edit with an older response", async () => {
    let outbox = await import("../agent-preferences");
    outbox.queueAgentPreferenceChanges({ models: { default_plan_mode: true } });
    const sent = outbox.pendingAgentPreferences();
    outbox.queueAgentPreferenceChanges({
      models: { default_plan_mode: false },
    });
    expect(
      outbox.acceptAgentPreferences(
        { models: { default_plan_mode: true } },
        sent,
      ),
    ).toEqual({ models: { default_plan_mode: false } });
    vi.resetModules();
    outbox = await import("../agent-preferences");
    expect(outbox.pendingAgentPreferences().size).toBe(1);
    const next = outbox.pendingAgentPreferences();
    outbox.acceptAgentPreferences(
      { models: { default_plan_mode: false } },
      next,
    );
    expect(outbox.pendingAgentPreferences().size).toBe(0);
  });
  it("diffs individual controls and overlays pending deletions during file refresh", async () => {
    const outbox = await import("../agent-preferences");
    outbox.queueAgentPreferenceChanges(
      { providers: { claude: { auth: "cli", base_url: null } } },
      { providers: { claude: { auth: "cli", base_url: "old" } } },
    );
    expect(
      [...outbox.pendingAgentPreferences().values()].map((entry) => entry.path),
    ).toEqual([["providers", "claude", "base_url"]]);
    expect(
      outbox.acceptAgentPreferences(
        { providers: { claude: { base_url: "old", auth: "api-key" } } },
        new Map(),
      ),
    ).toEqual({ providers: { claude: { auth: "api-key" } } });
  });
});
