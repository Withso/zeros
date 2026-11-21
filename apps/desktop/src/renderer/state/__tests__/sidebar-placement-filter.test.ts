import { beforeEach, describe, expect, it } from "vitest";
import {
  getSidebarListPreferences,
  pruneSidebarOwnerPreferences,
  resetSidebarListPreferencesForTests,
  setSidebarHiddenPlacements,
  sidebarHiddenPlacements,
  sidebarRepositoryFilterOwner,
} from "../sidebar-list-preferences";

const KEY = "zeros-sidebar-list-preferences-v1";
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  resetSidebarListPreferencesForTests();
});

describe("sidebar placement filter", () => {
  const personal = sidebarRepositoryFilterOwner(null, null);
  const a = sidebarRepositoryFilterOwner("member", "org-a");
  const b = sidebarRepositoryFilterOwner("member", "org-b");

  it("shows This Mac and Cloud by default for every owner", () => {
    expect(sidebarHiddenPlacements(personal)).toEqual([]);
    expect(sidebarHiddenPlacements(a)).toEqual([]);
  });

  it("keeps each owner's choice through A → B → A and a reload", () => {
    setSidebarHiddenPlacements(a, ["local"]);
    setSidebarHiddenPlacements(b, ["cloud"]);
    resetSidebarListPreferencesForTests();
    expect(sidebarHiddenPlacements(a)).toEqual(["local"]);
    expect(sidebarHiddenPlacements(b)).toEqual(["cloud"]);
    expect(sidebarHiddenPlacements(personal)).toEqual([]);
    expect(sidebarHiddenPlacements(a)).toBe(sidebarHiddenPlacements(a));
  });

  it("never hides both, and ignores malformed saved values", () => {
    setSidebarHiddenPlacements(a, ["local", "cloud"]);
    expect(sidebarHiddenPlacements(a)).toEqual([]);
    values.set(KEY, JSON.stringify({ hiddenPlacementsByOwner: { [a]: ["local", "cloud"], [b]: ["mars"], [personal]: "cloud" } }));
    resetSidebarListPreferencesForTests();
    expect(getSidebarListPreferences().hiddenPlacementsByOwner).toEqual({});
  });

  it("is pruned with the account's removed organizations", () => {
    setSidebarHiddenPlacements(a, ["cloud"]);
    setSidebarHiddenPlacements(b, ["cloud"]);
    pruneSidebarOwnerPreferences("member", ["org-b"]);
    expect(sidebarHiddenPlacements(a)).toEqual([]);
    expect(sidebarHiddenPlacements(b)).toEqual(["cloud"]);
  });
});
