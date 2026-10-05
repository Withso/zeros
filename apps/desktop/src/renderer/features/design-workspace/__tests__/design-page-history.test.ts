import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignApiMutationReplyWire } from "../../../platform/git";
const selectFrame = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../state/design-selection", () => ({
  selectDesignFrame: selectFrame,
}));
import { restoreDesignPageHistorySelection } from "../state/design-page-history";
import {
  bindDesignWorkspacePages,
  captureDesignPageOwner,
  designWorkspaceView,
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
} from "../state/design-workspace-ui";

const pages = [
  { id: "a", title: "A", folder: "a", frameFiles: ["a/home.html"] },
  { id: "b", title: "B", folder: "b", frameFiles: ["b/home.html"] },
];
const restored = { file: "b/home.html", pageId: "b", title: "Home" };
const reply = {
  historyFrame: "b/home.html",
  historySelection: "b/home.html",
  snapshot: { directoryId: "directory", pages, frames: [restored] },
} as unknown as DesignApiMutationReplyWire;
describe("Design history page ownership", () => {
  beforeEach(() => {
    resetDesignWorkspaceUiForTests();
    selectFrame.mockClear();
    bindDesignWorkspacePages("workspace", "directory", pages);
  });
  it("switches to an affected page before restoring frame selection", async () => {
    await restoreDesignPageHistorySelection(
      "workspace",
      captureDesignPageOwner("workspace"),
      reply,
      "undo",
    );
    expect(designWorkspaceView("workspace").activePageId).toBe("b");
    expect(selectFrame).toHaveBeenCalledWith(
      "workspace",
      restored,
      expect.objectContaining({
        selected: true,
        owner: expect.objectContaining({ pageId: "b" }),
      }),
    );
  });
  it("can reveal the page of a deleted frame that is absent from rendered frames", async () => {
    await restoreDesignPageHistorySelection(
      "workspace",
      captureDesignPageOwner("workspace"),
      {
        ...reply,
        historySelection: null,
        snapshot: { ...reply.snapshot!, frames: [] },
      },
      "redo",
    );
    expect(designWorkspaceView("workspace").activePageId).toBe("b");
    expect(selectFrame).toHaveBeenCalledWith(
      "workspace",
      null,
      expect.anything(),
    );
  });
  it("reveals the affected frame when semantic history switches to another page", async () => {
    await restoreDesignPageHistorySelection(
      "workspace",
      captureDesignPageOwner("workspace"),
      { ...reply, historySelection: undefined },
      "undo",
    );
    expect(selectFrame).toHaveBeenCalledWith(
      "workspace",
      restored,
      expect.objectContaining({ selected: true }),
    );
  });
  it("does not switch or select after the user leaves the submitting page", async () => {
    const owner = captureDesignPageOwner("workspace");
    useDesignWorkspaceUiStore
      .getState()
      .setActivePage("workspace", "b", "directory");
    const current = designWorkspaceView("workspace");
    await restoreDesignPageHistorySelection("workspace", owner, reply, "undo");
    expect(designWorkspaceView("workspace")).toBe(current);
    expect(selectFrame).not.toHaveBeenCalled();
  });
  it("ignores a reply from a replacement directory", async () => {
    await restoreDesignPageHistorySelection(
      "workspace",
      captureDesignPageOwner("workspace"),
      {
        ...reply,
        snapshot: { ...reply.snapshot!, directoryId: "replacement" },
      },
      "undo",
    );
    expect(designWorkspaceView("workspace").activePageId).toBe("a");
    expect(selectFrame).not.toHaveBeenCalled();
  });
});
