import { afterEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "../workspace-store";
import {
  createChangesTab,
  createFilesTab,
} from "../../shell/workbench/tab-model";

const initial = useWorkspaceStore.getState();
afterEach(() => useWorkspaceStore.setState(initial, true));
const cloud =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

describe("requested Changes file fallback", () => {
  function setup(scope: string) {
    const path = "packages/app/.context/notes.md";
    const filePath = ".context/notes.md";
    const changes = {
      ...createChangesTab(),
      filePath: path,
      diff: true,
      changesRequestedFile: path,
    };
    const existing = {
      ...createFilesTab(filePath),
      diff: true,
      diffScope: "commit" as const,
      diffSha: "old",
      viewerMode: "diff" as const,
      contentRevision: 4,
    };
    const other = createFilesTab("unsaved.ts");
    useWorkspaceStore.setState({
      activeChatId: null,
      activePage: "workspace",
      newAgentFolder: scope,
      workbenchByScope: {
        [scope]: {
          tabs: [changes, existing, other],
          activeId: changes.id,
          recentBrowsers: [],
        },
      },
    });
    return {
      changes,
      existing,
      other,
      action: {
        type: "OPEN_REQUESTED_CHANGES_FILE" as const,
        scope,
        id: changes.id,
        path,
        filePath,
      },
    };
  }

  it.each([
    "/personal/project/packages/app",
    "/organization/project/packages/app",
    `${cloud}/packages/app`,
  ])(
    "opens the same source and consumes its request atomically in %s",
    (scope) => {
      const { changes, existing, other, action } = setup(scope);
      const snapshots: unknown[] = [];
      const unsubscribe = useWorkspaceStore.subscribe((state) =>
        snapshots.push(state.workbenchByScope[scope]),
      );
      useWorkspaceStore.getState().dispatch(action);
      unsubscribe();
      expect(snapshots).toHaveLength(1);
      const current = useWorkspaceStore.getState().workbenchByScope[scope];
      expect(current.activeId).toBe(existing.id);
      expect(current.tabs.find((tab) => tab.id === existing.id)).toMatchObject({
        filePath: ".context/notes.md",
        diff: false,
        diffSha: undefined,
        viewerMode: undefined,
        contentRevision: 4,
      });
      expect(
        current.tabs.find((tab) => tab.id === changes.id)?.changesRequestedFile,
      ).toBeUndefined();
      expect(current.tabs.find((tab) => tab.id === other.id)).toBe(other);
      useWorkspaceStore
        .getState()
        .dispatch({ type: "ACTIVATE_WORKBENCH_TAB", scope, id: changes.id });
      const returned = useWorkspaceStore.getState();
      useWorkspaceStore.getState().dispatch(action);
      expect(useWorkspaceStore.getState()).toBe(returned);
    },
  );

  it.each(["workspace", "tab", "file", "request"])(
    "ignores a late fallback after changing the %s",
    (changed) => {
      const scope = "/personal/project";
      const { changes, other, action } = setup(scope);
      const dispatch = useWorkspaceStore.getState().dispatch;
      if (changed === "workspace")
        dispatch({ type: "SET_NEW_AGENT_FOLDER", folder: cloud });
      if (changed === "tab")
        dispatch({ type: "ACTIVATE_WORKBENCH_TAB", scope, id: other.id });
      if (changed === "file")
        dispatch({
          type: "UPDATE_WORKBENCH_TAB",
          scope,
          id: changes.id,
          updates: { filePath: "new.ts" },
        });
      if (changed === "request")
        dispatch({
          type: "UPDATE_WORKBENCH_TAB",
          scope,
          id: changes.id,
          updates: { changesRequestedFile: undefined },
        });
      const before = useWorkspaceStore.getState();
      dispatch(action);
      expect(useWorkspaceStore.getState()).toBe(before);
    },
  );
});
