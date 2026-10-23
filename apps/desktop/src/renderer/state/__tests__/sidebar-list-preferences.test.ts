import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetSidebarRepositoryFilter,
  getSidebarListPreferences,
  pruneSidebarOwnerPreferences,
  resetSidebarListPreferencesForTests,
  setSidebarRepositoryIds,
  setSidebarStatusCollapsed,
  setSidebarWorkspaceSort,
  sidebarRepositoryFilterOwner,
  sidebarRepositoryIds,
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

describe("sidebar list preferences", () => {
  it("defaults to Updated and restores Created synchronously on reload", () => {
    expect(getSidebarListPreferences().sort).toBe("updated");
    setSidebarWorkspaceSort("created");
    resetSidebarListPreferencesForTests();
    expect(getSidebarListPreferences().sort).toBe("created");
  });

  it("isolates Local, organization and account selections through A → B → A", () => {
    const local = sidebarRepositoryFilterOwner(null, null);
    const a = sidebarRepositoryFilterOwner("account-a", "org-a");
    const b = sidebarRepositoryFilterOwner("account-a", "org-b");
    const otherAccount = sidebarRepositoryFilterOwner("account-b", "org-a");
    setSidebarRepositoryIds(a, ["project-a", "cloud-a"]);
    setSidebarRepositoryIds(local, ["local-project"]);
    expect(sidebarRepositoryIds(b)).toEqual([]);
    expect(sidebarRepositoryIds(otherAccount)).toEqual([]);
    setSidebarRepositoryIds(b, ["project-b"]);
    resetSidebarListPreferencesForTests();
    expect(sidebarRepositoryIds(a)).toEqual(["project-a", "cloud-a"]);
    expect(sidebarRepositoryIds(b)).toEqual(["project-b"]);
    expect(
      sidebarRepositoryIds(sidebarRepositoryFilterOwner("account-a", null)),
    ).toEqual(["local-project"]);
  });

  it("prunes removed repositories and organizations without crossing accounts", () => {
    const a = sidebarRepositoryFilterOwner("a", "org-a");
    const b = sidebarRepositoryFilterOwner("a", "org-b");
    const otherAccount = sidebarRepositoryFilterOwner("b", "org-b");
    setSidebarRepositoryIds(a, ["keep", "remove"]);
    setSidebarRepositoryIds(b, ["cloud-b"]);
    setSidebarRepositoryIds(otherAccount, ["other"]);
    forgetSidebarRepositoryFilter("remove");
    expect(sidebarRepositoryIds(a)).toEqual(["keep"]);
    pruneSidebarOwnerPreferences("a", ["org-a"]);
    expect(sidebarRepositoryIds(b)).toEqual([]);
    expect(sidebarRepositoryIds(otherAccount)).toEqual(["other"]);
    forgetSidebarRepositoryFilter("keep");
    expect(sidebarRepositoryIds(a)).toEqual([]);
  });

  it("bounds and validates persisted filters, sort and status collapse", () => {
    values.set(
      KEY,
      JSON.stringify({
        sort: "invalid",
        repositoryIdsByOwner: {
          local: [null, "", "repo", "repo", "x".repeat(513), 1],
        },
        collapsedStatuses: ["backlog", "archived", "done", "done", null],
      }),
    );
    expect(getSidebarListPreferences().sort).toBe("updated");
    expect(sidebarRepositoryIds("local")).toEqual(["repo"]);
    expect(sidebarRepositoryIds("toString")).toEqual([]);
    expect(getSidebarListPreferences().collapsedStatuses).toEqual([
      "backlog",
      "done",
    ]);
    for (let i = 0; i < 40; i++)
      setSidebarRepositoryIds(
        `owner-${i}`,
        Array.from({ length: 300 }, (_, j) => `repo-${j}`),
      );
    expect(
      Object.keys(getSidebarListPreferences().repositoryIdsByOwner),
    ).toHaveLength(32);
    expect(sidebarRepositoryIds("owner-39")).toHaveLength(256);
    expect(sidebarRepositoryIds("owner-0")).toEqual([]);
  });

  it("retains stable snapshots on unchanged writes and restores status collapse", () => {
    setSidebarRepositoryIds("local", ["repo"]);
    const current = getSidebarListPreferences();
    const ids = sidebarRepositoryIds("local");
    setSidebarRepositoryIds("local", ["repo"]);
    setSidebarWorkspaceSort("updated");
    expect(getSidebarListPreferences()).toBe(current);
    expect(sidebarRepositoryIds("local")).toBe(ids);
    setSidebarStatusCollapsed("in-review", true);
    resetSidebarListPreferencesForTests();
    expect(getSidebarListPreferences().collapsedStatuses).toEqual([
      "in-review",
    ]);
    setSidebarStatusCollapsed("in-review", false);
    expect(getSidebarListPreferences().collapsedStatuses).toEqual([]);
  });

  it("keeps in-session preferences when storage cannot be written", () => {
    localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    setSidebarWorkspaceSort("created");
    setSidebarRepositoryIds("local", ["repo"]);
    expect(getSidebarListPreferences().sort).toBe("created");
    expect(sidebarRepositoryIds("local")).toEqual(["repo"]);
  });
});
