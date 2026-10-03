import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerDesignFrame } from "../composer-design-frame";
import type { DesignFrameAttachmentTarget } from "../design-frame-attachment";

const mocks = vi.hoisted(() => ({
  project: { repoSlug: "project" },
  workspaces: [{ id: "workspace", path: "/work/project", placement: "local" }],
  useWorkspaces: vi.fn(),
  peekWorkspaces: vi.fn(),
}));
vi.mock("../../../state/use-projects", () => ({
  useProjectForFolder: (cwd: string | null) => (cwd ? mocks.project : null),
  useWorkspacesFor: mocks.useWorkspaces,
  peekWorkspacesFor: mocks.peekWorkspaces,
}));
vi.mock("../../design-workspace/state/design-workspace-cache", () => ({
  designWorkspaceSnapshotCache: { peekSnapshot: () => ({}) },
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
});
