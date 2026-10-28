import { afterEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "@/renderer/state/store";
import { openFileGroup } from "../file-group-navigation";
import { normalizeFileGroup } from "../file-group";
import { normalizeWorkbenchTabs } from "../tab-model";

const original = useWorkspaceStore.getState();
afterEach(() => useWorkspaceStore.setState(original, true));
const group = {
  id: "group-1",
  name: "Clip frames",
  files: [
    {
      name: "frame.jpg",
      path: ".context/attachments/a/frame.jpg",
      attachmentId: "att-a",
    },
    {
      name: "timeline.txt",
      path: ".context/attachments/b/timeline.txt",
      attachmentId: "att-b",
    },
  ],
};

describe("file group navigation", () => {
  it("keeps selection, files and group identity isolated across Local and cloud scopes", () => {
    const owners = [
      "/personal",
      "/organization",
      "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
    ];
    useWorkspaceStore.setState({ workbenchByScope: {} });
    for (const owner of owners) {
      openFileGroup(owner, group);
      const scope = useWorkspaceStore.getState().workbenchByScope[owner];
      const tab = scope.tabs.find((tab) => tab.id === scope.activeId)!;
      expect(tab).toMatchObject({
        type: "files",
        title: group.name,
        fileGroup: group,
        filePath: group.files[0].path,
      });
      useWorkspaceStore
        .getState()
        .dispatch({
          type: "UPDATE_WORKBENCH_TAB",
          id: tab.id,
          scope: owner,
          updates: {
            filePath: group.files[1].path,
            fileGroup: group,
            title: group.name,
          },
        });
    }
    for (const owner of owners) {
      openFileGroup(owner, group);
      const scope = useWorkspaceStore.getState().workbenchByScope[owner];
      const tabs = scope.tabs.filter((tab) => tab.fileGroup);
      expect(tabs).toHaveLength(1);
      expect(tabs[0].filePath).toBe(group.files[1].path);
      const restored = normalizeWorkbenchTabs(
        JSON.parse(JSON.stringify(scope.tabs)),
      );
      expect(restored.find((tab) => tab.id === scope.activeId)).toMatchObject({
        fileGroup: group,
        filePath: group.files[1].path,
        title: group.name,
      });
    }
  });

  it("rejects unsafe paths and oversized persisted groups without opening a tab", () => {
    const before = useWorkspaceStore.getState().workbenchByScope;
    for (const path of [
      "../secret",
      "/elsewhere/file",
      "https://example.test/file",
      "x\\file",
      "x\0file",
    ]) {
      const invalid = { ...group, files: [{ name: "file", path }] };
      expect(normalizeFileGroup(invalid)).toBeUndefined();
      openFileGroup("/personal", invalid);
      expect(useWorkspaceStore.getState().workbenchByScope).toBe(before);
    }
    expect(
      normalizeFileGroup({ ...group, files: Array(1001).fill(group.files[0]) }),
    ).toBeUndefined();
  });

  it("ordinary file navigation leaves a group and cannot keep its old members", () => {
    openFileGroup("/personal", group);
    const scope = useWorkspaceStore.getState().workbenchByScope["/personal"];
    useWorkspaceStore
      .getState()
      .dispatch({
        type: "UPDATE_WORKBENCH_TAB",
        scope: "/personal",
        id: scope.activeId!,
        updates: { filePath: "README.md" },
      });
    const tab = useWorkspaceStore
      .getState()
      .workbenchByScope[
        "/personal"
      ].tabs.find((tab) => tab.id === scope.activeId)!;
    expect(tab.fileGroup).toBeUndefined();
    expect(tab.title).toBe("README.md");
  });
});
