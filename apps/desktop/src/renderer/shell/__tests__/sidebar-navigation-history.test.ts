// Sidebar back/forward: one session history of the sidebar's destinations,
// recorded from the workspace store so every entry point counts, and replayed
// through the same actions the sidebar dispatches.
import { beforeEach, describe, expect, it } from "vitest";

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

import { setActiveOrganizationSelection } from "../../features/team/active-team";
import type { ChatThread, WorkspaceState } from "../../state/store";
import { useWorkspaceStore } from "../../state/workspace-store";
import type { WorkspaceNavigationTarget } from "../prefetch-workspace-surface";
import {
  getSidebarNavigationHistory,
  recordSidebarDestination,
  resetSidebarNavigationHistory,
  SIDEBAR_HISTORY_LIMIT,
  sidebarDestinationFor,
  sidebarHistoryTarget,
  stepSidebarHistory,
  type SidebarDestination,
  type SidebarHistory,
  type SidebarHistoryScope,
} from "../sidebar-navigation-history";

const ROOT = "/fixture/zeros";
const ATLANTA = "/fixture-workspaces/zeros/atlanta";
const BOSTON = "/fixture-workspaces/zeros/boston";
const CREATING = "/fixture-workspaces/zeros/creating";
const CLOUD =
  "cloud://4f9c2a6e-1b3d-4c5e-8f70-1a2b3c4d5e6f/9e8d7c6b-5a49-4382-b1a0-f9e8d7c6b5a4";

const HOME: SidebarDestination = { kind: "dashboard" };
const CUSTOMIZE: SidebarDestination = { kind: "customize" };
const workspace = (folder: string): SidebarDestination => ({
  kind: "workspace",
  folder,
});

const scope: SidebarHistoryScope = {
  projects: [{ id: "project-zeros", repoRoot: ROOT }],
  workspaces: [
    { id: "ws-atlanta", path: ATLANTA, repoRoot: ROOT, kind: "code" },
    { id: "ws-cloud", path: CLOUD, repoRoot: ROOT, kind: "code" },
  ],
  pendingCreates: [{ path: CREATING, repoRoot: ROOT, kind: "code" }],
};

function historyOf(
  entries: SidebarDestination[],
  index = entries.length - 1,
): SidebarHistory {
  return { entries, index };
}

const dispatch = (
  action: Parameters<
    ReturnType<typeof useWorkspaceStore.getState>["dispatch"]
  >[0],
) => useWorkspaceStore.getState().dispatch(action);

const opened: WorkspaceNavigationTarget[] = [];
const navigator = {
  dispatch,
  openWorkspace: (target: WorkspaceNavigationTarget) => {
    opened.push(target);
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: target.path,
      repoRoot: target.repoRoot,
      chatId: null,
      validationPending: target.validationPending,
    });
  },
};

function page(): string {
  const state = useWorkspaceStore.getState();
  return state.activePage === "workspace"
    ? `workspace:${state.newAgentFolder ?? state.lastWorkspaceFolder}`
    : state.activePage;
}

beforeEach(() => {
  opened.length = 0;
  dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
  resetSidebarNavigationHistory();
});

describe("sidebar destinations", () => {
  it("names one destination per sidebar page and leaves Settings out", () => {
    const base = useWorkspaceStore.getState();
    const at = (patch: Partial<WorkspaceState>) =>
      sidebarDestinationFor({ ...base, ...patch });

    expect(at({ activePage: "dashboard" })).toEqual(HOME);
    expect(at({ activePage: "customize" })).toEqual(CUSTOMIZE);
    expect(
      at({ activePage: "create", createWorkspaceProjectId: "project-zeros" }),
    ).toEqual({ kind: "create", projectId: "project-zeros" });
    expect(at({ activePage: "repo", activeRepoId: "project-zeros" })).toEqual({
      kind: "repo",
      projectId: "project-zeros",
    });
    expect(
      at({
        activePage: "workspace",
        activeChatId: null,
        newAgentFolder: CLOUD,
      }),
    ).toEqual(workspace(CLOUD));
    expect(at({ activePage: "settings" })).toBeNull();
    expect(
      at({
        activePage: "workspace",
        activeChatId: null,
        newAgentFolder: null,
        lastWorkspaceFolder: null,
      }),
    ).toBeNull();
  });
});

describe("sidebar history stack", () => {
  it("pushes a new destination, ignores a repeat, and drops forward entries", () => {
    let history = recordSidebarDestination(historyOf([]), HOME);
    history = recordSidebarDestination(history, CUSTOMIZE);
    expect(recordSidebarDestination(history, CUSTOMIZE)).toBe(history);

    history = recordSidebarDestination(
      { ...history, index: 0 },
      workspace(ATLANTA),
    );
    expect(history).toEqual(historyOf([HOME, workspace(ATLANTA)]));
  });

  it("keeps only the newest entries", () => {
    let history = historyOf([]);
    for (let index = 0; index < SIDEBAR_HISTORY_LIMIT + 5; index += 1) {
      history = recordSidebarDestination(
        history,
        workspace(`/fixture-workspaces/zeros/w${index}`),
      );
    }
    expect(history.entries).toHaveLength(SIDEBAR_HISTORY_LIMIT);
    expect(history.index).toBe(SIDEBAR_HISTORY_LIMIT - 1);
    expect(history.entries[0]).toEqual(
      workspace("/fixture-workspaces/zeros/w5"),
    );
  });
});

describe("sidebar history availability", () => {
  it("skips removed repositories, unlisted workspaces and repeats of the current page", () => {
    const gone = historyOf([
      HOME,
      { kind: "repo", projectId: "project-removed" },
      workspace(BOSTON),
      workspace(ATLANTA),
    ]);
    expect(sidebarHistoryTarget(gone, -1, scope)).toEqual({
      index: 0,
      route: { kind: "page", page: "dashboard" },
    });
    expect(sidebarHistoryTarget(gone, 1, scope)).toBeNull();

    const repeat = historyOf([CUSTOMIZE, workspace(BOSTON), CUSTOMIZE]);
    expect(sidebarHistoryTarget(repeat, -1, scope)).toBeNull();
  });

  it("reopens Local, cloud and in-flight workspaces by their listed identity", () => {
    const visited = historyOf(
      [workspace(ATLANTA), workspace(CLOUD), workspace(CREATING), HOME],
      1,
    );
    expect(sidebarHistoryTarget(visited, -1, scope)?.route).toEqual({
      kind: "workspace",
      workspace: scope.workspaces[0],
    });
    expect(
      sidebarHistoryTarget({ ...visited, index: 3 }, -1, scope)?.route,
    ).toEqual({
      kind: "workspace",
      workspace: {
        path: CREATING,
        repoRoot: ROOT,
        kind: "code",
        validationPending: true,
      },
    });
    expect(
      sidebarHistoryTarget({ ...visited, index: 0 }, 1, scope)?.route,
    ).toEqual({ kind: "workspace", workspace: scope.workspaces[1] });
  });

  it("skips entries that would reopen the workspace or Create already on screen", () => {
    const subdirectoryChat = historyOf([
      HOME,
      workspace(ATLANTA),
      workspace(`${ATLANTA}/packages/app`),
    ]);
    expect(sidebarHistoryTarget(subdirectoryChat, -1, scope)).toEqual({
      index: 0,
      route: { kind: "page", page: "dashboard" },
    });
    const removedRepository = historyOf([
      { kind: "create", projectId: "project-removed" },
      { kind: "create", projectId: null },
    ]);
    expect(sidebarHistoryTarget(removedRepository, -1, scope)).toBeNull();
  });

  it("keeps Create available after its repository is removed, without the stale target", () => {
    const history = historyOf([
      { kind: "create", projectId: "project-removed" },
      HOME,
    ]);
    expect(sidebarHistoryTarget(history, -1, scope)?.route).toEqual({
      kind: "create",
      projectId: null,
    });
    expect(
      sidebarHistoryTarget(
        historyOf([{ kind: "create", projectId: "project-zeros" }, HOME]),
        -1,
        scope,
      )?.route,
    ).toEqual({ kind: "create", projectId: "project-zeros" });
  });
});

describe("sidebar history recording", () => {
  it("records every sidebar destination however it was reached, but not Settings", () => {
    dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
    dispatch({ type: "OPEN_CREATE_PAGE", projectId: "project-zeros" });
    dispatch({ type: "OPEN_REPO_PAGE", projectId: "project-zeros" });
    navigator.openWorkspace({ path: ATLANTA, repoRoot: ROOT });
    dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
    navigator.openWorkspace({ path: ATLANTA, repoRoot: ROOT });

    expect(getSidebarNavigationHistory()).toEqual(
      historyOf([
        HOME,
        CUSTOMIZE,
        { kind: "create", projectId: "project-zeros" },
        { kind: "repo", projectId: "project-zeros" },
        workspace(ATLANTA),
      ]),
    );
  });

  it("treats chat tabs, repository hub tabs and unrelated updates as one destination", () => {
    const chats = ["chat-a", "chat-b"].map(
      (id) =>
        ({ id, folder: ATLANTA, archived: false }) as unknown as ChatThread,
    );
    useWorkspaceStore.setState({ chats });
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: ATLANTA,
      repoRoot: ROOT,
      chatId: "chat-a",
    });
    const recorded = getSidebarNavigationHistory();

    dispatch({ type: "SET_ACTIVE_CHAT", id: "chat-b" });
    dispatch({
      type: "SET_REPO_PAGE_VIEW",
      projectId: "project-zeros",
      view: "environment",
    });
    dispatch({ type: "SET_WORKSPACE_LIST_FILTER", filter: "ungrouped" });

    expect(getSidebarNavigationHistory()).toBe(recorded);
    expect(recorded).toEqual(historyOf([HOME, workspace(ATLANTA)]));
  });

  it("replays back and forward without recording them, and a new destination drops the forward entries", () => {
    dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
    navigator.openWorkspace({ path: ATLANTA, repoRoot: ROOT });

    expect(stepSidebarHistory(-1, scope, navigator)).toBe(true);
    expect(page()).toBe("customize");
    expect(stepSidebarHistory(-1, scope, navigator)).toBe(true);
    expect(page()).toBe("dashboard");
    expect(stepSidebarHistory(-1, scope, navigator)).toBe(false);
    expect(getSidebarNavigationHistory()).toEqual(
      historyOf([HOME, CUSTOMIZE, workspace(ATLANTA)], 0),
    );

    expect(stepSidebarHistory(1, scope, navigator)).toBe(true);
    expect(stepSidebarHistory(1, scope, navigator)).toBe(true);
    expect(page()).toBe(`workspace:${ATLANTA}`);
    expect(opened.at(-1)).toBe(scope.workspaces[0]);
    expect(stepSidebarHistory(1, scope, navigator)).toBe(false);

    expect(stepSidebarHistory(-1, scope, navigator)).toBe(true);
    dispatch({ type: "OPEN_CREATE_PAGE", projectId: null });
    expect(getSidebarNavigationHistory()).toEqual(
      historyOf([HOME, CUSTOMIZE, { kind: "create", projectId: null }]),
    );
    expect(stepSidebarHistory(1, scope, navigator)).toBe(false);
  });

  it("returns to an in-flight create as a pending validation target", () => {
    navigator.openWorkspace({ path: CREATING, repoRoot: ROOT });
    dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
    opened.length = 0;

    expect(stepSidebarHistory(-1, scope, navigator)).toBe(true);
    expect(opened).toEqual([
      { path: CREATING, repoRoot: ROOT, kind: "code", validationPending: true },
    ]);
    expect(useWorkspaceStore.getState().pendingWorkspaceValidationFolder).toBe(
      CREATING,
    );
    expect(getSidebarNavigationHistory().index).toBe(1);
  });

  it("restarts from the current destination", () => {
    dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
    resetSidebarNavigationHistory();
    expect(getSidebarNavigationHistory()).toEqual(historyOf([CUSTOMIZE]));
  });

  it("restarts when another organization becomes active, from any switcher", () => {
    dispatch({ type: "SET_ACTIVE_PAGE", page: "customize" });
    navigator.openWorkspace({ path: ATLANTA, repoRoot: ROOT });
    try {
      setActiveOrganizationSelection("org-other", false);
      expect(getSidebarNavigationHistory()).toEqual(
        historyOf([workspace(ATLANTA)]),
      );
      dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });

      // Re-selecting it, or learning only whether it is Personal, keeps it.
      setActiveOrganizationSelection("org-other", false);
      setActiveOrganizationSelection("org-other", true);
      expect(getSidebarNavigationHistory()).toEqual(
        historyOf([workspace(ATLANTA), HOME]),
      );

      // Settings is not a destination, so its switcher leaves nothing behind.
      dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
      setActiveOrganizationSelection(null, null);
      expect(getSidebarNavigationHistory()).toEqual(historyOf([]));
      dispatch({ type: "SET_ACTIVE_PAGE", page: "dashboard" });
      expect(getSidebarNavigationHistory()).toEqual(historyOf([HOME]));
    } finally {
      setActiveOrganizationSelection(null, null);
    }
  });
});
