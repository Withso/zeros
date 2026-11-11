// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails, DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  editor: { props: null as null | { onCommitStyles: (styles: Record<string, string | null>) => Promise<void> } },
  applyEdit: vi.fn(async () => {}),
  updateStyles: vi.fn(async () => {}),
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
vi.mock("../design-style-editor", () => ({
  DesignStyleEditor: (props: { onCommitStyles: (styles: Record<string, string | null>) => Promise<void> }) => {
    mocks.editor.props = props;
    return null;
  },
}));
vi.mock("../state/design-workspace-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-cache")>()),
  applyDesignEditCached: mocks.applyEdit,
  updateDesignNodeStylesCached: mocks.updateStyles,
}));

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignInspector } from "../design-inspector";
import { resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";
import { resetDesignHeldStateForTests } from "../state/design-held-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const VERSION = "a".repeat(24);
const FRAME = { file: "home.html", sourceVersion: VERSION, x: 0, y: 0, z: 0, width: 400, height: 300 } as never;

// A frame root that hugs its content: a layout edit refits the frame.
const root: DesignRuntimeNodeDetails = {
  sourceVersion: VERSION, oid: "root", tag: "main", name: "Root", text: null, selector: '[data-oid="root"]',
  visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 400, height: 300 }, styles: { position: "static" },
  layout: { x: 0, y: 0, parentId: null, parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "static",
    isContainingBlock: true, widthValue: "fit-content", heightValue: "fit-content" } as never,
};

function runtime(measured: DesignRuntimeNodeDetails) {
  return {
    sourceVersion: VERSION,
    supports: () => false,
    previewGeometry: vi.fn(async () => ({ ...root, rect: { ...root.rect, width: 420 } })),
    previewStyles: vi.fn(async () => ({ ...root, rect: { ...root.rect, width: 420 } })),
    clearPreviewStyles: vi.fn(async () => root),
    getNodeDetails: vi.fn(async () => measured),
  };
}

let host: HTMLDivElement;
let reactRoot: Root | null = null;

function mount() {
  const snapshot = { sourceVersion: VERSION, revision: 1, tree: [], warnings: [], frame: root,
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", "home.html", snapshot, VERSION);
  act(() => {
    reactRoot = createRoot(host);
    reactRoot.render(
      React.createElement(TooltipProvider, null,
        React.createElement(DesignInspector, {
          workspaceId: "w", folder: "/repo", frame: FRAME, frameSelected: true, selectedNodeId: null, selectedNodeIds: [],
          details: root, lint: null, active: true, canvasBackground: "white", onCanvasBackgroundChange: () => {},
          motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {}, zoomActionsRef: { current: null },
        } as never)),
    );
  });
}

describe("a style commit that refits its frame", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    resetDesignRuntimeStoreForTests();
    resetDesignHeldStateForTests();
    mocks.applyEdit.mockClear();
    mocks.updateStyles.mockClear();
    mocks.editor.props = null;
  });
  afterEach(() => {
    act(() => reactRoot?.unmount());
    reactRoot = null;
    host.remove();
  });

  it("refits the frame from the root it measures after the preview", async () => {
    mocks.runtime.mockReturnValue(runtime({ ...root, rect: { ...root.rect, width: 420 } }));
    mount();
    await act(async () => { await mocks.editor.props!.onCommitStyles({ padding: "12px" }); });
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when that measurement comes back held (a hold began after the preview)", async () => {
    mocks.runtime.mockReturnValue(runtime({ ...root, heldState: "hover", rect: { ...root.rect, width: 900 } }));
    mount();
    await act(async () => { await mocks.editor.props!.onCommitStyles({ padding: "12px" }); });
    expect(mocks.applyEdit).not.toHaveBeenCalled();
    expect(mocks.updateStyles).not.toHaveBeenCalled();
    // The preview of a value never written goes too.
    expect((mocks.runtime.mock.results.at(-1)!.value as ReturnType<typeof runtime>).clearPreviewStyles).toHaveBeenCalled();
  });
});
