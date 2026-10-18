import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
  designWorkspaceView,
} from "../state/design-workspace-ui";

const mocks = vi.hoisted(() => ({
  transfer: vi.fn(),
  selectNode: vi.fn(),
  selectFrame: vi.fn(),
}));
vi.mock("../state/design-workspace-cache", () => ({
  transferDesignNodeCached: mocks.transfer,
}));
vi.mock("../state/design-selection", () => ({
  selectDesignNode: mocks.selectNode,
  selectDesignFrame: mocks.selectFrame,
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: () => ({
    sourceVersion: "a".repeat(24),
    supports: () => true,
    getLayoutTargets: async () => [],
  }),
}));
vi.mock("../design-layout-drag", () => ({
  designLayoutDrop: () => ({
    parentId: "target-root",
    beforeId: null,
    styles: {},
  }),
}));
import { transferDesignLayerOnCanvas } from "../design-layout-transfer";

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
  resetDesignWorkspaceUiForTests();
  useDesignWorkspaceUiStore
    .getState()
    .setSelection(input.workspaceId, source.file, node.oid);
  mocks.transfer.mockResolvedValue(reply);
});

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
      expect(mocks.transfer).toHaveBeenCalledWith(
        input.workspaceId,
        expect.objectContaining({
          destinationFrame: upper.file,
        }),
      );
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
