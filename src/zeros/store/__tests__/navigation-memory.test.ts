// Scoped navigation regression coverage: repository and workspace round trips
// must restore their own destination and publish it in one Zustand notification.
import { describe, expect, it } from "vitest";

const stubStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => stubStore.get(key) ?? null,
  setItem: (key: string, value: string) => void stubStore.set(key, value),
  removeItem: (key: string) => void stubStore.delete(key),
  clear: () => stubStore.clear(),
};
(globalThis as Record<string, unknown>).window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener: () => {},
  localStorage: globalThis.localStorage,
};

import {
  selectLastWorkspaceFolderForRepo,
  selectRepoPageView,
  useWorkspaceStore,
} from "../workspace-store";
import type { ChatThread } from "../store";

let sequence = 0;
function identities() {
  sequence += 1;
  return {
    projectA: `project-a-${sequence}`,
    projectB: `project-b-${sequence}`,
    rootA: `/repo-a-${sequence}`,
    rootB: `/repo-b-${sequence}`,
  };
}

describe("scoped navigation memory", () => {
  it("restores each repository's own last workspace after A → B → A", () => {
    const { rootA, rootB } = identities();
    const worktreeA = `${rootA}/worktree-one`;
    const worktreeB = `${rootB}/worktree-two`;
    const { dispatch } = useWorkspaceStore.getState();

    dispatch({
      type: "OPEN_WORKSPACE",
      folder: worktreeA,
      repoRoot: rootA,
      chatId: null,
    });
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: worktreeB,
      repoRoot: rootB,
      chatId: null,
    });

    const state = useWorkspaceStore.getState();
    expect(selectLastWorkspaceFolderForRepo(state, rootA)).toBe(worktreeA);
    expect(selectLastWorkspaceFolderForRepo(state, rootB)).toBe(worktreeB);
    expect(selectLastWorkspaceFolderForRepo(state, "/never-opened")).toBe(
      "/never-opened",
    );
  });

  it("keeps repository hub tabs isolated and restores them on route open", () => {
    const { projectA, projectB } = identities();
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "OPEN_REPO_PAGE", projectId: projectA, view: "git" });
    dispatch({
      type: "OPEN_REPO_PAGE",
      projectId: projectB,
      view: "environment",
    });
    dispatch({ type: "OPEN_REPO_PAGE", projectId: projectA });

    const state = useWorkspaceStore.getState();
    expect(state.activePage).toBe("repo");
    expect(state.activeRepoId).toBe(projectA);
    expect(selectRepoPageView(state, projectA)).toBe("git");
    expect(selectRepoPageView(state, projectB)).toBe("environment");
  });

  it("returns from a workspace to Home's complete previous destination", () => {
    const { projectA, rootA } = identities();
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "OPEN_REPO_PAGE", projectId: projectA, view: "paths" });
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: rootA,
      repoRoot: rootA,
      chatId: null,
    });
    dispatch({ type: "OPEN_HOME" });

    expect(useWorkspaceStore.getState()).toMatchObject({
      activePage: "repo",
      activeRepoId: projectA,
      lastHomePage: "repo",
    });
    expect(selectRepoPageView(useWorkspaceStore.getState(), projectA)).toBe(
      "paths",
    );
  });

  it("publishes repo route + identity + explicit view in one notification", () => {
    const { projectA } = identities();
    const snapshots: Array<[string, string | null, string]> = [];
    const stop = useWorkspaceStore.subscribe((state) => {
      snapshots.push([
        state.activePage,
        state.activeRepoId,
        selectRepoPageView(state, projectA),
      ]);
    });

    useWorkspaceStore.getState().dispatch({
      type: "OPEN_REPO_PAGE",
      projectId: projectA,
      view: "actions",
    });
    stop();

    expect(snapshots).toEqual([["repo", projectA, "actions"]]);
  });

  it("publishes a newly-created workspace route and chat atomically", () => {
    const { rootA } = identities();
    const folder = `${rootA}/new-worktree`;
    const chat = { id: `new-chat-${sequence}`, folder } as ChatThread;
    const snapshots: Array<[string, string | null, string | null]> = [];
    const stop = useWorkspaceStore.subscribe((state) => {
      snapshots.push([
        state.activePage,
        state.activeChatId,
        state.lastWorkspaceByRepoRoot[rootA] ?? null,
      ]);
    });

    useWorkspaceStore.getState().dispatch({
      type: "ADD_CHAT",
      chat,
      openWorkspace: { repoRoot: rootA },
    });
    stop();

    expect(snapshots).toEqual([["workspace", chat.id, folder]]);
  });

  it("repoints the active workspace without leaving a Home page (preservePage)", () => {
    // Regression: archiving the active workspace FROM the Dashboard used to yank
    // the user into the workspace view. The archive repoint now dispatches
    // OPEN_WORKSPACE with `preservePage`, fixing the underlying target (→ Local
    // main) while keeping whatever full-window page is showing.
    const { rootA } = identities();
    const worktree = `${rootA}/archived-worktree`;
    const { dispatch } = useWorkspaceStore.getState();

    // Open the workspace we're about to archive, then walk over to the Dashboard.
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: worktree,
      repoRoot: rootA,
      chatId: null,
    });
    dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
    expect(useWorkspaceStore.getState().activePage).toBe("dashboard");

    // The archive repoint: move the active target to Local main, stay put.
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: rootA,
      repoRoot: rootA,
      chatId: null,
      preservePage: true,
    });

    const state = useWorkspaceStore.getState();
    expect(state.activePage).toBe("dashboard"); // stayed on the Dashboard
    expect(state.lastWorkspaceFolder).toBe(rootA); // but repointed off the worktree
    expect(state.newAgentFolder).toBe(rootA);
  });

  it("a normal OPEN_WORKSPACE (no preservePage) still opens the workspace view", () => {
    const { rootA } = identities();
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: rootA,
      repoRoot: rootA,
      chatId: null,
    });
    expect(useWorkspaceStore.getState().activePage).toBe("workspace");
  });

  it("confirms only the still-active cold workspace target", () => {
    const { rootA, rootB } = identities();
    const folderA = `${rootA}/cold-worktree`;
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: folderA,
      repoRoot: rootA,
      chatId: null,
      validationPending: true,
    });
    expect(useWorkspaceStore.getState().pendingWorkspaceValidationFolder).toBe(
      folderA,
    );

    dispatch({ type: "CONFIRM_WORKSPACE_TARGET", folder: `${rootB}/stale` });
    expect(useWorkspaceStore.getState().pendingWorkspaceValidationFolder).toBe(
      folderA,
    );

    dispatch({ type: "CONFIRM_WORKSPACE_TARGET", folder: folderA });
    expect(
      useWorkspaceStore.getState().pendingWorkspaceValidationFolder,
    ).toBeNull();
  });

  it("prunes removed repo memories and leaves no dead repo route", () => {
    const { projectA, rootA } = identities();
    const workspaceRoot = `${rootA}/worktree`;
    const folder = `${workspaceRoot}/packages/app`;
    const chat = {
      id: `removed-chat-${sequence}`,
      folder,
    } as ChatThread;
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "OPEN_REPO_PAGE", projectId: projectA, view: "git" });
    dispatch({
      type: "OPEN_WORKSPACE",
      folder,
      repoRoot: rootA,
      chatId: null,
    });
    dispatch({ type: "ADD_CHAT", chat });
    dispatch({
      type: "ADD_COLUMN3_TAB",
      tab: {
        id: `removed-file-${sequence}`,
        type: "files",
        title: "removed.ts",
        filePath: "removed.ts",
      },
    });
    dispatch({ type: "OPEN_REPO_PAGE", projectId: projectA });

    dispatch({
      type: "REMOVE_REPO_UI_STATE",
      projectId: projectA,
      repoRoot: rootA,
      workspaceFolders: [workspaceRoot],
    });

    const state = useWorkspaceStore.getState();
    expect(state.activePage).toBe("dashboard");
    expect(state.activeRepoId).toBeNull();
    expect(state.activeChatId).toBeNull();
    expect(state.lastHomePage).toBe("dashboard");
    expect(state.repoPageViewByProject[projectA]).toBeUndefined();
    expect(state.lastWorkspaceByRepoRoot[rootA]).toBeUndefined();
    expect(state.activeChatByFolder[folder]).toBeUndefined();
    expect(state.column3ByScope[folder]).toBeUndefined();
  });

  it("prunes a deleted workspace while keeping its repository on main", () => {
    const { rootA } = identities();
    const workspaceRoot = `${rootA}/deleted-worktree`;
    const folder = `${workspaceRoot}/packages/app`;
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({
      type: "OPEN_WORKSPACE",
      folder,
      repoRoot: rootA,
      chatId: null,
    });
    dispatch({ type: "RESET_COLUMN3_TABS" });
    dispatch({
      type: "REMOVE_WORKSPACE_UI_STATE",
      folder: workspaceRoot,
      repoRoot: rootA,
    });

    const state = useWorkspaceStore.getState();
    expect(state.lastWorkspaceByRepoRoot[rootA]).toBe(rootA);
    expect(state.activeChatByFolder[folder]).toBeUndefined();
    expect(state.column3ByScope[folder]).toBeUndefined();
    expect(state.lastWorkspaceFolder).toBe(rootA);
  });

  it("moves restored workspace chats and folder-keyed navigation atomically", () => {
    const { rootA } = identities();
    const fromFolder = `${rootA}/archived-worktree`;
    const fromSubdir = `${fromFolder}/packages/app`;
    const toFolder = `${fromFolder}-2`;
    const toSubdir = `${toFolder}/packages/app`;
    const chat = {
      id: `moved-chat-${sequence}`,
      folder: fromSubdir,
    } as ChatThread;
    const snapshots: Array<[string | undefined, string | undefined]> = [];
    const { dispatch } = useWorkspaceStore.getState();
    dispatch({ type: "ADD_CHAT", chat });
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: fromSubdir,
      repoRoot: rootA,
      chatId: chat.id,
    });
    dispatch({ type: "RESET_COLUMN3_TABS" });
    const stop = useWorkspaceStore.subscribe((state) => {
      snapshots.push([
        state.chats.find((entry) => entry.id === chat.id)?.folder,
        state.lastWorkspaceByRepoRoot[rootA],
      ]);
    });

    dispatch({
      type: "MOVE_WORKSPACE_UI_STATE",
      fromFolder,
      toFolder,
      repoRoot: rootA,
    });
    stop();

    const state = useWorkspaceStore.getState();
    expect(snapshots).toEqual([[toSubdir, toSubdir]]);
    expect(state.lastWorkspaceFolder).toBe(toSubdir);
    expect(
      state.chats.find((entry) => entry.id === chat.id)?.folder,
    ).toBe(toSubdir);
    expect(state.activeChatByFolder[fromSubdir]).toBeUndefined();
    expect(state.activeChatByFolder[toSubdir]).toBe(chat.id);
    expect(state.column3ByScope[fromSubdir]).toBeUndefined();
    expect(state.column3ByScope[toSubdir]).toBeDefined();
  });

  it("preserves UI state owned by a registered repository nested in a deleted workspace", () => {
    const { projectA, rootA } = identities();
    const workspaceRoot = `${rootA}/deleted-worktree`;
    const outerFolder = `${workspaceRoot}/packages/app`;
    const nestedRoot = `${workspaceRoot}/nested-repo`;
    const nestedFolder = `${nestedRoot}/packages/app`;
    const nestedProjectId = `nested-project-${sequence}`;
    const projects = [
      {
        id: projectA,
        name: "Outer",
        repoRoot: rootA,
        repoSlug: `outer-${sequence}`,
        originUrl: null,
        addedAt: sequence,
      },
      {
        id: nestedProjectId,
        name: "Nested",
        repoRoot: nestedRoot,
        repoSlug: `nested-${sequence}`,
        originUrl: null,
        addedAt: sequence,
      },
    ];
    stubStore.set("zeros-projects-v1", JSON.stringify(projects));
    stubStore.set("zeros-projects-v1-backup", JSON.stringify(projects));

    try {
      const nestedChat = {
        id: `nested-chat-${sequence}`,
        folder: nestedFolder,
      } as ChatThread;
      const outerChat = {
        id: `outer-chat-${sequence}`,
        folder: outerFolder,
      } as ChatThread;
      const { dispatch } = useWorkspaceStore.getState();

      dispatch({ type: "ADD_CHAT", chat: nestedChat });
      dispatch({
        type: "OPEN_WORKSPACE",
        folder: nestedFolder,
        repoRoot: nestedRoot,
        chatId: nestedChat.id,
      });
      dispatch({ type: "RESET_COLUMN3_TABS" });

      dispatch({ type: "ADD_CHAT", chat: outerChat });
      dispatch({
        type: "OPEN_WORKSPACE",
        folder: outerFolder,
        repoRoot: rootA,
        chatId: outerChat.id,
      });
      dispatch({ type: "RESET_COLUMN3_TABS" });

      dispatch({
        type: "REMOVE_WORKSPACE_UI_STATE",
        folder: workspaceRoot,
        repoRoot: rootA,
      });

      const state = useWorkspaceStore.getState();
      expect(state.activeChatByFolder[outerFolder]).toBeUndefined();
      expect(state.column3ByScope[outerFolder]).toBeUndefined();
      expect(state.activeChatByFolder[nestedFolder]).toBe(nestedChat.id);
      expect(state.column3ByScope[nestedFolder]).toBeDefined();
      expect(state.lastWorkspaceByRepoRoot[nestedRoot]).toBe(nestedFolder);
    } finally {
      stubStore.delete("zeros-projects-v1");
      stubStore.delete("zeros-projects-v1-backup");
    }
  });
});
