import { beforeEach, describe, expect, it } from "vitest";

const values = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, value),
  removeItem: (key: string) => void values.delete(key),
};

import {
  clearDashboardRepoFilter,
  readDashboardRepoFilter,
  resetDashboardPreferencesForTests,
  saveDashboardRepoFilter,
  readDashboardPreferences,
  updateDashboardPreferences,
} from "../../features/dashboard/preferences";

beforeEach(() => {
  values.clear();
  resetDashboardPreferencesForTests();
});

describe("dashboard presentation preferences", () => {
  it("restores the released archive toggle synchronously", () => {
    values.set("zeros:dashboard-show-archived", "1");
    expect(readDashboardPreferences()).toMatchObject({
      view: "board",
      archive: "all",
      sort: "activity",
    });
    expect(readDashboardPreferences()).toBe(readDashboardPreferences());
  });

  it("remembers list, only archived, sorting and independent display columns across reload", () => {
    updateDashboardPreferences({
      view: "list",
      archive: "archived",
      sort: "repository",
      display: { repository: false, repositoryIcon: true, lastActive: false },
    });
    const saved = readDashboardPreferences();
    resetDashboardPreferencesForTests();
    expect(readDashboardPreferences()).toEqual(saved);
    expect(readDashboardPreferences()).toMatchObject({
      view: "list",
      archive: "archived",
      display: { repository: false, repositoryIcon: true },
    });
  });

  it.each([
    "null",
    "[]",
    "{",
    '"list"',
    '{"view":"grid","sort":"random","archive":true,"display":{"repository":"false"}}',
  ])("rejects corrupt or unsupported stored values: %s", (raw) => {
    values.set("zeros:dashboard-presentation:v1", raw);
    expect(readDashboardPreferences()).toMatchObject({
      view: "board",
      archive: "active",
      sort: "activity",
      display: { repository: true },
    });
  });

  it("keeps a stable snapshot for no-op changes and retains other display options", () => {
    const initial = readDashboardPreferences();
    updateDashboardPreferences({ view: initial.view });
    expect(readDashboardPreferences()).toBe(initial);
    updateDashboardPreferences({ display: { owner: false } });
    expect(readDashboardPreferences().display.repository).toBe(true);
  });
});

describe("dashboard repository filter", () => {
  it("round-trips the selected repository", () => {
    saveDashboardRepoFilter("repo-a");
    expect(readDashboardRepoFilter()).toBe("repo-a");
    saveDashboardRepoFilter(null);
    expect(readDashboardRepoFilter()).toBeNull();
  });

  it("clears only when the deleted repository owns the filter", () => {
    saveDashboardRepoFilter("repo-a");
    clearDashboardRepoFilter("repo-b");
    expect(readDashboardRepoFilter()).toBe("repo-a");
    clearDashboardRepoFilter("repo-a");
    expect(readDashboardRepoFilter()).toBeNull();
  });
});
