import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnInfo } from "@/renderer/platform/turns";
import { useWorkspaceStore } from "@/renderer/state/store";
import * as workspaces from "@/renderer/state/use-projects";
import { getChangesFilter, resetChangesFilterForTests } from "../tabs/changes-filter-store";
import { changesSnapshotKey, readChangesSections } from "../tabs/changes-snapshot-cache";
import { resetWorkbenchEditorDirtyForTests, setWorkbenchEditorDirty } from "../tabs/code-editor/editor-state";
import * as fileData from "../../workspace-file-data-cache";
import { createChangesTab, createFilesTab } from "../tab-model";
import { openTurnChanges, warmTurnChanges } from "../open-turn-changes";

const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const initial = useWorkspaceStore.getState();
afterEach(() => {
  useWorkspaceStore.setState(initial, true);
  resetChangesFilterForTests(); resetWorkbenchEditorDirtyForTests(); vi.restoreAllMocks();
});

function setup(folder: string) {
  const workspaceId = folder === cloud ? cloud : `workspace:${folder}`;
  const chatId = folder === cloud ? "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat" : folder;
  const turn: TurnInfo = { chatId, turnId: "opening", workspaceId, folder, agentId: "codex", ord: 1, summary: "Change files",
    startedAt: 1, endedAt: 2, status: "completed", stopReason: "end_turn", preSnapshot: "before", postSnapshot: "after",
    files: [{ path: "src/file.ts", status: "modified", additions: 3, deletions: 2 }] };
  const changes = { ...createChangesTab(), filePath: "old.ts", diffScope: "commit" as const, diffSha: "old-commit", changesRequestedFile: "old.ts" };
  const file = createFilesTab("other.ts");
  vi.spyOn(workspaces, "peekLiveWorkspaceUnion").mockReturnValue([{ id: workspaceId, path: folder, baseBranch: "main" }] as never);
  useWorkspaceStore.setState({ activeChatId: null, activePage: "workspace", newAgentFolder: folder,
    workbenchByScope: { [folder]: { tabs: [changes, file], activeId: file.id, recentBrowsers: [] } } });
  return { turn, changes, file };
}

describe("Review turn changes", () => {
  it.each(["/personal/project", "/organization/project", cloud])("opens a clicked footer file in its exact turn in %s", folder => {
    const { turn, changes, file } = setup(folder);
    turn.files.push({ path: "src/deleted.ts", status: "deleted", additions: 0, deletions: 4 });
    openTurnChanges(turn, "src/deleted.ts");
    const current = useWorkspaceStore.getState().workbenchByScope[folder];
    expect(current.activeId).toBe(changes.id);
    expect(current.tabs.find(tab => tab.id === changes.id)).toMatchObject({
      filePath: "src/deleted.ts", changesPresentation: "single", diffScope: "history",
      diffHistory: { kind: "turn-range", from: { chatId: turn.chatId, turnId: turn.turnId }, to: { chatId: turn.chatId, turnId: turn.turnId } },
    });
    expect(current.tabs.find(tab => tab.id === file.id)).toBe(file);
    expect(current.tabs.filter(tab => tab.type === "files")).toHaveLength(1);
  });

  it("does not navigate a footer file that is not owned by the recorded turn", () => {
    const { turn } = setup("/personal/project");
    const before = useWorkspaceStore.getState();
    openTurnChanges(turn, "../other.ts");
    expect(useWorkspaceStore.getState()).toBe(before);
  });

  it.each(["/personal/project", "/organization/project", cloud])("opens the complete exact-turn destination synchronously in %s", folder => {
    const { turn, changes, file } = setup(folder);
    const snapshots: unknown[] = [];
    const unsub = useWorkspaceStore.subscribe(state => snapshots.push(state.workbenchByScope[folder]));
    openTurnChanges(turn); unsub();
    expect(snapshots).toHaveLength(1);
    const current = useWorkspaceStore.getState().workbenchByScope[folder];
    expect(current.activeId).toBe(changes.id);
    const history = { kind: "turn-range", from: { chatId: turn.chatId, turnId: turn.turnId }, to: { chatId: turn.chatId, turnId: turn.turnId } };
    expect(current.tabs.find(tab => tab.id === changes.id)).toMatchObject({ filePath: "src/file.ts", diff: true, diffScope: "history",
      diffHistory: history, diffSha: undefined, changesRequestedFile: undefined });
    expect(getChangesFilter(turn.workspaceId!).scope).toEqual(history);
    expect(readChangesSections(changesSnapshotKey(turn.workspaceId!, history as never, "main"))?.[0].files).toMatchObject(turn.files);
    expect(current.tabs.find(tab => tab.id === file.id)).toBe(file);
  });

  it("keeps a historical callback in its own workspace after an owner switch", () => {
    const { turn } = setup("/personal/project");
    const other = createChangesTab();
    const scope = { tabs: [other], activeId: other.id, recentBrowsers: [] };
    useWorkspaceStore.setState(state => ({ newAgentFolder: cloud, workbenchByScope: { ...state.workbenchByScope, [cloud]: scope } }));
    openTurnChanges(turn);
    expect(useWorkspaceStore.getState().newAgentFolder).toBe(cloud);
    expect(useWorkspaceStore.getState().workbenchByScope[cloud]).toBe(scope);
    expect(getChangesFilter(cloud).scope).not.toMatchObject({ kind: "turn-range" });
    useWorkspaceStore.setState({ newAgentFolder: turn.folder });
    expect(useWorkspaceStore.getState().workbenchByScope[turn.folder!].activeId).toMatch(/^changes-/);
  });

  it("retains a legacy unsaved Changes draft while selecting the turn's file list", () => {
    const { turn, changes } = setup("/personal/project");
    setWorkbenchEditorDirty(changes.id, true);
    openTurnChanges(turn);
    expect(useWorkspaceStore.getState().workbenchByScope[turn.folder!].tabs[0]).toBe(changes);
    expect(getChangesFilter(turn.workspaceId!).scope.kind).toBe("turn-range");
  });

  it("warms Local review on intent without waking a cloud VM", () => {
    const warm = vi.spyOn(fileData, "prefetchWorkspaceFileDiff").mockImplementation(() => {});
    const { turn } = setup("/personal/project");
    warmTurnChanges(turn);
    expect(warm).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: turn.workspaceId, path: "src/file.ts", diffScope: "history" }));
    warm.mockClear();
    warmTurnChanges({ ...turn, folder: cloud, workspaceId: cloud });
    expect(warm).not.toHaveBeenCalled();
  });
});
