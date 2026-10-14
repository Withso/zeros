import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSONAL_PREFERENCE_STORAGE, personalPreferencesSchema } from "@zeros/protocol/personal-preferences";

describe("follow-up behavior preference", () => {
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

  it("defaults new users and invalid saved values to Queue", async () => {
    const preference = await import("../follow-up-behavior");
    expect(preference.getFollowUpBehavior()).toBe("queue");
    localStorage.setItem(PERSONAL_PREFERENCE_STORAGE.follow_up_behavior, '"invalid"');
    vi.resetModules();
    expect((await import("../follow-up-behavior")).getFollowUpBehavior()).toBe("queue");
    expect(personalPreferencesSchema.safeParse({ follow_up_behavior: "invalid" }).success).toBe(false);
  });

  it("persists Steer across reload and stages it for the user settings file", async () => {
    const preference = await import("../follow-up-behavior");
    preference.setFollowUpBehavior("steer");
    expect(preference.getFollowUpBehavior()).toBe("steer");
    const cache = await import("../../../platform/personal-preferences");
    expect(cache.pendingPreferences().get("follow_up_behavior")?.value).toBe("steer");
    vi.resetModules();
    expect((await import("../follow-up-behavior")).getFollowUpBehavior()).toBe("steer");
  });

  it("accepts file updates and deletion without overwriting a newer pending selection", async () => {
    const preference = await import("../follow-up-behavior");
    const cache = await import("../../../platform/personal-preferences");
    cache.acceptPersonalPreferences({ follow_up_behavior: "steer" }, new Map());
    expect(preference.getFollowUpBehavior()).toBe("steer");
    preference.setFollowUpBehavior("queue");
    cache.acceptPersonalPreferences({ follow_up_behavior: "steer" }, new Map());
    expect(preference.getFollowUpBehavior()).toBe("queue");
    cache.acceptPersonalPreferences({}, cache.pendingPreferences());
    expect(preference.getFollowUpBehavior()).toBe("queue");
  });
});
