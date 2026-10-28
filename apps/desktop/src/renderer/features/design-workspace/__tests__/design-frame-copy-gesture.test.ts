import { beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { startDesignFrameCopy } from "../design-frame-copy-gesture";
import type { beginDesignPointerGesture } from "../design-pointer-gesture";

const mocks = vi.hoisted(() => ({
  gesture: null as Parameters<typeof beginDesignPointerGesture>[0] | null,
  wait: vi.fn(), duplicate: vi.fn(), transfer: vi.fn(), select: vi.fn(), resume: vi.fn(),
  presentation: { hasPixels: true, paint: vi.fn(), remove: vi.fn(), handoff: vi.fn(async () => {}), adopt: vi.fn() },
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: () => null, waitForDesignFrameRuntime: mocks.wait }));
vi.mock("../design-pointer-gesture", () => ({ beginDesignPointerGesture: (input: Parameters<typeof beginDesignPointerGesture>[0]) => {
  mocks.gesture = input;
  return input.onCancel;
} }));
vi.mock("../design-drag-presentation", () => ({ createDesignDragPresentation: () => mocks.presentation }));
vi.mock("../design-layout-transfer", () => ({ designCanvasFrameAt: () => undefined, transferDesignLayerOnCanvas: mocks.transfer }));
vi.mock("../state/design-workspace-cache", () => ({
  designWorkspaceSnapshotCache: { peekSnapshot: () => ({ data: { frames: [] } }) }, duplicateDesignFrameCached: mocks.duplicate,
}));
vi.mock("../state/design-workspace-ui", () => ({
  captureDesignPageOwner: () => ({ workspaceId: "local", pageId: "page", revision: 1 }),
  designWorkspaceView: () => ({ selectionEvent: 1 }), isCurrentDesignPageOwner: () => true,
}));
vi.mock("../state/design-runtime-store", () => ({ designRuntimeFrameState: () => undefined }));
vi.mock("../state/design-selection", () => ({ selectDesignFrame: mocks.select }));
vi.mock("../state/design-background-work", () => ({ designBackgroundWork: { pause: () => mocks.resume } }));

const frame = { file: "page/home.html", frameId: "home", pageId: "page", title: "Home", x: 10, y: 20, width: 100, height: 80,
  z: 0, nodeCount: 1, modifiedAt: 1, sourceVersion: "a".repeat(24) };
function start() {
  const article = {} as HTMLElement;
  const event = { currentTarget: { closest: () => article }, clientX: 15, clientY: 25, pointerId: 1,
    preventDefault() {}, stopPropagation() {} } as unknown as React.PointerEvent<HTMLElement>;
  const input = { event, workspaceId: "local", folder: "/local", frame,
    point: ({ clientX, clientY }: { clientX: number; clientY: number }) => ({ x: clientX, y: clientY }),
    current: () => true, nest: vi.fn(), finished: vi.fn(), saving: vi.fn(), failed: vi.fn() };
  const cancel = startDesignFrameCopy(input);
  return { input, cancel };
}
beforeEach(() => { vi.clearAllMocks(); mocks.gesture = null; });

describe("canvas frame Option copy", () => {
  it("keeps an Option-click free of editor readiness and capture work", () => {
    mocks.wait.mockResolvedValue(null);
    const { cancel } = start();
    cancel();
    expect(mocks.wait).not.toHaveBeenCalled();
    expect(mocks.duplicate).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledOnce();
  });

  it("copies at release without waiting for a live editor over empty canvas", async () => {
    let release!: () => void;
    mocks.wait.mockReturnValue(new Promise(resolve => { release = () => resolve(null); }));
    mocks.duplicate.mockResolvedValue({ frame: { file: "copy.html" }, snapshot: { frames: [] } });
    const { input } = start();
    mocks.gesture!.onMove({ clientX: 65, clientY: 75 } as PointerEvent);
    mocks.gesture!.onFinish();
    try {
      await vi.waitFor(() => expect(mocks.duplicate).toHaveBeenCalledExactlyOnceWith("local", frame.file, "page", {
        sourceVersion: frame.sourceVersion, geometry: { x: 60, y: 70, w: 100, h: 80, z: 1 },
      }));
      await input.saving.mock.calls[0]?.[0];
      expect(mocks.wait).not.toHaveBeenCalled();
      expect(input.failed).not.toHaveBeenCalled();
    } finally { release?.(); }
  });
});
