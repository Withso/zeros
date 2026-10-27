import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_PREFERENCE_STORAGE,
  personalPreferencesSchema,
} from "@zeros/protocol/personal-preferences";

const storageKey = PERSONAL_PREFERENCE_STORAGE.restart_automatically_on_update;

describe("automatic update restart preference", () => {
  beforeEach(() => {
    vi.resetModules();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requires an explicit boolean opt-in and defaults older settings to off", async () => {
    const preference = await import("../update-settings");
    expect(preference.getRestartAutomaticallyOnUpdate()).toBe(false);
    expect(personalPreferencesSchema.parse({})).toEqual({});
    for (const raw of ['"true"', "1", "null", "invalid", "false"]) {
      localStorage.setItem(storageKey, raw);
      expect(preference.getRestartAutomaticallyOnUpdate()).toBe(false);
    }
    expect(
      personalPreferencesSchema.safeParse({
        restart_automatically_on_update: "true",
      }).success,
    ).toBe(false);
  });

  it("persists opt-in and opt-out across reloads and queues both for the settings file", async () => {
    let preference = await import("../update-settings");
    preference.setRestartAutomaticallyOnUpdate(true);
    expect(preference.getRestartAutomaticallyOnUpdate()).toBe(true);
    let cache = await import("../../../platform/personal-preferences");
    expect(
      cache.pendingPreferences().get("restart_automatically_on_update")?.value,
    ).toBe(true);
    vi.resetModules();
    preference = await import("../update-settings");
    expect(preference.getRestartAutomaticallyOnUpdate()).toBe(true);
    preference.setRestartAutomaticallyOnUpdate(false);
    cache = await import("../../../platform/personal-preferences");
    expect(
      cache.pendingPreferences().get("restart_automatically_on_update")?.value,
    ).toBe(false);
    vi.resetModules();
    expect(
      (await import("../update-settings")).getRestartAutomaticallyOnUpdate(),
    ).toBe(false);
  });

  it("accepts file edits and removal without reverting a newer pending opt-out", async () => {
    const preference = await import("../update-settings");
    const cache = await import("../../../platform/personal-preferences");
    cache.acceptPersonalPreferences(
      { restart_automatically_on_update: true },
      new Map(),
    );
    expect(preference.getRestartAutomaticallyOnUpdate()).toBe(true);
    preference.setRestartAutomaticallyOnUpdate(false);
    cache.acceptPersonalPreferences(
      { restart_automatically_on_update: true },
      new Map(),
    );
    expect(preference.getRestartAutomaticallyOnUpdate()).toBe(false);
    cache.acceptPersonalPreferences(
      { restart_automatically_on_update: false },
      cache.pendingPreferences(),
    );
    cache.acceptPersonalPreferences(
      { restart_automatically_on_update: true },
      new Map(),
    );
    cache.acceptPersonalPreferences({}, new Map());
    expect(preference.getRestartAutomaticallyOnUpdate()).toBe(false);
  });

  it("keeps an immediate opt-out in memory when storage is unavailable", async () => {
    const preference = await import("../update-settings");
    preference.setRestartAutomaticallyOnUpdate(true);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    preference.setRestartAutomaticallyOnUpdate(false);
    expect(preference.getRestartAutomaticallyOnUpdate()).toBe(false);
    const cache = await import("../../../platform/personal-preferences");
    expect(
      cache.pendingPreferences().get("restart_automatically_on_update")?.value,
    ).toBe(false);
  });
});
