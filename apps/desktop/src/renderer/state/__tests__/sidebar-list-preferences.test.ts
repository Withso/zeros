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

describe("sidebar view preferences", () => {
  it("defaults to the neutral view and restores changes on reload", async () => {
    const prefs = await import("../sidebar-list-preferences");
    expect(prefs.getSidebarListPreferences().view).toEqual(prefs.SIDEBAR_VIEW_DEFAULTS);
    prefs.setSidebarView({ compact: true, statuses: ["needs-you"], direction: "asc" });
    resetSidebarListPreferencesForTests();
    const { view } = prefs.getSidebarListPreferences();
    expect([view.compact, view.statuses, view.direction]).toEqual([true, ["needs-you"], "asc"]);
  });

  it("drops unknown or malformed values from storage", async () => {
    const prefs = await import("../sidebar-list-preferences");
    values.set(KEY, JSON.stringify({ sort: "updated", view: { compact: "yes", statuses: ["input", "bogus"], grouping: "nope", collapsedSections: ["pinned", 3] } }));
    resetSidebarListPreferencesForTests();
    const { view, sort } = prefs.getSidebarListPreferences();
    expect(sort).toBe("updated");
    expect(view.compact).toBe(false);
    expect(view.statuses).toEqual(["needs-you"]);
    expect(view.grouping).toBeNull();
    expect(view.collapsedSections).toEqual(["pinned"]);
  });

  it("folds the five earlier status filters into Needs you, Working and Idle", async () => {
    const prefs = await import("../sidebar-list-preferences");
    values.set(KEY, JSON.stringify({ view: { statuses: ["failed", "unread", "input", "idle", "working"] } }));
    resetSidebarListPreferencesForTests();
    expect(prefs.getSidebarListPreferences().view.statuses).toEqual(["needs-you", "working", "idle"]);
    values.set(KEY, JSON.stringify({ view: { statuses: ["unread"] } }));
    resetSidebarListPreferencesForTests();
    expect(prefs.getSidebarListPreferences().view.statuses).toEqual(["needs-you"]);
  });

  it("keeps each grouping's group order and hidden groups, bounded and validated", async () => {
    const prefs = await import("../sidebar-list-preferences");
    prefs.setSidebarGroupOrder("status", ["working", "needs-you"]);
    prefs.setSidebarGroupHidden("status", "archived", true);
    prefs.setSidebarGroupHidden("pr", "closed", true);
    resetSidebarListPreferencesForTests();
    let { view } = prefs.getSidebarListPreferences();
    expect(view.groupOrder).toEqual({ status: ["working", "needs-you"] });
    expect(view.hiddenGroups).toEqual({ status: ["archived"], pr: ["closed"] });
    prefs.setSidebarGroupHidden("status", "archived", false);
    expect(prefs.getSidebarListPreferences().view.hiddenGroups).toEqual({ pr: ["closed"] });
    // A filtered menu reorders only the groups it lists; the others keep
    // their stored places instead of being dropped from the order.
    prefs.setSidebarGroupOrder("repository", ["a", "b", "c", "d"]);
    prefs.setSidebarGroupOrder("repository", ["d", "b"]);
    expect(prefs.getSidebarListPreferences().view.groupOrder.repository).toEqual(["a", "d", "c", "b"]);
    prefs.setSidebarGroupOrder("repository", ["e", "a"]);
    expect(prefs.getSidebarListPreferences().view.groupOrder.repository).toEqual(["e", "d", "c", "b", "a"]);
    values.set(KEY, JSON.stringify({ view: { groupOrder: { status: ["a", 4, "", "a"], bogus: ["x"] }, hiddenGroups: "no" } }));
    resetSidebarListPreferencesForTests();
    ({ view } = prefs.getSidebarListPreferences());
    expect(view.groupOrder).toEqual({ status: ["a"] });
    expect(view.hiddenGroups).toEqual({});
  });

  it("reads a store written before the view existed", async () => {
    const prefs = await import("../sidebar-list-preferences");
    values.set(KEY, JSON.stringify({ sort: "created", repositoryIdsByOwner: {}, collapsedStatuses: [], hiddenPlacementsByOwner: {} }));
    resetSidebarListPreferencesForTests();
    expect(prefs.getSidebarListPreferences().sort).toBe("created");
    expect(prefs.getSidebarListPreferences().view).toEqual(prefs.SIDEBAR_VIEW_DEFAULTS);
  });

  it("Reset clears menu options but keeps collapsed sections and groups", async () => {
    const prefs = await import("../sidebar-list-preferences");
    prefs.setSidebarView({ compact: true, unreadOnly: true, showProjectName: true });
    prefs.setSidebarSectionCollapsed("pinned", true);
    prefs.setSidebarGroupCollapsed("recency:today", true);
    prefs.resetSidebarView(["unreadOnly"]);
    expect(prefs.getSidebarListPreferences().view.compact).toBe(true);
    expect(prefs.getSidebarListPreferences().view.unreadOnly).toBe(false);
    prefs.resetSidebarView();
    const { view } = prefs.getSidebarListPreferences();
    expect(view.compact).toBe(false);
    expect(view.showProjectName).toBe(false);
    expect(view.collapsedSections).toEqual(["pinned"]);
    expect(view.collapsedGroups).toEqual(["recency:today"]);
    prefs.setSidebarSectionCollapsed("pinned", false);
    expect(prefs.getSidebarListPreferences().view.collapsedSections).toEqual([]);
  });
});
