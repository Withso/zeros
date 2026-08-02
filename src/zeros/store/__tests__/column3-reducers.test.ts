// Column-3 reducer invariants: a fresh workspace starts with one closable
// Open file tab followed by permanent Changes and Review homes. File and
// Browser tabs are multi-instance, closable, and scoped to their worktree.
import { describe, expect, it } from "vitest";

// The node test env has no DOM, but the store persistence subscriber runs on
// every dispatch. Install minimal stubs BEFORE the store module loads.
const stubStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (stubStore.has(key) ? stubStore.get(key)! : null),
  setItem: (key: string, value: string) =>
    void stubStore.set(key, String(value)),
  removeItem: (key: string) => void stubStore.delete(key),
  clear: () => stubStore.clear(),
};
(globalThis as Record<string, unknown>).window = {
  setTimeout: setTimeout.bind(globalThis),
  clearTimeout: clearTimeout.bind(globalThis),
  addEventListener: () => {},
  localStorage: globalThis.localStorage,
};

import {
  column3ScopeForFolder,
  selectColumn3,
  useWorkspaceStore,
} from "../workspace-store";
import {
  createBrowserTab,
  createChangesTab,
  createEmptyFilesTab,
  createFilesTab,
  createReviewTab,
  MAX_PERSISTED_COLUMN3_SCOPES,
} from "../../../shell/column3-tab-manager";
import type { Action } from "../store";

const dispatch = (action: Action) =>
  useWorkspaceStore.getState().dispatch(action);
const slice = () => selectColumn3(useWorkspaceStore.getState());

let sequence = 0;
function freshScope(): string {
  sequence += 1;
  const folder = `/repo/reducer-wt-${sequence}`;
  dispatch({ type: "SET_NEW_AGENT_FOLDER", folder });
  return folder;
}

describe("column3 default slice", () => {
  it("normalizes trailing separators without conflating filesystem root", () => {
    expect(column3ScopeForFolder("/repo/worktree///")).toBe("/repo/worktree");
    expect(column3ScopeForFolder("/")).toBe("/");
    expect(column3ScopeForFolder(null)).toBe("__ambient__");
  });

  it("seeds exactly Open file, Changes, Review, Context with Open file active", () => {
    freshScope();
    const { tabs, activeId, recentBrowsers } = slice();

    expect(tabs.map((tab) => [tab.type, tab.title])).toEqual([
      ["files", "Open file"],
      ["changes", "Changes"],
      ["review", "Review"],
      ["context", "Context"],
    ]);
    expect(tabs.map((tab) => Boolean(tab.pinned))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(activeId).toBe(tabs[0].id);
    expect(recentBrowsers).toEqual([]);
  });

  it("resets reused workspace state to the exact fresh-workspace layout", () => {
    freshScope();
    dispatch({
      type: "ADD_COLUMN3_TAB",
      tab: createBrowserTab({ url: "https://example.com", title: "Example" }),
    });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: createFilesTab("src/a.ts") });

    dispatch({ type: "RESET_COLUMN3_TABS" });

    expect(slice().tabs.map((tab) => tab.title)).toEqual([
      "Open file",
      "Changes",
      "Review",
      "Context",
    ]);
    expect(slice().activeId).toBe(slice().tabs[0].id);
    expect(slice().recentBrowsers).toEqual([]);
  });

  it("bounds the live per-worktree tab map and retains the newest scope", () => {
    const prefix = `/repo/bounded-${sequence}-`;
    for (let index = 0; index < MAX_PERSISTED_COLUMN3_SCOPES + 12; index += 1) {
      dispatch({
        type: "SET_NEW_AGENT_FOLDER",
        folder: `${prefix}${index}`,
      });
      dispatch({ type: "RESET_COLUMN3_TABS" });
    }

    const scopes = useWorkspaceStore.getState().column3ByScope;
    expect(Object.keys(scopes)).toHaveLength(MAX_PERSISTED_COLUMN3_SCOPES);
    expect(scopes[`${prefix}0`]).toBeUndefined();
    expect(
      scopes[`${prefix}${MAX_PERSISTED_COLUMN3_SCOPES + 11}`],
    ).toBeDefined();
  });
});

describe("ADD_COLUMN3_TAB", () => {
  it("keeps only Changes and Review singleton", () => {
    freshScope();
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    const review = slice().tabs.find((tab) => tab.type === "review")!;

    dispatch({ type: "ADD_COLUMN3_TAB", tab: createReviewTab() });
    expect(slice().tabs.filter((tab) => tab.type === "review")).toHaveLength(1);
    expect(slice().activeId).toBe(review.id);

    dispatch({ type: "ADD_COLUMN3_TAB", tab: createChangesTab() });
    expect(slice().tabs.filter((tab) => tab.type === "changes")).toHaveLength(
      1,
    );
    expect(slice().activeId).toBe(changes.id);
  });

  it("allows multiple blank/files and Browser tabs while stripping old pins", () => {
    freshScope();
    const blank = { ...createEmptyFilesTab(), pinned: true };
    const firstBrowser = { ...createBrowserTab(), pinned: true };
    const secondBrowser = createBrowserTab({ url: "https://example.com" });

    dispatch({ type: "ADD_COLUMN3_TAB", tab: blank });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: firstBrowser });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: secondBrowser });

    expect(slice().tabs.filter((tab) => tab.type === "files")).toHaveLength(2);
    expect(slice().tabs.filter((tab) => tab.type === "browser")).toHaveLength(
      2,
    );
    expect(slice().tabs.find((tab) => tab.id === blank.id)?.pinned).toBe(false);
    expect(slice().tabs.find((tab) => tab.id === firstBrowser.id)?.pinned).toBe(
      false,
    );
    expect(slice().activeId).toBe(secondBrowser.id);
  });

  it("puts the first re-created File before the permanent system tabs", () => {
    freshScope();
    const initialFile = slice().tabs.find((tab) => tab.type === "files")!;
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: initialFile.id });
    const replacement = createEmptyFilesTab();

    dispatch({ type: "ADD_COLUMN3_TAB", tab: replacement });

    expect(slice().tabs.map((tab) => tab.type)).toEqual([
      "files",
      "changes",
      "review",
      "context",
    ]);
    expect(slice().tabs[0].id).toBe(replacement.id);
  });

  it("treats a duplicate id as an idempotent no-op", () => {
    freshScope();
    const browser = createBrowserTab();
    dispatch({ type: "ADD_COLUMN3_TAB", tab: browser });
    const before = useWorkspaceStore.getState();

    dispatch({ type: "ADD_COLUMN3_TAB", tab: browser });

    expect(useWorkspaceStore.getState()).toBe(before);
  });
});

describe("REMOVE/UPDATE/ACTIVATE_COLUMN3_TAB", () => {
  it("updates a nested destination and activates its tab in one notification", () => {
    freshScope();
    const review = slice().tabs.find((tab) => tab.type === "review")!;
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    dispatch({ type: "ACTIVATE_COLUMN3_TAB", id: changes.id });
    let notifications = 0;
    const stop = useWorkspaceStore.subscribe(() => {
      notifications += 1;
    });

    dispatch({
      type: "OPEN_COLUMN3_TAB",
      id: review.id,
      updates: { reviewSubtab: "checks" },
    });
    stop();

    expect(notifications).toBe(1);
    expect(slice().activeId).toBe(review.id);
    expect(slice().tabs.find((tab) => tab.id === review.id)?.reviewSubtab).toBe(
      "checks",
    );
  });

  it("keeps Review, Changes, and viewer choices isolated per worktree", () => {
    const folderA = freshScope();
    const reviewA = slice().tabs.find((tab) => tab.type === "review")!;
    const changesA = slice().tabs.find((tab) => tab.type === "changes")!;
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: reviewA.id,
      updates: { reviewSubtab: "commits" },
    });
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: changesA.id,
      updates: {
        changesView: "tree",
        filePath: "src/a.ts",
        viewerMode: "edit",
      },
    });

    const folderB = freshScope();
    const reviewB = slice().tabs.find((tab) => tab.type === "review")!;
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: reviewB.id,
      updates: { reviewSubtab: "reviews" },
    });

    dispatch({ type: "SET_NEW_AGENT_FOLDER", folder: folderA });
    expect(slice().tabs.find((tab) => tab.id === reviewA.id)).toMatchObject({
      reviewSubtab: "commits",
    });
    expect(slice().tabs.find((tab) => tab.id === changesA.id)).toMatchObject({
      changesView: "tree",
      viewerMode: "edit",
    });

    const state = useWorkspaceStore.getState();
    expect(
      state.column3ByScope[column3ScopeForFolder(folderB)].tabs.find(
        (tab) => tab.id === reviewB.id,
      )?.reviewSubtab,
    ).toBe("reviews");
  });

  it("protects Changes/Review/Context but closes blank File, filled File, and Browser", () => {
    freshScope();
    const initial = slice().tabs;
    const blank = initial.find((tab) => tab.type === "files")!;
    const changes = initial.find((tab) => tab.type === "changes")!;
    const review = initial.find((tab) => tab.type === "review")!;
    const context = initial.find((tab) => tab.type === "context")!;

    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: changes.id,
      updates: { pinned: false },
    });
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: changes.id });
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: review.id });
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: context.id });
    expect(slice().tabs.some((tab) => tab.id === changes.id)).toBe(true);
    expect(slice().tabs.some((tab) => tab.id === review.id)).toBe(true);
    expect(slice().tabs.some((tab) => tab.id === context.id)).toBe(true);
    expect(slice().tabs.find((tab) => tab.id === changes.id)?.pinned).toBe(
      true,
    );

    dispatch({ type: "REMOVE_COLUMN3_TAB", id: blank.id });
    expect(slice().tabs.map((tab) => tab.type)).toEqual([
      "changes",
      "review",
      "context",
    ]);
    expect(slice().activeId).toBe(changes.id);

    const file = createFilesTab("src/a.ts");
    const browser = createBrowserTab();
    dispatch({ type: "ADD_COLUMN3_TAB", tab: file });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: browser });
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: file.id });
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: browser.id });
    expect(slice().tabs.map((tab) => tab.type)).toEqual([
      "changes",
      "review",
      "context",
    ]);
  });

  it("fills a blank File tab and closes the whole tab when its file closes", () => {
    freshScope();
    const blank = slice().tabs.find((tab) => tab.type === "files")!;

    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: blank.id,
      updates: { filePath: "src/a.ts", title: "a.ts" },
    });
    expect(slice().tabs.find((tab) => tab.id === blank.id)).toMatchObject({
      filePath: "src/a.ts",
      title: "a.ts",
    });

    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: blank.id,
      updates: { filePath: undefined },
    });
    expect(slice().tabs.some((tab) => tab.id === blank.id)).toBe(false);
    expect(slice().activeId).toBe(
      slice().tabs.find((tab) => tab.type === "changes")!.id,
    );
  });

  it("updates a retained Browser in its original scope after a workspace switch", () => {
    const folderA = freshScope();
    const browserA = createBrowserTab({
      url: "https://a.example.com",
      title: "Workspace A",
    });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: browserA });

    const folderB = freshScope();
    const browserB = createBrowserTab({
      url: "https://b.example.com",
      title: "Workspace B",
    });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: browserB });

    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      scope: column3ScopeForFolder(folderA),
      id: browserA.id,
      updates: { title: "Workspace A loaded" },
    });

    const state = useWorkspaceStore.getState();
    expect(
      state.column3ByScope[column3ScopeForFolder(folderA)].tabs.find(
        (tab) => tab.id === browserA.id,
      )?.title,
    ).toBe("Workspace A loaded");
    expect(slice().tabs.find((tab) => tab.id === browserB.id)?.title).toBe(
      "Workspace B",
    );
    expect(column3ScopeForFolder(folderB)).not.toBe(
      column3ScopeForFolder(folderA),
    );
  });

  it("ignores stale remove, update, and activation ids", () => {
    freshScope();
    const before = useWorkspaceStore.getState();
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: "missing" });
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: "missing",
      updates: { title: "bad" },
    });
    dispatch({ type: "ACTIVATE_COLUMN3_TAB", id: "missing" });
    expect(useWorkspaceStore.getState()).toBe(before);
  });
});

describe("Browser history", () => {
  it("records navigated pages, updates titles, deduplicates URLs, and survives close", () => {
    freshScope();
    const first = createBrowserTab({
      url: "https://example.com/docs",
      title: "Browser",
    });
    const duplicate = createBrowserTab({
      url: "https://example.com/docs",
      title: "Example docs",
    });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: first });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: duplicate });
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: duplicate.id,
      updates: { title: "Updated docs" },
    });

    expect(slice().recentBrowsers).toHaveLength(1);
    expect(slice().recentBrowsers[0]).toMatchObject({
      url: "https://example.com/docs",
      title: "Updated docs",
    });

    dispatch({ type: "REMOVE_COLUMN3_TAB", id: first.id });
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: duplicate.id });
    expect(slice().tabs.some((tab) => tab.type === "browser")).toBe(false);
    expect(slice().recentBrowsers[0].title).toBe("Updated docs");
  });

  it("does not record blank or non-web Browser URLs", () => {
    freshScope();
    const browser = createBrowserTab();
    dispatch({ type: "ADD_COLUMN3_TAB", tab: browser });
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: browser.id,
      updates: { url: "file:///tmp/index.html", title: "Local file" },
    });
    expect(slice().recentBrowsers).toEqual([]);
  });
});

describe("CLOSE_COLUMN3_FILE_IF_MATCHES", () => {
  it("does not let a delayed close for file A clear a newer file B selection", () => {
    const folder = freshScope();
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: changes.id,
      updates: { filePath: "src/a.ts", diff: true, discardable: true },
    });
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: changes.id,
      updates: { filePath: "src/b.ts", diff: true, discardable: true },
    });

    dispatch({
      type: "CLOSE_COLUMN3_FILE_IF_MATCHES",
      scope: column3ScopeForFolder(folder),
      id: changes.id,
      path: "src/a.ts",
    });

    expect(slice().tabs.find((tab) => tab.id === changes.id)).toMatchObject({
      filePath: "src/b.ts",
      diff: true,
      discardable: true,
    });
  });

  it("closes only a matching File tab and clears a matching Changes selection", () => {
    const folder = freshScope();
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    const file = createFilesTab("src/gone.ts");
    dispatch({ type: "ADD_COLUMN3_TAB", tab: file });
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: changes.id,
      updates: { filePath: "src/gone.ts", diff: true, discardable: true },
    });
    const close = (id: string) =>
      dispatch({
        type: "CLOSE_COLUMN3_FILE_IF_MATCHES",
        scope: column3ScopeForFolder(folder),
        id,
        path: "src/gone.ts",
      });

    close(file.id);
    close(changes.id);

    expect(slice().tabs.some((tab) => tab.id === file.id)).toBe(false);
    expect(slice().tabs.find((tab) => tab.id === changes.id)).toMatchObject({
      filePath: undefined,
      diff: false,
      discardable: false,
    });
  });
});

describe("RECONCILE_COLUMN3_FILE_DISCARD", () => {
  it("keeps reverted tracked live diffs open in Edit and leaves history alone", () => {
    const folder = freshScope();
    const file = createFilesTab("src/a.ts", {
      diff: true,
      diffScope: "all",
      discardable: true,
    });
    const historical = createFilesTab("src/a.ts", {
      diff: true,
      diffScope: "commit",
      diffSha: "abc123",
    });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: file });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: historical });

    dispatch({
      type: "RECONCILE_COLUMN3_FILE_DISCARD",
      scope: folder,
      path: "src/a.ts",
      outcome: "reverted",
    });

    expect(slice().tabs.find((tab) => tab.id === file.id)).toMatchObject({
      filePath: "src/a.ts",
      diff: false,
      discardable: false,
      contentRevision: 1,
    });
    expect(slice().tabs.find((tab) => tab.id === historical.id)).toMatchObject({
      diff: true,
      diffScope: "commit",
    });
  });

  it("closes every File tab for a removed path and clears Changes selection", () => {
    const folder = freshScope();
    const blank = slice().tabs.find((tab) => tab.type === "files")!;
    dispatch({ type: "REMOVE_COLUMN3_TAB", id: blank.id });
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    const first = createFilesTab("scratch.txt", { isNewFile: true });
    const second = createFilesTab("scratch.txt", { isNewFile: true });
    const neighbor = createFilesTab("keep.txt");
    dispatch({ type: "ADD_COLUMN3_TAB", tab: first });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: second });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: neighbor });
    dispatch({
      type: "UPDATE_COLUMN3_TAB",
      id: changes.id,
      updates: {
        filePath: "scratch.txt",
        diff: true,
        discardable: true,
        isNewFile: true,
      },
    });
    dispatch({ type: "ACTIVATE_COLUMN3_TAB", id: second.id });

    dispatch({
      type: "RECONCILE_COLUMN3_FILE_DISCARD",
      scope: folder,
      path: "scratch.txt",
      outcome: "removed",
    });

    expect(slice().tabs.some((tab) => tab.filePath === "scratch.txt")).toBe(
      false,
    );
    expect(slice().activeId).toBe(neighbor.id);
    expect(slice().tabs.find((tab) => tab.id === changes.id)).toMatchObject({
      filePath: undefined,
      diff: false,
      discardable: false,
      isNewFile: false,
    });
  });

  it("targets the operation's workspace after the active workspace changes", () => {
    const folderA = freshScope();
    const fileA = createFilesTab("same.txt", { isNewFile: true });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: fileA });

    const folderB = freshScope();
    const fileB = createFilesTab("same.txt", { isNewFile: true });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: fileB });
    dispatch({
      type: "RECONCILE_COLUMN3_FILE_DISCARD",
      scope: `${folderA}/`,
      path: "same.txt",
      outcome: "removed",
    });

    const state = useWorkspaceStore.getState();
    expect(
      state.column3ByScope[column3ScopeForFolder(folderA)].tabs.some(
        (tab) => tab.id === fileA.id,
      ),
    ).toBe(false);
    expect(
      state.column3ByScope[column3ScopeForFolder(folderB)].tabs.some(
        (tab) => tab.id === fileB.id,
      ),
    ).toBe(true);
  });
});

describe("REORDER_COLUMN3_TABS", () => {
  it("keeps the first requested File first and Changes/Review immediately next", () => {
    freshScope();
    const first = createFilesTab("a.ts");
    const second = createFilesTab("b.ts");
    const browser = createBrowserTab();
    dispatch({ type: "ADD_COLUMN3_TAB", tab: first });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: second });
    dispatch({ type: "ADD_COLUMN3_TAB", tab: browser });
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    const review = slice().tabs.find((tab) => tab.type === "review")!;
    const initialBlank = slice().tabs.find(
      (tab) => tab.type === "files" && !tab.filePath,
    )!;

    dispatch({
      type: "REORDER_COLUMN3_TABS",
      ids: [
        browser.id,
        second.id,
        review.id,
        first.id,
        changes.id,
        initialBlank.id,
      ],
    });

    const context = slice().tabs.find((tab) => tab.type === "context")!;
    expect(slice().tabs.map((tab) => tab.id)).toEqual([
      second.id,
      changes.id,
      review.id,
      context.id,
      browser.id,
      first.id,
      initialBlank.id,
    ]);
  });
});
