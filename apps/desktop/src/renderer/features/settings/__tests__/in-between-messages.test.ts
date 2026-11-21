import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSONAL_PREFERENCE_STORAGE,
  personalPreferencesSchema,
} from "@zeros/protocol/personal-preferences";

const storageKey = PERSONAL_PREFERENCE_STORAGE.show_in_between_messages;

describe("show in-between messages preference", () => {
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

  it("is on by default, for older settings and anything but an explicit false", async () => {
    const preference = await import("../in-between-messages");
    expect(preference.getShowInBetweenMessages()).toBe(true);
    for (const raw of ["true", '"false"', "0", "null", "invalid"]) {
      localStorage.setItem(storageKey, raw);
      expect(preference.getShowInBetweenMessages()).toBe(true);
    }
    localStorage.setItem(storageKey, "false");
    expect(preference.getShowInBetweenMessages()).toBe(false);
    expect(personalPreferencesSchema.safeParse({ show_in_between_messages: "false" }).success).toBe(false);
    expect(personalPreferencesSchema.parse({ show_in_between_messages: false })).toEqual({ show_in_between_messages: false });
  });

  it("persists across reloads, queues both choices for the settings file, and reads a removed key as on", async () => {
    let preference = await import("../in-between-messages");
    preference.setShowInBetweenMessages(false);
    let cache = await import("../../../platform/personal-preferences");
    expect(cache.pendingPreferences().get("show_in_between_messages")?.value).toBe(false);
    vi.resetModules();
    preference = await import("../in-between-messages");
    expect(preference.getShowInBetweenMessages()).toBe(false);
    preference.setShowInBetweenMessages(true);
    cache = await import("../../../platform/personal-preferences");
    expect(cache.pendingPreferences().get("show_in_between_messages")?.value).toBe(true);
    cache.acceptPersonalPreferences({ show_in_between_messages: false }, cache.pendingPreferences());
    expect(preference.getShowInBetweenMessages()).toBe(false);
    cache.acceptPersonalPreferences({}, new Map());
    expect(preference.getShowInBetweenMessages()).toBe(true);
  });
});
