import { describe, expect, it } from "vitest";
import { designComponentPartNodeId, designComponentSlotNodeId, type DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import type { DesignComponentBindings, DesignFrameInstances } from "@zeros/protocol/design-catalog";
import {
  designBindingControls,
  designMainLayerControls,
  designPartControls,
  designPartSelectable,
  designRootSizeControls,
  designSelectablePartLayers,
} from "../state/design-component-bindings";

const bindings: DesignComponentBindings = {
  root: "tf",
  layers: { tf: { styles: { width: ["width"] } }, "tf-label": { text: ["label"] }, "tf-input": { visible: ["state"], attributes: ["placeholder", "value"] } },
};
const frame = (withBindings = true) => ({ instances: { key: "0".repeat(16),
  components: { "text-field": { elements: [], reach: {}, file: "tf.html", frame: true, ...(withBindings ? { bindings } : {}) } },
  hosts: { inst: { component: "text-field", attributes: {} } } } satisfies DesignFrameInstances });

describe("which controls a component's layers read", () => {
  it("lists a part's controls, by its main layer without a repeat's suffix", () => {
    expect(designPartControls(frame(), designComponentPartNodeId("inst", "tf-input"))).toEqual(["placeholder", "state", "value"]);
    expect(designPartControls(frame(), designComponentPartNodeId("inst", "tf-label#2"))).toEqual(["label"]);
    expect(designPartControls(frame(), designComponentPartNodeId("inst", "tf-wrapper"))).toEqual([]);
  });

  it("selects only parts a control drives, and slots; nothing without bindings", () => {
    expect(designPartSelectable(frame(), designComponentPartNodeId("inst", "tf-label"))).toBe(true);
    expect(designPartSelectable(frame(), designComponentPartNodeId("inst", "tf-wrapper"))).toBe(false);
    expect(designPartSelectable(frame(), designComponentSlotNodeId("inst", "extras"))).toBe(true);
    expect(designPartSelectable(frame(false), designComponentPartNodeId("inst", "tf-label"))).toBe(false);
    expect(designPartSelectable(frame(false), designComponentSlotNodeId("inst", "extras"))).toBe(true);
    expect(designPartControls(frame(false), designComponentPartNodeId("inst", "tf-label"))).toBeNull();
    // A layer id named like an Object member is not a binding.
    expect(designPartSelectable(frame(), designComponentPartNodeId("inst", "constructor"))).toBe(false);
  });

  it("gives the runtime a stable list of a host's selectable layers", () => {
    const record = frame();
    expect(designSelectablePartLayers(record, "inst")).toEqual(["tf", "tf-input", "tf-label"]);
    expect(designSelectablePartLayers(record, "inst")).toBe(designSelectablePartLayers(record, "inst"));
    expect(designSelectablePartLayers(frame(false), "inst")).toBeNull();
  });

  it("names the controls that drive the root's size, and a main layer's controls", () => {
    expect(designRootSizeControls(bindings)).toEqual({ width: ["width"], height: [] });
    expect(designRootSizeControls({ layers: {} })).toEqual({ width: [], height: [] });
    expect(designRootSizeControls(undefined)).toEqual({ width: [], height: [] });
    expect(designMainLayerControls({ elements: [], reach: {}, bindings }, "tf-label")).toEqual(["label"]);
    expect(designMainLayerControls({ elements: [], reach: {} }, "tf-label")).toBeNull();
    expect(designBindingControls({ text: ["a"], styles: { color: ["b", "a"] } })).toEqual(["a", "b"]);
  });
});

describe("the layer tree people navigate inside an instance", () => {
  const node = (oid: string, children: DesignRuntimeTreeNode[] = []): DesignRuntimeTreeNode => ({ oid, tag: "div", name: oid, text: null, visible: true, children });
  const part = (layer: string) => designComponentPartNodeId("inst", layer);
  it("hides parts no control drives and hoists the parts and slots under them, keeping the tree when nothing changes", async () => {
    const { designSelectableLayerTree } = await import("../state/design-component-bindings");
    const tree = [node("inst", [node(part("tf-wrapper"), [node(part("tf-label")), node(designComponentSlotNodeId("inst", "extras"))]), node(part("tf-input"))]), node("other")];
    const record = frame();
    const shown = designSelectableLayerTree(tree, record);
    expect(shown.map((entry) => [entry.oid, entry.children.map((child) => child.oid)])).toEqual([
      ["inst", [part("tf-label"), designComponentSlotNodeId("inst", "extras"), part("tf-input")]], ["other", []]]);
    expect(designSelectableLayerTree(tree, record)).toBe(shown);
    expect(shown[1]).toBe(tree[1]);
    // Without bindings only slots stay.
    expect(designSelectableLayerTree(tree, frame(false))[0]!.children.map((child) => child.oid)).toEqual([designComponentSlotNodeId("inst", "extras")]);
    const plain = [node("a", [node("b")])];
    expect(designSelectableLayerTree(plain, { instances: undefined })).toBe(plain);
  });
});

describe("a layout action over an instance whose size a control drives", () => {
  it("keeps the instance's place and drops only the bound axis", async () => {
    const { designWithoutBoundSize } = await import("../state/design-component-bindings");
    const record = { instances: { key: "0".repeat(16),
      components: { "text-field": { elements: [], reach: {}, file: "tf.html", frame: true, bindings: { root: "tf", layers: { tf: { styles: { width: ["width"] } } } } } },
      hosts: { inst: { component: "text-field", attributes: {} } } } };
    expect(designWithoutBoundSize(record, "inst", { position: "absolute", left: "4px", width: "200px", height: "40px", "--zeros-layout-x": "4px" }))
      .toEqual({ position: "absolute", left: "4px", height: "40px", "--zeros-layout-x": "4px" });
    expect(designWithoutBoundSize(record, "inst", { width: "200px" })).toBeNull();
    expect(designWithoutBoundSize(record, "inst", { width: null })).toEqual({ width: null });
    expect(designWithoutBoundSize(record, "card", { width: "200px" })).toEqual({ width: "200px" });
  });
});
