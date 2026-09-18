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
