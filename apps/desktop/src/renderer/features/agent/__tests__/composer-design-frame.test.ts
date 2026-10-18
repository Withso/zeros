import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDesignFrame } from "../composer-design-frame";
import type { DesignFrameAttachmentTarget } from "../design-frame-attachment";
import { designWorkspaceView, resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore } from "../../design-workspace/state/design-workspace-ui";

const mocks = vi.hoisted(() => ({
  project: { repoSlug: "project" },
  workspaces: [{ id: "workspace", path: "/work/project", placement: "local" }],
  useWorkspaces: vi.fn(),
  peekWorkspaces: vi.fn(),
  snapshot: undefined as any,
}));
vi.mock("../../../state/use-projects", () => ({
  useProjectForFolder: (cwd: string | null) => (cwd ? mocks.project : null),
  useWorkspacesFor: mocks.useWorkspaces,
  peekWorkspacesFor: mocks.peekWorkspaces,
}));
vi.mock("../../design-workspace/state/design-workspace-cache", () => ({
  designWorkspaceSnapshotCache: { peekSnapshot: () => ({ data: mocks.snapshot }) },
}));

function readContext(options: Parameters<typeof useComposerDesignFrame>[0]) {
  let context: ReturnType<typeof useComposerDesignFrame> | undefined;
  function Probe() {
    context = useComposerDesignFrame(options);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return context!;
}

const target: DesignFrameAttachmentTarget = {
  workspaceId: "workspace",
  directoryId: "design_directory",
  frame: "phone.html",
  frameId: "frame_phone",
  revision: "a".repeat(24),
  intent: "code",
  includeScreenshot: true,
};
const options = {
  chatId: "chat",
  cwd: "/work/project/app",
  active: false,
  intent: "code" as const,
  onPin: vi.fn(),
};

describe("parked composer frame ownership", () => {
  beforeEach(() => {
    resetDesignWorkspaceUiForTests();
    mocks.snapshot = undefined;
    mocks.useWorkspaces.mockReset().mockImplementation((slug) => ({
      workspaces: slug ? mocks.workspaces : [],
    }));
    mocks.peekWorkspaces.mockReset().mockReturnValue(mocks.workspaces);
  });

  it("delivers the pinned frame and image while a queued send drains offscreen", () => {
    const context = readContext({ ...options, initialFrame: target });
    expect(context.selection).toBeNull();
    expect(context.capture()).toEqual(target);
    expect(context.capture()).not.toBe(target);
    expect(mocks.useWorkspaces).toHaveBeenCalledWith(null);
  });

  it.each([
    { workspaces: undefined },
    { workspaces: [] },
    {
      workspaces: [
        { id: "replacement", path: "/work/project", placement: "local" },
      ],
    },
    {
      workspaces: [
        { id: "workspace", path: "/work/project", placement: "cloud" },
      ],
    },
  ])(
    "rejects a parked frame if its workspace is missing or replaced",
    ({ workspaces }) => {
      const context = readContext({ ...options, initialFrame: target });
      // Validate against the current owner even if it changes after render.
      mocks.peekWorkspaces.mockReturnValue(workspaces);
      expect(() => context.capture()).toThrow(
        "The attached frame belongs to another workspace.",
      );
    },
  );

  it("keeps an explicitly removed frame absent during an offscreen retry", () => {
    expect(
      readContext({ ...options, initialFrame: null }).capture(),
    ).toBeNull();
  });

  it("does not acquire fresh canvas selection while hidden", () => {
    expect(readContext(options).capture()).toBeNull();
    expect(mocks.peekWorkspaces).not.toHaveBeenCalled();
  });

  it("captures all current targets and keeps the submitted group frozen", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory("workspace", "design_directory");
    store.setSelection("workspace", "phone.html", "parent", ["parent", "child"]);
    const context = readContext({ ...options, active: true });
    const submitted = context.capture();
    expect(submitted).toEqual([expect.objectContaining({ frame: "phone.html", nodeId: "parent" }), expect.objectContaining({ frame: "phone.html", nodeId: "child" })]);
    context.pin(submitted);
    store.setSelection("workspace", "tablet.html", null, [], { frameSelected: true });
    expect(context.capture()).toEqual(submitted);
    context.consume(submitted);
    expect(designWorkspaceView("workspace").selectedTargets).toEqual([{ frame: "tablet.html" }]);
  });

  it("removes the linked selection and permits the next same-target click", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory("workspace", "design_directory");
    store.setSelection("workspace", "phone.html", null, [], { frameSelected: true });
    const captured = readContext({ ...options, active: true }).capture();
    const context = readContext({ ...options, active: true, initialFrame: captured });
    context.remove();
    expect(context.capture()).toBeNull();
    expect(designWorkspaceView("workspace").selectedTargets).toEqual([]);
    store.setSelection("workspace", "phone.html", null, [], { frameSelected: true });
    expect(context.capture()).toMatchObject({ frame: "phone.html" });
  });

  it("rejects a deleted target at send instead of attaching another frame", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory("workspace", "design_directory");
    store.setSelection("workspace", "phone.html", null, [], { frameSelected: true });
    const context = readContext({ ...options, active: true });
    mocks.snapshot = { directoryId: "design_directory", frames: [] };
    expect(() => context.capture()).toThrow(/removed/);
  });

  it("does not reattach another live selection after sending a dismissed draft", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory("workspace", "design_directory");
    store.setSelection("workspace", "tablet.html", null, [], { frameSelected: true });
    const context = readContext({ ...options, active: true, initialFrame: target });
    context.remove();
    context.consume(null);
    expect(context.capture()).toBeNull();
    expect(designWorkspaceView("workspace").selectedTargets).toEqual([{ frame: "tablet.html" }]);
  });

  it.each([
    { id: "personal", path: "/work/project", placement: "local", organizationId: null },
    { id: "organization-local", path: "/work/project", placement: "local", organizationId: "organization" },
    { id: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", path: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", placement: "cloud", organizationId: "11111111-1111-4111-8111-111111111111" },
  ])("round-trips grouped drafts for $id and rejects replacement owners", workspace => {
    mocks.useWorkspaces.mockReturnValue({ workspaces: [workspace] });
    mocks.peekWorkspaces.mockReturnValue([workspace]);
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory(workspace.id, "design_directory");
    store.setSelection(workspace.id, "phone.html", "parent", ["parent", "child"]);
    const args = { ...options, cwd: workspace.path, active: true };
    const captured = readContext(args).capture();
    const draft = JSON.parse(JSON.stringify({ designFrame: captured }));
    const restored = readContext({ ...args, active: false, initialFrame: draft.designFrame });
    expect(restored.capture()).toEqual(draft.designFrame);
    expect(restored.selection).toBeNull();
    mocks.peekWorkspaces.mockReturnValue([{ ...workspace, organizationId: "replacement" }]);
    expect(() => restored.capture()).toThrow(/another workspace/);
  });

  it("does not clear a newer explicit same-identity selection when a send finishes", () => {
    const store = useDesignWorkspaceUiStore.getState();
    store.bindDirectory("workspace", "design_directory");
    store.setSelection("workspace", "phone.html", null, [], { frameSelected: true });
    const context = readContext({ ...options, active: true });
    const submitted = context.capture();
    store.setSelection("workspace", "phone.html", null, [], { frameSelected: true });
    context.consume(submitted);
    expect(designWorkspaceView("workspace").selectedTargets).toEqual([{ frame: "phone.html" }]);
  });
});
