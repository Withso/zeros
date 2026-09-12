import { beforeEach, describe, expect, it, vi } from "vitest";

describe("personal preference cache and durable outbox", () => {
  beforeEach(() => {
    vi.resetModules();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  it("does not let an older file response overwrite an edit made while saving", async () => {
    const prefs = await import("../personal-preferences");
    const key = "zeros.appearance.v2";
    prefs.writePreferenceCache(
      key,
      JSON.stringify({ mode: "dark", codeThemes: {} }),
    );
    const sent = prefs.pendingPreferences();
    prefs.writePreferenceCache(
      key,
      JSON.stringify({ mode: "light", codeThemes: {} }),
    );
    prefs.acceptPersonalPreferences(
      { appearance: { mode: "dark", codeThemes: {} } },
      sent,
    );
    expect(JSON.parse(prefs.readPreferenceCache(key)!)).toMatchObject({
      mode: "light",
    });
    expect(prefs.pendingPreferences().size).toBe(1);
    vi.resetModules();
    const reloaded = await import("../personal-preferences");
    expect(
      reloaded.pendingPreferences().get("appearance")?.value,
    ).toMatchObject({ mode: "light" });
  });
  it("hydrates file edits and deletions without turning them into new writes", async () => {
    const prefs = await import("../personal-preferences");
    const onChange = vi.fn();
    prefs.subscribePreferenceCache("zeros.experimentalFeatures", onChange);
    prefs.acceptPersonalPreferences(
      { experimental: { terminalAgents: true } },
      new Map(),
    );
    expect(onChange).toHaveBeenCalledOnce();
    expect(prefs.pendingPreferences().size).toBe(0);
    prefs.acceptPersonalPreferences({}, new Map());
    expect(prefs.readPreferenceCache("zeros.experimentalFeatures")).toBeNull();
    expect(prefs.pendingPreferences().size).toBe(0);
  });
  it("keeps unrelated navigation and secrets out of the preference migration", async () => {
    localStorage.setItem("zeros-chat-draft", "private text");
    localStorage.setItem("zeros-analytics:opt-out", "true");
    const prefs = await import("../personal-preferences");
    expect(prefs.legacyPersonalPreferences()).toEqual({
      analytics_opt_out: true,
    });
  });
});
