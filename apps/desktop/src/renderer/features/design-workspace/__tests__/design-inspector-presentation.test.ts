import { expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignCanvasFrameWire } from "../../../platform/git";
import {
  designInspectorPresented,
  designInspectorSelectionReady,
  type DesignInspectorSelection,
} from "../design-inspector-presentation";

const frame = (file: string): DesignCanvasFrameWire => ({
  file, title: file, kind: "frame", x: 0, y: 0, width: 100, height: 100, z: 0,
  nodeCount: 2, layerCount: 1, modifiedAt: 1, sourceVersion: "a".repeat(24),
});
const details = (oid: string): DesignRuntimeNodeDetails => ({
  sourceVersion: "a".repeat(24), oid, tag: "div", name: oid, text: null, selector: `[data-oid="${oid}"]`,
  visible: true, breadcrumb: [oid], rect: { x: 0, y: 0, width: 10, height: 10 }, styles: {},
});
const selection = (input: Partial<DesignInspectorSelection>): DesignInspectorSelection => ({
  frame: frame("home.html"), frameSelected: false, details: null, selectedNodeId: null, selectedNodeIds: [], ...input,
});

it("treats a selection as ready only when its exact details are present", () => {
  expect(designInspectorSelectionReady(selection({ frame: null }))).toBe(true);
  expect(designInspectorSelectionReady(selection({}))).toBe(true);
  expect(designInspectorSelectionReady(selection({ frameSelected: true }))).toBe(false);
  expect(designInspectorSelectionReady(selection({ frameSelected: true, details: details("root") }))).toBe(true);
  expect(designInspectorSelectionReady(selection({ selectedNodeId: "a", selectedNodeIds: ["a"] }))).toBe(false);
  expect(designInspectorSelectionReady(selection({ selectedNodeId: "a", selectedNodeIds: ["a"], details: details("b") }))).toBe(false);
  expect(designInspectorSelectionReady(selection({ selectedNodeId: "a", selectedNodeIds: ["a"], details: details("a") }))).toBe(true);
});

it("holds the last complete view while a new selection's details load, then gives up", () => {
  const ready = selection({ selectedNodeId: "a", selectedNodeIds: ["a"], details: details("a") });
  const loading = selection({ selectedNodeId: "b", selectedNodeIds: ["b"] });
  // Fast read: the previous complete view stays (inert) instead of "Nothing selected".
  expect(designInspectorPresented({ next: loading, lastReady: ready, expired: false }))
    .toEqual({ selection: ready, held: true });
  // The bound elapsed: present the real (incomplete) selection.
  expect(designInspectorPresented({ next: loading, lastReady: ready, expired: true }))
    .toEqual({ selection: loading, held: false });
  // Nothing complete to hold, or the next one is ready: present it at once.
  expect(designInspectorPresented({ next: loading, lastReady: null, expired: false }))
    .toEqual({ selection: loading, held: false });
  const readyB = { ...loading, details: details("b") };
  expect(designInspectorPresented({ next: readyB, lastReady: ready, expired: false }))
    .toEqual({ selection: readyB, held: false });
});

it("never holds another workspace's or frame-less view", () => {
  const ready = selection({ selectedNodeId: "a", selectedNodeIds: ["a"], details: details("a") });
  const otherFrame = selection({ frame: frame("pricing.html"), frameSelected: true });
  expect(designInspectorPresented({ next: otherFrame, lastReady: ready, expired: false }).held).toBe(true);
  const page = selection({ frame: null });
  expect(designInspectorPresented({ next: page, lastReady: ready, expired: false }))
    .toEqual({ selection: page, held: false });
});
