import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  bindDesignWorkspacePages,
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
  designWorkspaceView,
} from "../state/design-workspace-ui";

const mocks = vi.hoisted(() => {
  const state = {
    transfer: vi.fn(),
    selectNode: vi.fn(),
    selectFrame: vi.fn(),
    targets: [] as unknown[],
    destinationDetails: undefined as unknown,
    waitForRuntime: vi.fn(),
    runtimeFor: vi.fn(),
    runtime: null as unknown,
    confirmedFrames: [] as unknown[],
    preparation: undefined as import("../../../platform/git").DesignWorkspaceSnapshotWire["preparation"],
    directoryId: "directory-one",
    listeners: new Set<() => void>(),
  };
  state.runtime = {
    sourceVersion: "a".repeat(24),
    supports: () => true,
    getLayoutTargets: async () => state.targets,
    getNodeDetails: async () => state.destinationDetails,
  };
  return state;
});
vi.mock("../state/design-workspace-cache", () => ({
  transferDesignNodeCached: mocks.transfer,
  designWorkspaceSnapshotCache: {
    peekSnapshot: () => ({ data: { frames: mocks.confirmedFrames, preparation: mocks.preparation, directoryId: mocks.directoryId } }),
    subscribe: (_workspaceId: string, listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));
vi.mock("../state/design-selection", () => ({
  selectDesignNode: mocks.selectNode,
  selectDesignFrame: mocks.selectFrame,
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: (_workspaceId: string, file: string) => mocks.runtimeFor(file),
  waitForDesignFrameRuntime: mocks.waitForRuntime,
}));
vi.mock("../design-layout-drag", () => ({
  designLayoutDrop: () => ({
    parentId: "target-root",
    beforeId: null,
    styles: {},
  }),
}));
import {
  transferDesignLayerAtRelease,
  transferDesignLayerOnCanvas,
  designCanvasFrameAt,
  designCanvasDropTargetFrame,
} from "../design-layout-transfer";

const source = {
  file: "source.html",
  sourceVersion: "a".repeat(24),
  title: "Source",
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  z: 0,
  modifiedAt: 1,
  nodeCount: 5,
};
const destination = { ...source, file: "destination.html", x: 1000 };
const confirmed = { ...destination, sourceVersion: "b".repeat(24) };
const node = {
  oid: "child",
  rect: { x: 0, y: 0, width: 100, height: 80 },
} as DesignRuntimeNodeDetails;
const input = {
  workspaceId: "workspace-a",
  folder: "/design/a",
  frame: source,
  frames: [source, destination],
  details: node,
  origin: { x: 1100, y: 100 },
  detach: true,
};
const reply = {
  frame: destination.file,
  nodeId: node.oid,
  snapshot: { frames: [source, confirmed] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.targets = [];
  mocks.destinationDetails = undefined;
  mocks.confirmedFrames = [];
  mocks.preparation = undefined;
  mocks.directoryId = "directory-one";
  mocks.listeners.clear();
  mocks.runtimeFor.mockImplementation(() => mocks.runtime);
  mocks.waitForRuntime.mockResolvedValue(null);
  resetDesignWorkspaceUiForTests();
  useDesignWorkspaceUiStore
    .getState()
    .setSelection(input.workspaceId, source.file, node.oid);
  // The cache publishes the follow-selection just before the snapshot.
  mocks.transfer.mockImplementation(async (_workspaceId: string, _input: unknown, _isCurrent: unknown, beforePublish?: (result: typeof reply) => void) => {
    beforePublish?.(reply);
    return reply;
  });
});
afterEach(() => vi.useRealTimers());

describe("canvas transfer presentation", () => {
  it("sends the measured affine appearance instead of the legacy flattening request", async () => {
    await transferDesignLayerOnCanvas({
      ...input,
      frames: [source],
      origin: { x: 700.25, y: 400.5 },
      details: {
        ...node,
        sourceVersion: source.sourceVersion,
        rect: { x: 40, y: 80, width: 240, height: 280 },
        box: {
          x: 40,
          y: 80,
          width: 100,
          height: 80,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          originX: 0.5,
          originY: 0.5,
        },
        borderCoordinateSpace: [0, 2, -3, 1, 280, 80],
        relocationContext: {
          inheritedStyles: { color: "navy" },
          unsupported: [],
        },
      },
    });
    expect(mocks.transfer.mock.calls[0]?.[1]).toMatchObject({
      sourceVersion: source.sourceVersion,
      x: 700.25,
      y: 400.5,
      relocation: {
        width: 100,
        height: 80,
        matrix: [0, 2, -3, 1, 240, 0],
        inheritedStyles: { color: "navy" },
      },
    });
  });

  it("refuses unsupported measured appearance before a transfer write", async () => {
    await expect(
      transferDesignLayerOnCanvas({
        ...input,
        frames: [source],
        details: {
          ...node,
          sourceVersion: source.sourceVersion,
          relocationContext: {
            inheritedStyles: {},
            unsupported: ["ancestor compositing"],
          },
        },
      }),
    ).rejects.toThrow(/measured|compositing/);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it.each(["workspace-a", "cloud://org-a/workspace-a"])("does not follow a fresh identical selection while saving in %s", async (workspaceId) => {
    useDesignWorkspaceUiStore.getState().setSelection(workspaceId, source.file, node.oid);
    let finish!: (value: typeof reply) => void;
    mocks.transfer.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const result = transferDesignLayerOnCanvas({ ...input, workspaceId });
    await vi.waitFor(() => expect(mocks.transfer).toHaveBeenCalledOnce());
    useDesignWorkspaceUiStore.getState().setSelection(workspaceId, source.file, node.oid);
    finish(reply);
    await expect(result).resolves.toBe(true);
    expect(designWorkspaceView(workspaceId).selectedFrame).toBe(source.file);
    expect(mocks.selectNode).not.toHaveBeenCalled();
  });

  it("does not inspect a destination reselected while presentation was pending", async () => {
    let present!: () => void;
    const shown = vi.fn(() => new Promise<void>((resolve) => { present = resolve; }));
    const result = transferDesignLayerOnCanvas({ ...input, presented: shown });
    await vi.waitFor(() => expect(shown).toHaveBeenCalledOnce());
    useDesignWorkspaceUiStore.getState().setSelection(input.workspaceId, destination.file, node.oid);
    present();
    await result;
    expect(mocks.selectNode).not.toHaveBeenCalled();
  });
  it.each([
    { lowerZ: 1, upperZ: 2, upperWidth: 600 },
    { lowerZ: 1, upperZ: 2, upperWidth: 800 },
    { lowerZ: 2, upperZ: 2, upperWidth: 600 },
  ])(
    "transfers into the visible overlapping frame ($lowerZ/$upperZ, $upperWidth px)",
    async ({ lowerZ, upperZ, upperWidth }) => {
      const lower = { ...destination, file: "lower.html", z: lowerZ };
      const upper = {
        ...destination,
        file: "upper.html",
        z: upperZ,
        width: upperWidth,
      };
      mocks.transfer.mockResolvedValue({
        frame: upper.file,
        nodeId: node.oid,
        snapshot: { frames: [source, lower, upper] },
      });

      await expect(
        transferDesignLayerOnCanvas({
          ...input,
          frames: [source, lower, upper],
        }),
      ).resolves.toBe(true);
      expect(mocks.transfer.mock.calls[0]?.[1]).toMatchObject({
        destinationFrame: upper.file,
      });
    },
  );

  it("waits for the destination generation before inspecting its newly inserted layer", async () => {
    let reveal!: () => void;
    const presented = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          reveal = resolve;
        }),
    );
    const result = transferDesignLayerOnCanvas({ ...input, presented });
    await vi.waitFor(() => expect(presented).toHaveBeenCalledOnce());
    expect(mocks.selectNode).not.toHaveBeenCalled();
    expect(designWorkspaceView(input.workspaceId).selectedFrame).toBe(
      destination.file,
    );
    reveal();
    await expect(result).resolves.toBe(true);
    expect(mocks.selectNode).toHaveBeenCalledWith(
      expect.objectContaining({ frame: confirmed, nodeId: node.oid }),
    );
  });

  it("does not steal a selection made while a transfer is saving", async () => {
    let finish!: (value: typeof reply) => void;
    mocks.transfer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = transferDesignLayerOnCanvas(input);
    await vi.waitFor(() => expect(mocks.transfer).toHaveBeenCalledOnce());
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(input.workspaceId, "other.html", "other-node");
    finish(reply);
    await expect(result).resolves.toBe(true);
    expect(mocks.selectNode).not.toHaveBeenCalled();
    expect(designWorkspaceView(input.workspaceId).selectedFrame).toBe(
      "other.html",
    );
  });
});

describe("design-tool nesting", () => {
  const measured = {
    ...node,
    sourceVersion: source.sourceVersion,
    rect: { x: 40, y: 80, width: 100, height: 80 },
    box: { x: 40, y: 80, width: 100, height: 80, rotation: 0, scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5 },
    borderCoordinateSpace: [1, 0, 0, 1, 40, 80],
    relocationContext: { inheritedStyles: { color: "navy" }, baseStyles: { "font-family": "Georgia" }, unsupported: [] },
  } as DesignRuntimeNodeDetails;

  const prepareDestination = () => {
    const description = (frame: typeof source) => ({
      file: frame.file, title: frame.title, x: frame.x, y: frame.y,
      width: frame.width, height: frame.height, z: frame.z,
      preparation: "unprepared" as const,
    });
    mocks.confirmedFrames = [source];
    mocks.preparation = { revision: "catalog", epoch: 1,
      descriptions: [description(source), description(destination)], current: [source.file], errors: {} };
  };

  it("warms a described drop destination and waits for its prepared generation without detaching", async () => {
    prepareDestination();
    const nest = vi.fn();
    const result = transferDesignLayerAtRelease({ ...input, pointer: { x: 1100, y: 100 }, nest });
    await Promise.resolve();
    expect(nest).toHaveBeenCalledWith(destination.file);
    expect(mocks.transfer).not.toHaveBeenCalled();
    mocks.confirmedFrames = [source, destination];
    mocks.preparation = { ...mocks.preparation!, current: [source.file, destination.file] };
    for (const listener of mocks.listeners) listener();
    await expect(result).resolves.toBe(true);
    expect(mocks.transfer.mock.calls[0]?.[1]).toMatchObject({ destinationFrame: destination.file });
    expect(mocks.listeners.size).toBe(0);
    expect(nest).toHaveBeenLastCalledWith(null);
  });

  it("refuses an unprepared destination even when a stale runtime remains registered", async () => {
    vi.useFakeTimers();
    prepareDestination();
    const result = transferDesignLayerAtRelease({ ...input, pointer: { x: 1100, y: 100 } });
    const assertion = expect(result).rejects.toThrow(/still loading/);
    await vi.advanceTimersByTimeAsync(2001);
    await assertion;
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(mocks.listeners.size).toBe(0);
  });

  it("refuses a prepared destination whose runtime still measures an older source", async () => {
    mocks.confirmedFrames = [source, confirmed];
    await expect(transferDesignLayerAtRelease({ ...input, pointer: { x: 1100, y: 100 } })).rejects.toThrow(/still loading/);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("discovers destinations only on the source frame's page", () => {
    const frames = [
      { ...source, pageId: "current" },
      { ...destination, pageId: "current" },
      { ...destination, file: "other-page.html", pageId: "other", z: 10 },
    ];
    expect(designCanvasFrameAt(source.file, frames, { x: 1100, y: 100 })?.file).toBe(destination.file);
    expect(designCanvasDropTargetFrame(source.file, frames, { x: 1100, y: 100, width: 100, height: 80 })?.file).toBe(destination.file);
  });

  it("refuses a destination invalidated while its layout measurement is pending", async () => {
    prepareDestination();
    mocks.confirmedFrames = [source, destination];
    mocks.preparation = { ...mocks.preparation!, current: [source.file, destination.file] };
    const runtime = { ...(mocks.runtime as object), getLayoutTargets: async () => {
      mocks.preparation = { ...mocks.preparation!, epoch: 2, current: [source.file] };
      return [];
    } };
    mocks.runtimeFor.mockReturnValue(runtime);
    await expect(transferDesignLayerAtRelease({ ...input, pointer: { x: 1100, y: 100 } })).rejects.toThrow(/still loading/);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it.each(["retired", "reprepared", "directory"])("refuses %s destination authority even when its retained bytes match", async (change) => {
    prepareDestination();
    mocks.confirmedFrames = [source, destination];
    mocks.preparation = { ...mocks.preparation!, current: [source.file, destination.file] };
    const runtime = { ...(mocks.runtime as object), getLayoutTargets: async () => {
      if (change === "retired") mocks.preparation = undefined;
      else if (change === "reprepared") mocks.preparation = { ...mocks.preparation!, epoch: 2 };
      else mocks.directoryId = "directory-two";
      return [];
    } };
    mocks.runtimeFor.mockReturnValue(runtime);
    await expect(transferDesignLayerAtRelease({ ...input, pointer: { x: 1100, y: 100 } })).rejects.toThrow(/still loading/);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("joins the frame under the pointer, not the one the layer's centre covers", async () => {
    const left = { ...destination, file: "left.html", x: 1000, width: 300 };
    const right = { ...destination, file: "right.html", x: 1400, width: 300 };
    mocks.transfer.mockResolvedValue({ frame: right.file, nodeId: node.oid, snapshot: { frames: [source, left, right] } });
    await transferDesignLayerOnCanvas({ ...input, frames: [source, left, right], origin: { x: 1100, y: 100 }, pointer: { x: 1500, y: 150 } });
    expect(mocks.transfer.mock.calls[0]?.[1]).toMatchObject({ destinationFrame: right.file });
  });

  it("makes a static destination parent positioned instead of refusing the move", async () => {
    mocks.targets = [{ oid: "target-root", tag: "section", styles: { position: "static" }, childCoordinateSpace: [1, 0, 0, 1, 0, 0] }];
    // The destination's body has the same font: only the layer's own color travels.
    mocks.destinationDetails = { relocationContext: { inheritedStyles: {}, baseStyles: { "font-family": "Georgia" }, unsupported: [] } };
    await transferDesignLayerOnCanvas({ ...input, details: measured });
    expect(mocks.transfer.mock.calls[0]?.[1]).toMatchObject({
      destinationFrame: destination.file,
      parentStyles: { position: "relative" },
      relocation: { inheritedStyles: { color: "navy" } },
    });
    expect(mocks.transfer.mock.calls[0]?.[1].relocation.inheritedStyles).not.toHaveProperty("font-family");
  });

  it("carries the source base where the destination frame's base differs", async () => {
    mocks.targets = [{ oid: "target-root", tag: "main", styles: { position: "relative" }, childCoordinateSpace: [1, 0, 0, 1, 0, 0] }];
    mocks.destinationDetails = { relocationContext: { inheritedStyles: {}, baseStyles: { "font-family": "Inter" }, unsupported: [] } };
    await transferDesignLayerOnCanvas({ ...input, details: measured });
    expect(mocks.transfer.mock.calls[0]?.[1].relocation.inheritedStyles).toEqual({ color: "navy", "font-family": "Georgia" });
    expect(mocks.transfer.mock.calls[0]?.[1]).not.toHaveProperty("parentStyles");
  });

  it("carries a base value the drop parent itself overrides, not only its frame's body", async () => {
    // The destination's body is Georgia too, but the card the layer drops
    // into sets Inter; the layer keeps the Georgia it shows now.
    mocks.targets = [{ oid: "target-root", tag: "main", styles: { position: "relative" }, childCoordinateSpace: [1, 0, 0, 1, 0, 0] }];
    mocks.destinationDetails = { relocationContext: { inheritedStyles: { "font-family": "Inter" }, baseStyles: { "font-family": "Georgia" }, unsupported: [] } };
    await transferDesignLayerOnCanvas({ ...input, details: measured });
    expect(mocks.transfer.mock.calls[0]?.[1].relocation.inheritedStyles).toEqual({ color: "navy", "font-family": "Georgia" });
  });

  it("moves a whole body-rooted frame at its own size with its body background", async () => {
    mocks.targets = [{ oid: "target-root", tag: "main", styles: { position: "relative" }, childCoordinateSpace: [1, 0, 0, 1, 0, 0] }];
    mocks.destinationDetails = { relocationContext: { inheritedStyles: {}, baseStyles: { "font-family": "Georgia", color: "black" }, unsupported: [] } };
    const body = {
      oid: "::zeros-document-body",
      sourceVersion: source.sourceVersion,
      rect: { x: 0, y: 0, width: 600, height: 900 },
      styles: { backgroundColor: "snow" },
      relocationContext: { inheritedStyles: { "font-family": "Georgia", color: "dimgray" }, baseStyles: {}, unsupported: [] },
    } as unknown as DesignRuntimeNodeDetails;
    await transferDesignLayerOnCanvas({ ...input, detach: false, details: body, origin: { x: 1040, y: 60 }, destination, pointer: { x: 1100, y: 100 } });
    const sent = mocks.transfer.mock.calls[0]?.[1];
    expect(sent).toMatchObject({
      nodeId: "::zeros-document-body",
      destinationFrame: destination.file,
      frameBackground: "snow",
      relocation: { width: 600, height: 400, matrix: [1, 0, 0, 1, 40, 60], inheritedStyles: { color: "dimgray" } },
    });
    expect(sent.relocation.inheritedStyles).not.toHaveProperty("font-family");
  });

  it("selects the nested frame before its source leaves the page, so the canvas never jumps to the first frame", async () => {
    mocks.targets = [{ oid: "target-root", tag: "main", styles: { position: "relative" }, childCoordinateSpace: [1, 0, 0, 1, 0, 0] }];
    mocks.destinationDetails = { relocationContext: { inheritedStyles: {}, baseStyles: {}, unsupported: [] } };
    const body = {
      oid: "::zeros-document-body",
      sourceVersion: source.sourceVersion,
      rect: { x: 0, y: 0, width: 600, height: 400 },
      styles: {},
      relocationContext: { inheritedStyles: {}, baseStyles: {}, unsupported: [] },
    } as unknown as DesignRuntimeNodeDetails;
    const page = { id: "page", title: "Page", folder: "", frameFiles: ["first.html", source.file, destination.file] };
    bindDesignWorkspacePages(input.workspaceId, mocks.directoryId, [page]);
    useDesignWorkspaceUiStore.getState().setSelection(input.workspaceId, source.file, null, undefined, { frameSelected: true });
    const nested = { frame: destination.file, nodeId: "frame-1234abcd", snapshot: { frames: [confirmed] } };
    // The page binding observes the published snapshot (a layout effect)
    // before the transfer's own continuation resumes.
    mocks.transfer.mockImplementationOnce(async (_workspaceId: string, _input: unknown, _isCurrent: unknown, beforePublish?: (result: typeof nested) => void) => {
      beforePublish?.(nested);
      bindDesignWorkspacePages(input.workspaceId, mocks.directoryId, [{ ...page, frameFiles: ["first.html", destination.file] }]);
      return nested;
    });
    await expect(transferDesignLayerOnCanvas({ ...input, detach: false, details: body, origin: { x: 1040, y: 60 }, destination, pointer: { x: 1100, y: 100 } })).resolves.toBe(true);
    expect(designWorkspaceView(input.workspaceId)).toMatchObject({ selectedFrame: destination.file, selectedNodeId: "frame-1234abcd" });
    expect(mocks.selectNode).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "frame-1234abcd" }));
  });

  it("releases a layer into the frame under the pointer among the frames confirmed at release", async () => {
    // The gesture began when another frame sat under this point; that frame
    // has since moved away and `destination` moved in.
    const moved = { ...destination, file: "moved.html", x: 4000 };
    mocks.confirmedFrames = [source, moved, destination];
    mocks.targets = [{ oid: "target-root", tag: "main", styles: { position: "relative" }, childCoordinateSpace: [1, 0, 0, 1, 0, 0] }];
    const nest = vi.fn();
    mocks.transfer.mockImplementation(async () => {
      expect(nest).toHaveBeenLastCalledWith(destination.file);
      return reply;
    });
    await expect(
      transferDesignLayerAtRelease({ ...input, details: measured, pointer: { x: 1100, y: 100 }, nest }),
    ).resolves.toBe(true);
    expect(mocks.transfer.mock.calls[0]?.[1]).toMatchObject({ destinationFrame: destination.file });
    expect(nest.mock.calls).toEqual([[destination.file], [null]]);
  });

  it("releases a layer over empty canvas into a frame of its own without outlining one", async () => {
    mocks.confirmedFrames = [source];
    const nest = vi.fn();
    await transferDesignLayerAtRelease({ ...input, details: measured, pointer: { x: 3000, y: 3000 }, nest });
    expect(mocks.transfer.mock.calls[0]?.[1]).not.toHaveProperty("destinationFrame");
    expect(nest).not.toHaveBeenCalled();
  });

  it("waits for a destination frame that just went live, and refuses one that never loads", async () => {
    mocks.runtimeFor.mockImplementation((file: string) => (file === destination.file ? null : mocks.runtime));
    mocks.waitForRuntime.mockImplementationOnce(async () => {
      mocks.runtimeFor.mockImplementation(() => mocks.runtime);
      return mocks.runtime;
    });
    await expect(transferDesignLayerOnCanvas({ ...input })).resolves.toBe(true);
    expect(mocks.waitForRuntime).toHaveBeenCalledWith(input.workspaceId, destination.file, expect.any(Number));
    expect(mocks.transfer).toHaveBeenCalledOnce();
    mocks.runtimeFor.mockImplementation((file: string) => (file === destination.file ? null : mocks.runtime));
    mocks.waitForRuntime.mockResolvedValueOnce(null);
    await expect(transferDesignLayerOnCanvas({ ...input })).rejects.toThrow(/still loading/);
    expect(mocks.transfer).toHaveBeenCalledOnce();
  });
});

