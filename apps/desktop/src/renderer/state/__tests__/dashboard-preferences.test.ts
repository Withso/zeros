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
} from "../../features/dashboard/preferences";

beforeEach(() => {
  values.clear();
  resetDashboardPreferencesForTests();
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
