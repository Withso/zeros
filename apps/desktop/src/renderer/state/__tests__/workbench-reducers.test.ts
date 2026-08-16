// Workbench reducer invariants: a fresh workspace starts with the FIXED Open
// file home (permanent — closing it only closes its file) followed by the
// permanent Changes and Review homes. Extra File and Browser tabs are
// multi-instance, closable, and scoped to their worktree.
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
  workbenchScopeForFolder,
  selectWorkbench,
  useWorkspaceStore,
} from "../workspace-store";
import {
  createBrowserTab,
  createChangesTab,
  createEmptyFilesTab,
  createFilesTab,
  createReviewTab,
  MAX_PERSISTED_WORKBENCH_SCOPES,
} from "../../shell/workbench/tab-model";
import type { Action } from "../store";

const dispatch = (action: Action) =>
  useWorkspaceStore.getState().dispatch(action);
const slice = () => selectWorkbench(useWorkspaceStore.getState());

let sequence = 0;
function freshScope(): string {
  sequence += 1;
  const folder = `/repo/reducer-wt-${sequence}`;
  dispatch({ type: "SET_NEW_AGENT_FOLDER", folder });
  return folder;
}

describe("workbench default slice", () => {
  it("normalizes trailing separators without conflating filesystem root", () => {
    expect(workbenchScopeForFolder("/repo/worktree///")).toBe("/repo/worktree");
    expect(workbenchScopeForFolder("/")).toBe("/");
    expect(workbenchScopeForFolder(null)).toBe("__ambient__");
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
    expect(tabs[0].fixed).toBe(true);
    expect(activeId).toBe(tabs[0].id);
    expect(recentBrowsers).toEqual([]);
  });

  it("resets reused workspace state to the exact fresh-workspace layout", () => {
    freshScope();
    dispatch({
      type: "ADD_WORKBENCH_TAB",
      tab: createBrowserTab({ url: "https://example.com", title: "Example" }),
    });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: createFilesTab("src/a.ts") });

    dispatch({ type: "RESET_WORKBENCH_TABS" });

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
    for (
      let index = 0;
      index < MAX_PERSISTED_WORKBENCH_SCOPES + 12;
      index += 1
    ) {
      dispatch({
        type: "SET_NEW_AGENT_FOLDER",
        folder: `${prefix}${index}`,
      });
      dispatch({ type: "RESET_WORKBENCH_TABS" });
    }

    const scopes = useWorkspaceStore.getState().workbenchByScope;
    expect(Object.keys(scopes)).toHaveLength(MAX_PERSISTED_WORKBENCH_SCOPES);
    expect(scopes[`${prefix}0`]).toBeUndefined();
    expect(
      scopes[`${prefix}${MAX_PERSISTED_WORKBENCH_SCOPES + 11}`],
    ).toBeDefined();
  });
});

describe("ADD_WORKBENCH_TAB", () => {
  it("keeps only Changes and Review singleton", () => {
    freshScope();
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    const review = slice().tabs.find((tab) => tab.type === "review")!;

    dispatch({ type: "ADD_WORKBENCH_TAB", tab: createReviewTab() });
    expect(slice().tabs.filter((tab) => tab.type === "review")).toHaveLength(1);
    expect(slice().activeId).toBe(review.id);

    dispatch({ type: "ADD_WORKBENCH_TAB", tab: createChangesTab() });
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

    dispatch({ type: "ADD_WORKBENCH_TAB", tab: blank });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: firstBrowser });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: secondBrowser });

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

  it("keeps the fixed home leading; extra blanks append after the system tabs", () => {
    freshScope();
    const home = slice().tabs.find((tab) => tab.type === "files")!;
    const extra = createEmptyFilesTab();

    dispatch({ type: "ADD_WORKBENCH_TAB", tab: extra });

    expect(slice().tabs.map((tab) => tab.type)).toEqual([
      "files",
      "changes",
      "review",
      "context",
      "files",
    ]);
    expect(slice().tabs[0].id).toBe(home.id);
    expect(slice().tabs[4].id).toBe(extra.id);
    expect(slice().tabs[4].fixed).toBeUndefined();
    expect(slice().activeId).toBe(extra.id);
  });

  it("treats a duplicate id as an idempotent no-op", () => {
    freshScope();
    const browser = createBrowserTab();
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: browser });
    const before = useWorkspaceStore.getState();

    dispatch({ type: "ADD_WORKBENCH_TAB", tab: browser });

    expect(useWorkspaceStore.getState()).toBe(before);
  });

  it("adds to its exact workspace after the active workspace changes", () => {
    const folderA = freshScope();
    const scopeA = workbenchScopeForFolder(folderA);
    const homeA = slice().tabs[0];

    const folderB = freshScope();
    const scopeB = workbenchScopeForFolder(folderB);
    const beforeB = slice();
    const fileA = createFilesTab("src/late-agent-open.ts");

    dispatch({ type: "ADD_WORKBENCH_TAB", scope: scopeA, tab: fileA });

    const state = useWorkspaceStore.getState();
    expect(state.workbenchByScope[scopeA]).toMatchObject({
      activeId: fileA.id,
      tabs: [
        { id: homeA.id },
        { type: "changes" },
        { type: "review" },
        { type: "context" },
        { id: fileA.id, fileTreeVisible: false },
      ],
    });
    expect(selectWorkbench(state)).toBe(beforeB);
    expect(workbenchScopeForFolder(folderB)).toBe(scopeB);
  });
});

describe("REMOVE/UPDATE/ACTIVATE_WORKBENCH_TAB", () => {
  it("removes a delayed browser tab from its explicit scope without touching the active workspace", () => {
    const scopeA = "/workspace/a";
    const scopeB = "/workspace/b";
    const browserA = createBrowserTab({
      url: "https://example.com/a",
      title: "A",
    });
    const browserB = createBrowserTab({
      url: "https://example.com/b",
      title: "B",
    });
    dispatch({ type: "ADD_WORKBENCH_TAB", scope: scopeA, tab: browserA });
    dispatch({ type: "ADD_WORKBENCH_TAB", scope: scopeB, tab: browserB });
    dispatch({ type: "REMOVE_WORKBENCH_TAB", scope: scopeA, id: browserA.id });
    expect(
      useWorkspaceStore.getState().workbenchByScope[scopeA]?.tabs,
    ).not.toContainEqual(browserA);
    expect(
      useWorkspaceStore.getState().workbenchByScope[scopeB]?.tabs,
    ).toContainEqual(browserB);
  });
  it("updates a nested destination and activates its tab in one notification", () => {
    freshScope();
    const review = slice().tabs.find((tab) => tab.type === "review")!;
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: changes.id });
    let notifications = 0;
    const stop = useWorkspaceStore.subscribe(() => {
      notifications += 1;
    });

    dispatch({
      type: "OPEN_WORKBENCH_TAB",
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
      type: "UPDATE_WORKBENCH_TAB",
      id: reviewA.id,
      updates: { reviewSubtab: "commits" },
    });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
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
      type: "UPDATE_WORKBENCH_TAB",
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
      state.workbenchByScope[workbenchScopeForFolder(folderB)].tabs.find(
        (tab) => tab.id === reviewB.id,
      )?.reviewSubtab,
    ).toBe("reviews");
  });

  it("keeps file-tree visibility isolated by File tab across A → B → A", () => {
    freshScope();
    const tabA = slice().tabs.find((tab) => tab.type === "files")!;
    const tabB = createFilesTab("src/b.ts");
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: tabB });

    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: tabA.id,
      updates: { fileTreeVisible: true },
    });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: tabB.id,
      updates: { fileTreeVisible: false },
    });

    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: tabA.id });
    expect(
      slice().tabs.find((tab) => tab.id === tabA.id)?.fileTreeVisible,
    ).toBe(true);
    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: tabB.id });
    expect(
      slice().tabs.find((tab) => tab.id === tabB.id)?.fileTreeVisible,
    ).toBe(false);
    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: tabA.id });
    expect(
      slice().tabs.find((tab) => tab.id === tabA.id)?.fileTreeVisible,
    ).toBe(true);
  });

  it("protects Changes/Review/Context and the fixed home; extras close fully", () => {
    freshScope();
    const initial = slice().tabs;
    const home = initial.find((tab) => tab.type === "files")!;
    const changes = initial.find((tab) => tab.type === "changes")!;
    const review = initial.find((tab) => tab.type === "review")!;
    const context = initial.find((tab) => tab.type === "context")!;

    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: changes.id,
      updates: { pinned: false },
    });
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: changes.id });
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: review.id });
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: context.id });
    expect(slice().tabs.some((tab) => tab.id === changes.id)).toBe(true);
    expect(slice().tabs.some((tab) => tab.id === review.id)).toBe(true);
    expect(slice().tabs.some((tab) => tab.id === context.id)).toBe(true);
    expect(slice().tabs.find((tab) => tab.id === changes.id)?.pinned).toBe(
      true,
    );

    // Closing the BLANK home is a no-op — there's no file to close and the
    // tab itself is permanent.
    const before = useWorkspaceStore.getState();
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: home.id });
    expect(useWorkspaceStore.getState()).toBe(before);

    const file = createFilesTab("src/a.ts");
    const browser = createBrowserTab();
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: file });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: browser });
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: file.id });
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: browser.id });
    expect(slice().tabs.map((tab) => tab.type)).toEqual([
      "files",
      "changes",
      "review",
      "context",
    ]);
  });

  it("reverts the fixed home to Open file when its file closes via ✕", () => {
    freshScope();
    const home = slice().tabs.find((tab) => tab.type === "files")!;
    dispatch({
      type: "OPEN_WORKBENCH_TAB",
      id: home.id,
      updates: {
        filePath: "src/a.ts",
        title: "a.ts",
        diff: true,
        diffScope: "uncommitted",
        discardable: true,
        fileTreeVisible: false,
      },
    });

    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: home.id });

    // Same tab, same slot, still active — only the FILE closed. The revert
    // also resets the direct-open collapsed tree back to the full-width blank.
    expect(slice().tabs[0]).toMatchObject({
      id: home.id,
      type: "files",
      fixed: true,
      title: "Open file",
      filePath: undefined,
      fileTreeVisible: true,
      diff: false,
      discardable: false,
    });
    expect(slice().activeId).toBe(home.id);
  });

  it("fills a blank File tab; closing the file reverts the home but removes extras", () => {
    freshScope();
    const home = slice().tabs.find((tab) => tab.type === "files")!;

    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: home.id,
      updates: { filePath: "src/a.ts", title: "a.ts" },
    });
    expect(slice().tabs.find((tab) => tab.id === home.id)).toMatchObject({
      filePath: "src/a.ts",
      title: "a.ts",
      // Selecting inside the blank tab keeps its full-width tree expanded;
      // only direct-open entry points explicitly publish `false`.
      fileTreeVisible: true,
    });

    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: home.id,
      updates: { filePath: undefined },
    });
    expect(slice().tabs.find((tab) => tab.id === home.id)).toMatchObject({
      title: "Open file",
      filePath: undefined,
      fileTreeVisible: true,
    });
    expect(slice().activeId).toBe(home.id);

    const extra = createFilesTab("src/b.ts");
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: extra });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: extra.id,
      updates: { filePath: undefined },
    });
    // Extras close entirely; the close-neighbor policy picks the next tab
    // (Context now sits between Review and the extra).
    expect(slice().tabs.some((tab) => tab.id === extra.id)).toBe(false);
    expect(slice().activeId).toBe(
      slice().tabs.find((tab) => tab.type === "context")!.id,
    );
  });

  it("updates a retained Browser in its original scope after a workspace switch", () => {
    const folderA = freshScope();
    const browserA = createBrowserTab({
      url: "https://a.example.com",
      title: "Workspace A",
    });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: browserA });

    const folderB = freshScope();
    const browserB = createBrowserTab({
      url: "https://b.example.com",
      title: "Workspace B",
    });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: browserB });

    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      scope: workbenchScopeForFolder(folderA),
      id: browserA.id,
      updates: { title: "Workspace A loaded" },
    });

    const state = useWorkspaceStore.getState();
    expect(
      state.workbenchByScope[workbenchScopeForFolder(folderA)].tabs.find(
        (tab) => tab.id === browserA.id,
      )?.title,
    ).toBe("Workspace A loaded");
    expect(slice().tabs.find((tab) => tab.id === browserB.id)?.title).toBe(
      "Workspace B",
    );
    expect(workbenchScopeForFolder(folderB)).not.toBe(
      workbenchScopeForFolder(folderA),
    );
  });

  it("ignores stale remove, update, and activation ids", () => {
    freshScope();
    const before = useWorkspaceStore.getState();
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: "missing" });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: "missing",
      updates: { title: "bad" },
    });
    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: "missing" });
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
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: first });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: duplicate });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: duplicate.id,
      updates: { title: "Updated docs" },
    });

    expect(slice().recentBrowsers).toHaveLength(1);
    expect(slice().recentBrowsers[0]).toMatchObject({
      url: "https://example.com/docs",
      title: "Updated docs",
    });

    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: first.id });
    dispatch({ type: "REMOVE_WORKBENCH_TAB", id: duplicate.id });
    expect(slice().tabs.some((tab) => tab.type === "browser")).toBe(false);
    expect(slice().recentBrowsers[0].title).toBe("Updated docs");
  });

  it("does not record blank or non-web Browser URLs", () => {
    freshScope();
    const browser = createBrowserTab();
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: browser });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: browser.id,
      updates: { url: "file:///tmp/index.html", title: "Local file" },
    });
    expect(slice().recentBrowsers).toEqual([]);
  });
});

describe("CLOSE_WORKBENCH_FILE_IF_MATCHES", () => {
  it("does not let a delayed close for file A clear a newer file B selection", () => {
    const folder = freshScope();
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: changes.id,
      updates: { filePath: "src/a.ts", diff: true, discardable: true },
    });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: changes.id,
      updates: { filePath: "src/b.ts", diff: true, discardable: true },
    });

    dispatch({
      type: "CLOSE_WORKBENCH_FILE_IF_MATCHES",
      scope: workbenchScopeForFolder(folder),
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
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: file });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: changes.id,
      updates: { filePath: "src/gone.ts", diff: true, discardable: true },
    });
    const close = (id: string) =>
      dispatch({
        type: "CLOSE_WORKBENCH_FILE_IF_MATCHES",
        scope: workbenchScopeForFolder(folder),
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

  it("reverts the fixed home instead of removing it when its file vanishes", () => {
    const folder = freshScope();
    const home = slice().tabs.find((tab) => tab.type === "files")!;
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: home.id,
      updates: { filePath: "src/gone.ts", fileTreeVisible: false },
    });

    dispatch({
      type: "CLOSE_WORKBENCH_FILE_IF_MATCHES",
      scope: workbenchScopeForFolder(folder),
      id: home.id,
      path: "src/gone.ts",
    });

    expect(slice().tabs[0]).toMatchObject({
      id: home.id,
      title: "Open file",
      filePath: undefined,
      fileTreeVisible: true,
    });
  });
});

describe("RECONCILE_WORKBENCH_FILE_DISCARD", () => {
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
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: file });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: historical });

    dispatch({
      type: "RECONCILE_WORKBENCH_FILE_DISCARD",
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

  it("closes every extra File tab for a removed path and clears Changes selection", () => {
    const folder = freshScope();
    const home = slice().tabs.find((tab) => tab.type === "files")!;
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    const first = createFilesTab("scratch.txt", { isNewFile: true });
    const second = createFilesTab("scratch.txt", { isNewFile: true });
    const neighbor = createFilesTab("keep.txt");
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: first });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: second });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: neighbor });
    dispatch({
      type: "UPDATE_WORKBENCH_TAB",
      id: changes.id,
      updates: {
        filePath: "scratch.txt",
        diff: true,
        discardable: true,
        isNewFile: true,
      },
    });
    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: second.id });

    dispatch({
      type: "RECONCILE_WORKBENCH_FILE_DISCARD",
      scope: folder,
      path: "scratch.txt",
      outcome: "removed",
    });

    expect(slice().tabs.some((tab) => tab.filePath === "scratch.txt")).toBe(
      false,
    );
    expect(slice().activeId).toBe(neighbor.id);
    // The untouched blank home is not a discard target and survives as-is.
    expect(slice().tabs[0]).toMatchObject({ id: home.id, filePath: undefined });
    expect(slice().tabs.find((tab) => tab.id === changes.id)).toMatchObject({
      filePath: undefined,
      diff: false,
      discardable: false,
      isNewFile: false,
    });
  });

  it("reverts the fixed home to Open file when its path is removed", () => {
    const folder = freshScope();
    const home = slice().tabs.find((tab) => tab.type === "files")!;
    dispatch({
      type: "OPEN_WORKBENCH_TAB",
      id: home.id,
      updates: {
        filePath: "scratch.txt",
        title: "scratch.txt",
        diff: true,
        discardable: true,
        isNewFile: true,
        fileTreeVisible: false,
      },
    });

    dispatch({
      type: "RECONCILE_WORKBENCH_FILE_DISCARD",
      scope: folder,
      path: "scratch.txt",
      outcome: "removed",
    });

    expect(slice().tabs[0]).toMatchObject({
      id: home.id,
      fixed: true,
      title: "Open file",
      filePath: undefined,
      fileTreeVisible: true,
      diff: false,
      isNewFile: false,
    });
    expect(slice().activeId).toBe(home.id);
  });

  it("targets the operation's workspace after the active workspace changes", () => {
    const folderA = freshScope();
    const fileA = createFilesTab("same.txt", { isNewFile: true });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: fileA });

    const folderB = freshScope();
    const fileB = createFilesTab("same.txt", { isNewFile: true });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: fileB });
    dispatch({
      type: "RECONCILE_WORKBENCH_FILE_DISCARD",
      scope: `${folderA}/`,
      path: "same.txt",
      outcome: "removed",
    });

    const state = useWorkspaceStore.getState();
    expect(
      state.workbenchByScope[workbenchScopeForFolder(folderA)].tabs.some(
        (tab) => tab.id === fileA.id,
      ),
    ).toBe(false);
    expect(
      state.workbenchByScope[workbenchScopeForFolder(folderB)].tabs.some(
        (tab) => tab.id === fileB.id,
      ),
    ).toBe(true);
  });
});

describe("REORDER_WORKBENCH_TABS", () => {
  it("keeps the fixed home first and Changes/Review immediately next", () => {
    freshScope();
    const first = createFilesTab("a.ts");
    const second = createFilesTab("b.ts");
    const browser = createBrowserTab();
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: first });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: second });
    dispatch({ type: "ADD_WORKBENCH_TAB", tab: browser });
    const changes = slice().tabs.find((tab) => tab.type === "changes")!;
    const review = slice().tabs.find((tab) => tab.type === "review")!;
    const initialBlank = slice().tabs.find(
      (tab) => tab.type === "files" && !tab.filePath,
    )!;

    dispatch({
      type: "REORDER_WORKBENCH_TABS",
      ids: [
        browser.id,
        second.id,
        review.id,
        first.id,
        changes.id,
        initialBlank.id,
      ],
    });

    // The fixed home owns the leading slot no matter where the caller put it;
    // the other closable tabs keep the requested relative order.
    const context = slice().tabs.find((tab) => tab.type === "context")!;
    expect(slice().tabs.map((tab) => tab.id)).toEqual([
      initialBlank.id,
      changes.id,
      review.id,
      context.id,
      browser.id,
      second.id,
      first.id,
    ]);
  });
});
