import { expect, it } from "vitest";
import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire, DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { designLayerPanelRows } from "../design-layer-panel-rows";
import { designFrameViews, designPresentedFrame } from "../state/design-frame-view";

const SOURCE_VERSION = "a".repeat(24);
const frame: DesignCanvasFrameWire = {
  file: "home.html", frameId: "home", title: "Home", kind: "frame", x: 0, y: 0, width: 320, height: 240, z: 0,
  nodeCount: 3, layerCount: 2, modifiedAt: 1, sourceVersion: SOURCE_VERSION,
};
const emptyFrame: DesignCanvasFrameWire = {
  ...frame, file: "frame-1.html", frameId: "frame-1", title: "Frame", x: 400, nodeCount: 1, layerCount: 0,
};
const tree: DesignRuntimeTreeNode[] = [
  { oid: "heading", tag: "h1", name: "Heading", text: "Hello", visible: true, children: [] },
  { oid: "copy", tag: "p", name: "Copy", text: "Body", visible: true, children: [] },
];
const open = { treeExpanded: true, expandedNodeIds: [] };

function snapshot(prepared: boolean, frames: DesignCanvasFrameWire[]): DesignWorkspaceSnapshotWire {
  return {
    directoryId: "dir", directory: "Design", protocolCapability: null, frames, tokens: [], tokenSourceVersion: "t",
    assets: [], lint: { workspacePath: "/design", checkedFiles: [], violations: [], healedOids: 0 },
    ...(prepared ? {} : { preparation: { revision: "r".repeat(64), epoch: 2, current: [], errors: {},
      descriptions: frames.map(({ sourceVersion: _s, nodeCount: _n, layerCount: _l, modifiedAt: _m, ...rest }) =>
        ({ ...rest, preparation: "unprepared" as const })) } }),
  };
}

const kinds = (rows: ReturnType<typeof designLayerPanelRows>) => rows.map((row) => row.kind === "layer" ? `layer:${row.layer.node.oid}` : row.kind);

it("keeps an open frame's confirmed layers while its source revalidates", () => {
  // Every watcher echo after a save republishes the directory with frames
  // unprepared until source checks finish; Layers must not flash a loading row.
  const prepared = designLayerPanelRows({ frames: designFrameViews(snapshot(true, [frame])),
    treesByFile: { [frame.file]: tree }, disclosures: { [frame.file]: open } });
  const revalidating = designLayerPanelRows({ frames: designFrameViews(snapshot(false, [frame])),
    treesByFile: { [frame.file]: tree }, disclosures: { [frame.file]: open } });
  expect(kinds(prepared)).toEqual(["frame", "layer:heading", "layer:copy"]);
  expect(kinds(revalidating)).toEqual(kinds(prepared));
  // Layer actions keep the last confirmed generation's identity.
  expect(revalidating.find((row) => row.kind === "layer")?.frame).toBe(frame);
});

it("never shows a loading row under a frame that has no layers", () => {
  // A new frame is revealed open before its runtime reports a tree; its root
  // shares the frame row, so there is nothing to wait for.
  const rows = designLayerPanelRows({ frames: designFrameViews(snapshot(true, [emptyFrame])),
    treesByFile: {}, disclosures: { [emptyFrame.file]: open } });
  expect(kinds(rows)).toEqual(["frame"]);
  expect(rows[0]).toMatchObject({ kind: "frame", discloses: false });
});

it("still waits for a frame whose layers have never been read", () => {
  const rows = designLayerPanelRows({ frames: designFrameViews(snapshot(true, [frame])),
    treesByFile: {}, disclosures: { [frame.file]: open } });
  expect(kinds(rows)).toEqual(["frame", "pending"]);
  const cold = designLayerPanelRows({ frames: designFrameViews(snapshot(false, [frame]).preparation
    ? { ...snapshot(false, [frame]), frames: [] } : undefined), treesByFile: {}, disclosures: { [frame.file]: open } });
  expect(kinds(cold)).toEqual(["frame", "pending"]);
});

it("presents the last confirmed frame while a description revalidates", () => {
  const [view] = designFrameViews(snapshot(false, [frame]));
  expect(designPresentedFrame(view)).toBe(frame);
  const [cold] = designFrameViews({ ...snapshot(false, [frame]), frames: [] });
  expect(designPresentedFrame(cold)).toBeNull();
  expect(designPresentedFrame(undefined)).toBeNull();
});
