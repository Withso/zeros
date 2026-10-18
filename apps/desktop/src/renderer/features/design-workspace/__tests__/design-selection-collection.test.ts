import { beforeEach, describe, expect, it } from "vitest";
import {
  bindDesignWorkspacePages,
  captureDesignPageOwner,
  designWorkspaceView,
  isCurrentDesignPageOwner,
  normalizeDesignWorkspaceView,
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
} from "../state/design-workspace-ui";
import { designSelectionMutationTargets } from "../design-selected-targets";

const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

describe("canonical Design selection collection", () => {
  beforeEach(resetDesignWorkspaceUiForTests);

  it.each(["personal", "organization-local", cloud])("retains mixed frame/node targets and one primary in %s", workspaceId => {
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory(workspaceId, "directory");
    store.setSelection(workspaceId, "a.html", null, [], { frameSelected: true });
    store.setSelection(workspaceId, "b.html", "parent", ["parent", "child", "child"], { additive: true });
    expect(designWorkspaceView(workspaceId)).toMatchObject({
      selectedFrame: "b.html", selectedNodeId: "parent", selectedNodeIds: ["parent", "child"],
      selectedTargets: [{ frame: "b.html", nodeId: "parent" }, { frame: "b.html", nodeId: "child" }, { frame: "a.html" }],
    });
    store.setSelection(workspaceId, "b.html", "parent", [], { additive: true, toggle: true });
    expect(designWorkspaceView(workspaceId).selectedTargets).toEqual([{ frame: "b.html", nodeId: "child" }, { frame: "a.html" }]);
    expect(designWorkspaceView("unrelated").selectedFrame).toBeNull();
  });

  it("upgrades legacy node groups without dropping nested references", () => {
    expect(normalizeDesignWorkspaceView({ selectedFrame: "a.html", selectedNodeId: "parent", selectedNodeIds: ["parent", "child"] }).selectedTargets)
      .toEqual([{ frame: "a.html", nodeId: "parent" }, { frame: "a.html", nodeId: "child" }]);
  });

  it("restores groups by page and prunes deleted secondary frames", () => {
    const store = useDesignWorkspaceUiStore.getState();
    const pages = [
      { id: "one", title: "One", folder: "one", frameFiles: ["one/a.html", "one/b.html"] },
      { id: "two", title: "Two", folder: "two", frameFiles: ["two/a.html"] },
    ];
    bindDesignWorkspacePages("workspace", "directory", pages);
    store.setSelection("workspace", "one/a.html", "parent");
    store.setSelection("workspace", "one/b.html", null, [], { frameSelected: true, additive: true });
    const targets = designWorkspaceView("workspace").selectedTargets;
    store.setActivePage("workspace", "two", "directory");
    expect(designWorkspaceView("workspace").selectedTargets).toEqual([]);
    store.setActivePage("workspace", "one", "directory");
    expect(designWorkspaceView("workspace").selectedTargets).toEqual(targets);
    bindDesignWorkspacePages("workspace", "directory", [{ ...pages[0], frameFiles: ["one/b.html"] }, pages[1]]);
    expect(designWorkspaceView("workspace").selectedTargets).toEqual([{ frame: "one/b.html" }]);
  });

  it("retires an exact page owner even across an away-and-back transition", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory("workspace", "directory");
    store.setActivePage("workspace", "one", "directory");
    const owner = captureDesignPageOwner("workspace");
    store.setActivePage("workspace", "two", "directory");
    store.setActivePage("workspace", "one", "directory");
    expect(isCurrentDesignPageOwner(owner)).toBe(false);
  });

  it("projects mutations without discarding explicitly selected descendant references", () => {
    const targets = [{ frame: "a.html", nodeId: "parent" }, { frame: "a.html", nodeId: "child" }, { frame: "b.html" }, { frame: "b.html", nodeId: "nested" }];
    const node = { oid: "child", tag: "div", name: "Child", text: null, visible: true, children: [] };
    const projection = designSelectionMutationTargets(targets, new Map([["a.html", [{ ...node, oid: "parent", children: [node] }]]]));
    expect(projection).toEqual([{ frame: "a.html", nodeId: "parent" }, { frame: "b.html" }]);
    expect(targets).toHaveLength(4);
  });
});
