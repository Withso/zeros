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
    const { designWithoutBoundStyles } = await import("../state/design-component-bindings");
    const record = { file: "home.html", sourceVersion: "a".repeat(24), instances: { key: "0".repeat(16),
      components: { "text-field": { elements: [], reach: {}, file: "tf.html", frame: true, bindings: { root: "tf", layers: { tf: { styles: { width: ["width"] } } } } } },
      hosts: { inst: { component: "text-field", attributes: {} } } } };
    expect(designWithoutBoundStyles("ws", record, "inst", { position: "absolute", left: "4px", width: "200px", height: "40px", "--zeros-layout-x": "4px" }))
      .toEqual({ position: "absolute", left: "4px", height: "40px", "--zeros-layout-x": "4px" });
    expect(designWithoutBoundStyles("ws", record, "inst", { width: "200px" })).toBeNull();
    expect(designWithoutBoundStyles("ws", record, "inst", { width: null })).toEqual({ width: null });
    expect(designWithoutBoundStyles("ws", record, "card", { width: "200px" })).toEqual({ width: "200px" });
  });
});

describe("bindings a selected layer's runtime winners complete", () => {
  const V = "a".repeat(24);
  const option = (name: string, type: string, label: string) =>
    ({ tag: "zd-option", attributes: [{ name: "name", value: name }, { name: "type", value: type }, { name: "label", value: label }] });
  const winner = (value: string, selector?: string) => ({ origin: "frame" as const, value, ...(selector ? { selector } : {}) });
  const details = (oid: string, authoredStyles: Record<string, ReturnType<typeof winner>>) =>
    ({ oid, sourceVersion: V, authoredStyles }) as never;

  it("binds a Button instance's height through a gated rule in a linked sheet, so its H is the Size control", async () => {
    const { designLayerBoundStyles, rememberDesignRuntimeBindings, resetDesignRuntimeBindingsForTests } = await import("../state/design-component-bindings");
    resetDesignRuntimeBindingsForTests();
    const button = { elements: [option("size", "choice", "Size"), option("radius", "number", "Radius")], reach: {}, file: "button.html", frame: true,
      bindings: { root: "btn", layers: { btn: { attributes: ["size"] } }, gates: { "data-size": ["size"] }, vars: { "--btn-radius": ["radius"] } } };
    const home = { file: "home.html", sourceVersion: V, instances: { key: "0".repeat(16), components: { button }, hosts: { b1: { component: "button", attributes: {} } } } };
    expect(designLayerBoundStyles("ws", home, "b1")).toEqual({});
    rememberDesignRuntimeBindings("ws", home, details("b1", { height: winner("30px", '.btn[data-size="sm"]'), "border-radius": winner("var(--btn-radius, 6px)", ".btn"), color: winner("white", ".btn") }));
    expect(designLayerBoundStyles("ws", home, "b1")).toEqual({ height: ["size"], "border-radius": ["radius"] });
    // Another generation knows nothing yet.
    expect(designLayerBoundStyles("ws", { ...home, sourceVersion: "b".repeat(24) }, "b1")).toEqual({});
  });

  it("binds a Button main's Corner radius to Radius and a Badge's colours to Ink and Wash through own custom properties", async () => {
    const { designLayerBoundStyles, rememberDesignRuntimeBindings, refuseDesignBoundStyleWrite } = await import("../state/design-component-bindings");
    const main = { file: "button.html", sourceVersion: V, component: { elements: [option("radius", "number", "Radius")], reach: {},
      bindings: { root: "btn", layers: { btn: { styles: { "--btn-radius": ["radius"] } } }, vars: { "--btn-radius": ["radius"] } } } };
    rememberDesignRuntimeBindings("ws", main, details("btn", { "border-radius": winner("var(--btn-radius, 6px)", ".btn") }));
    expect(designLayerBoundStyles("ws", main, "btn")["border-radius"]).toEqual(["radius"]);
    expect(() => refuseDesignBoundStyleWrite("ws", main, { nodeId: "btn", styles: { "border-radius": "12px" } })).toThrow("Border-radius is set by the Radius control");
    expect(() => refuseDesignBoundStyleWrite("ws", main, { nodeId: "btn", styles: { "border-radius": null } })).not.toThrow();
    // A state variant's rule is the same write: refused too.
    expect(() => refuseDesignBoundStyleWrite("ws", main, [{ type: "node.set-styles", nodeId: "btn", stateContext: "hover", styles: { "border-radius": "2px" } }]))
      .toThrow(/Radius/);
    const badge = { file: "badge.html", sourceVersion: V, component: { elements: [option("ink", "color", "Ink"), option("wash", "color", "Wash")], reach: {},
      bindings: { layers: {}, vars: { "--badge-ink": ["ink"], "--badge-wash": ["wash"] } } } };
    rememberDesignRuntimeBindings("ws", badge, details("badge-soft", { color: winner("var(--badge-ink)", ".badge--soft"), "background-color": winner("var(--badge-wash)", ".badge--soft") }));
    expect(designLayerBoundStyles("ws", badge, "badge-soft")).toEqual({ color: ["ink"], "background-color": ["wash"] });
  });

  it("refuses a raw write on a layer a truncated record dropped, once its winners show the binding", async () => {
    const { rememberDesignRuntimeBindings, refuseDesignBoundStyleWrite } = await import("../state/design-component-bindings");
    const main = { file: "big.html", sourceVersion: V, component: { elements: [option("width", "number", "Width")], reach: {},
      bindings: { layers: {}, truncated: true as const } } };
    expect(() => refuseDesignBoundStyleWrite("ws", main, { nodeId: "far", styles: { width: "40px" } })).not.toThrow();
    rememberDesignRuntimeBindings("ws", main, details("far", { width: winner("var(--zd-width)", ".far") }));
    expect(() => refuseDesignBoundStyleWrite("ws", main, { nodeId: "far", styles: { width: "40px" } })).toThrow("Width is set by the Width control");
  });
});

describe("deleting a main's layers that controls drive", () => {
  it("names the controls bound to the selection and the layers inside it, and nothing for unbound layers", async () => {
    const { designDeleteBoundControls, resetDesignRuntimeBindingsForTests } = await import("../state/design-component-bindings");
    resetDesignRuntimeBindingsForTests();
    const node = (oid: string, children: DesignRuntimeTreeNode[] = []): DesignRuntimeTreeNode => ({ oid, tag: "div", name: oid, text: null, visible: true, children });
    const option = (name: string, label: string) => ({ tag: "zd-option", attributes: [{ name: "name", value: name }, { name: "type", value: "text" }, { name: "label", value: label }] });
    const main = { file: "button.html", sourceVersion: "a".repeat(24), component: { elements: [option("label", "Label"), option("icon", "Icon")], reach: {},
      bindings: { root: "btn", layers: { "btn-label": { text: ["label"] }, "btn-icon": { visible: ["icon"] } } } } };
    const tree = [node("btn", [node("btn-wrap", [node("btn-label")]), node("btn-icon"), node("btn-spacer")])];
    expect(designDeleteBoundControls("ws", main, tree, ["btn-label"])).toEqual(["Label"]);
    expect(designDeleteBoundControls("ws", main, tree, ["btn-wrap"])).toEqual(["Label"]);
    expect(designDeleteBoundControls("ws", main, tree, ["btn"])).toEqual(["Icon", "Label"]);
    expect(designDeleteBoundControls("ws", main, tree, ["btn-spacer"])).toEqual([]);
    expect(designDeleteBoundControls("ws", { ...main, component: undefined }, tree, ["btn-label"])).toEqual([]);
  });
});

describe("size writers on an instance whose width a control drives", () => {
  const record = { file: "home.html", sourceVersion: "c".repeat(24), instances: { key: "0".repeat(16),
    components: { "text-field": { elements: [], reach: {}, file: "tf.html", frame: true, bindings: { root: "tf", layers: { tf: { styles: { width: ["width"] } } } } } },
    hosts: { inst: { component: "text-field", attributes: {} } } } };

  it("lets a frame-root instance's frame edge size its height and drops only the width a frame edge carries along", async () => {
    const { designWithoutBoundStyles } = await import("../state/design-component-bindings");
    expect(designWithoutBoundStyles("ws", record, "inst", { width: "100%", height: "320px" })).toEqual({ height: "320px" });
    // East edge: nothing but the frame's own box is left.
    expect(designWithoutBoundStyles("ws", record, "inst", { width: "100%" })).toBeNull();
  });

  it("resizes the other axis from the keyboard and makes the bound axis's key do nothing", async () => {
    const { designKeyboardResizeStyles } = await import("../state/design-component-bindings");
    const gesture = { frame: record, nodeId: "inst", width: 200, height: 40, dw: 10, dh: 5 };
    expect(designKeyboardResizeStyles("ws", gesture)).toEqual({ height: "45px" });
    expect(designKeyboardResizeStyles("ws", { ...gesture, nodeId: "plain" })).toEqual({ width: "210px", height: "45px" });
  });

  it("keeps a group's plain layers and the instance's other axis when the group resizes", async () => {
    const { designWithoutBoundStyles } = await import("../state/design-component-bindings");
    const group = [["inst", { left: "4px", width: "220px", height: "48px" }], ["plain", { left: "300px", width: "80px", height: "48px" }]] as const;
    expect(group.map(([nodeId, styles]) => designWithoutBoundStyles("ws", record, nodeId, styles))).toEqual([
      { left: "4px", height: "48px" }, { left: "300px", width: "80px", height: "48px" }]);
  });
});
