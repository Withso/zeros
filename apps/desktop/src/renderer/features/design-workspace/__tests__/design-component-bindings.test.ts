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
  designSizeAxisControls,
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
    // One control that sets both axes (an Avatar's Size) shows once, on W; H still takes no raw value.
    expect(designSizeAxisControls({ width: ["size"], height: ["size"] })).toEqual({ width: ["size"], height: [], heightShared: true });
    expect(designSizeAxisControls({ width: ["w"], height: ["h", "w"] })).toEqual({ width: ["w"], height: ["h"], heightShared: false });
    expect(designSizeAxisControls({ width: [], height: ["h"] })).toEqual({ width: [], height: ["h"], heightShared: false });
    // A control a layer's style reads shows in its field's place, not here as well.
    expect(designMainLayerControls({ elements: [], reach: {}, bindings }, "tf")).toEqual([]);
    expect(designMainLayerControls({ elements: [], reach: {}, bindings: { layers: { x: { text: ["a"], styles: { color: ["a", "b"] } } } } }, "x")).toEqual(["a"]);
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

  it("binds a winner through its selector's gates only when every arm of the list tests one", async () => {
    const { designRuntimeBoundStyles } = await import("../state/design-component-bindings");
    const record = { elements: [option("tone", "choice", "Tone")], reach: {}, bindings: { layers: {}, gates: { "data-tone": ["tone"] } } };
    expect(designRuntimeBoundStyles(record, { opacity: winner("0.7", '.badge[data-tone="danger"], .caption') })).toEqual({});
    expect(designRuntimeBoundStyles(record, { opacity: winner("0.7", '.badge[data-tone="danger"], .badge[data-tone="info"]') })).toEqual({ opacity: ["tone"] });
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

describe("a write over a control compares the longhands each property sets", () => {
  const V = "d".repeat(24);
  const option = (name: string, label: string) => ({ tag: "zd-option", attributes: [{ name: "name", value: name }, { name: "label", value: label }] });
  // The harness main: .composer { gap: var(--zd-gap); transition: … } and .send { border-radius: …; background: var(--zd-accent) }.
  const main = { file: "pricing.html", sourceVersion: V, component: {
    elements: [option("gap", "Gap"), option("motion", "Easing"), option("send-radius", "Corner radius"), option("accent", "Accent"), option("tone", "Tone")], reach: {},
    bindings: { root: "cc-root", layers: {
      "cc-root": { styles: { gap: ["gap"], transition: ["motion"] } },
      "cc-send": { styles: { "border-radius": ["send-radius"], background: ["accent"] } },
      "cc-chip": { styles: { "border-top-left-radius": ["tone"], "inline-size": ["tone"] } },
    } } } };

  it("refuses a longhand over a bound shorthand, and a shorthand over a bound longhand", async () => {
    const { refuseDesignBoundStyleWrite } = await import("../state/design-component-bindings");
    for (const [nodeId, styles, control] of [
      ["cc-root", { "row-gap": "20px" }, "Gap"], ["cc-root", { "column-gap": "20px" }, "Gap"], ["cc-root", { gap: "20px" }, "Gap"],
      ["cc-send", { "background-color": "red" }, "Accent"], ["cc-send", { background: "red" }, "Accent"],
      ["cc-send", { "border-top-left-radius": "2px" }, "Corner radius"], ["cc-root", { "transition-duration": "1s" }, "Easing"],
      ["cc-chip", { "border-radius": "4px" }, "Tone"], ["cc-chip", { width: "40px" }, "Tone"], ["cc-chip", { "min-width": "40px" }, "Tone"],
    ] as const)
      expect(() => refuseDesignBoundStyleWrite("ws", main, { nodeId, styles }), `${nodeId} ${Object.keys(styles)[0]}`).toThrow(control);
    for (const [nodeId, styles] of [["cc-root", { "padding-left": "4px" }], ["cc-send", { color: "red" }], ["cc-root", { "row-gap": null }], ["cc-chip", { height: "4px" }]] as const)
      expect(() => refuseDesignBoundStyleWrite("ws", main, { nodeId, styles })).not.toThrow();
  });

  it("keeps the same comparison for size axes, layout actions and the root size controls", async () => {
    const { designBoundSizeAxes, designBoundControlsFor, designRootSizeControls, designWithoutBoundStyles } = await import("../state/design-component-bindings");
    expect(designBoundSizeAxes("ws", main, "cc-chip")).toEqual({ width: true, height: false });
    expect(designWithoutBoundStyles("ws", main, "cc-root", { "row-gap": "4px", "padding-top": "2px" })).toEqual({ "padding-top": "2px" });
    expect(designRootSizeControls({ root: "r", layers: { r: { styles: { "inline-size": ["w"] } } } })).toEqual({ width: ["w"], height: [] });
    expect(designBoundControlsFor({ gap: ["gap"], "row-gap": ["density"] }, "row-gap")).toEqual(["density", "gap"]);
  });
});

describe("a write to a layer whose runtime winners were never read", () => {
  const V = "e".repeat(24);
  const winner = (value: string) => ({ origin: "frame" as const, value, selector: ".chips" });
  const main = { file: "pricing.html", sourceVersion: V, component: {
    elements: [{ tag: "zd-option", attributes: [{ name: "name", value: "gap" }, { name: "label", value: "Gap" }] }], reach: {},
    bindings: { root: "cc-root", layers: { "cc-root": { styles: { gap: ["gap"] } } }, vars: { "--chip-round": ["gap"] } } } };
  const write = (nodeIds: readonly string[], value: string | null = "5px") =>
    nodeIds.map((nodeId) => ({ type: "node.set-styles", nodeId, styles: { "border-radius": value } }));

  it("reads each untracked target once, in parallel, before the fence decides", async () => {
    const { completeDesignRuntimeBindings, refuseDesignBoundStyleWrite, resetDesignRuntimeBindingsForTests } = await import("../state/design-component-bindings");
    resetDesignRuntimeBindingsForTests();
    const reads: string[] = [];
    let open = 0, most = 0;
    const read = async (nodeId: string) => {
      reads.push(nodeId); open += 1; most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      return { oid: nodeId, sourceVersion: V, authoredStyles: nodeId === "cc-chips" ? { "border-radius": winner("var(--chip-round)") } : {} } as never;
    };
    // A layer never selected: only the static half knows it, and that half says nothing.
    expect(() => refuseDesignBoundStyleWrite("ws", main, write(["cc-chips"]))).not.toThrow();
    await completeDesignRuntimeBindings("ws", main, [...write(["cc-chips", "cc-chips", "cc-prompt"]), ...write(["cc-mode"], null)], read);
    expect(reads.sort()).toEqual(["cc-chips", "cc-prompt"]);
    expect(most).toBe(2);
    expect(() => refuseDesignBoundStyleWrite("ws", main, write(["cc-chips"]))).toThrow("Gap");
    // Known at this generation, an empty answer included: no second read.
    await completeDesignRuntimeBindings("ws", main, write(["cc-chips", "cc-prompt"]), read);
    expect(reads).toHaveLength(2);
  });

  it("reads at most 32 targets a write, and nothing in a frame without a component or instances", async () => {
    const { completeDesignRuntimeBindings, DESIGN_BOUND_COMPLETION_LIMIT, resetDesignRuntimeBindingsForTests } = await import("../state/design-component-bindings");
    resetDesignRuntimeBindingsForTests();
    expect(DESIGN_BOUND_COMPLETION_LIMIT).toBe(32);
    const reads: string[] = [];
    const read = async (nodeId: string) => { reads.push(nodeId); return null; };
    await completeDesignRuntimeBindings("ws", main, write(Array.from({ length: 40 }, (_, index) => `n${index}`)), read);
    // Past the limit the static bindings decide alone.
    expect(reads).toHaveLength(32);
    reads.length = 0;
    await completeDesignRuntimeBindings("ws", { file: "plain.html", sourceVersion: V }, write(["a", "b"]), read);
    expect(reads).toEqual([]);
  });
});

describe("rules gated on a control, at a value none of them matches", () => {
  const V = "f".repeat(24);
  const option = (name: string, label: string) => ({ tag: "zd-option", attributes: [{ name: "name", value: name }, { name: "label", value: label }] });
  // The demo Button: .btn[data-size="sm"] { height } in a linked sheet, and size defaults to md.
  const button = { elements: [option("size", "Size"), option("tone", "Tone")], reach: {}, file: "button.html", frame: true,
    bindings: { root: "btn", layers: { btn: { attributes: ["size"] } }, gates: { "data-size": ["size"], class: ["tone"] }, classGates: { "btn--": ["tone"] } } };
  const home = { file: "home.html", sourceVersion: V, instances: { key: "0".repeat(16), components: { button }, hosts: { b1: { component: "button", attributes: {} } } } };
  const runtime = (answer: Record<string, string[]>, calls: unknown[] = []) => ({
    supports: (method: string) => method === "getGatedStyles",
    getGatedStyles: async (nodeId: string, gates: unknown) => { calls.push([nodeId, gates]); return answer; },
  });

  it("binds the instance's height to Size and its fill to Tone, once per generation, and tells the panel", async () => {
    const { designBoundSizeAxes, designLayerBoundStyles, readDesignGatedBindings, refuseDesignBoundStyleWrite, resetDesignRuntimeBindingsForTests,
      subscribeDesignRuntimeBindings, designRuntimeBindingsVersion } = await import("../state/design-component-bindings");
    resetDesignRuntimeBindingsForTests();
    expect(designBoundSizeAxes("ws", home, "b1")).toEqual({ width: false, height: false });
    const calls: unknown[] = [];
    let told = 0;
    const stop = subscribeDesignRuntimeBindings(() => { told += 1; });
    const before = designRuntimeBindingsVersion();
    await readDesignGatedBindings("ws", home, "b1", runtime({ height: ["data-size"], background: [".btn--"], color: ["data-other"] }, calls));
    stop();
    expect(calls).toEqual([["b1", { attributes: ["data-size"], classPrefixes: ["btn--"] }]]);
    expect(told).toBe(1);
    expect(designRuntimeBindingsVersion()).toBe(before + 1);
    expect(designLayerBoundStyles("ws", home, "b1")).toEqual({ height: ["size"], background: ["tone"] });
    expect(designBoundSizeAxes("ws", home, "b1")).toEqual({ width: false, height: true });
    expect(() => refuseDesignBoundStyleWrite("ws", home, { nodeId: "b1", styles: { height: "40px" } })).toThrow("Size");
    await readDesignGatedBindings("ws", home, "b1", runtime({}, calls));
    expect(calls).toHaveLength(1);
    // Another generation asks again.
    expect(designBoundSizeAxes("ws", { ...home, sourceVersion: "9".repeat(24) }, "b1")).toEqual({ width: false, height: false });
  });

  it("keeps today's answer with an older runtime, and reads gates with a write's other untracked targets", async () => {
    const { completeDesignRuntimeBindings, designLayerBoundStyles, readDesignGatedBindings, resetDesignRuntimeBindingsForTests } = await import("../state/design-component-bindings");
    resetDesignRuntimeBindingsForTests();
    await readDesignGatedBindings("ws", home, "b1", { supports: () => false });
    expect(designLayerBoundStyles("ws", home, "b1")).toEqual({});
    const calls: unknown[] = [];
    await completeDesignRuntimeBindings("ws", home, [{ type: "node.set-styles", nodeId: "b1", styles: { height: "40px" } }],
      async () => null, runtime({ height: ["data-size"] }, calls));
    expect(calls).toHaveLength(1);
    expect(designLayerBoundStyles("ws", home, "b1")).toEqual({ height: ["size"] });
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

  it("leaves a target whose requested axis a control drives out of a Size mode change, whole", async () => {
    const { designSizingTargets } = await import("../state/design-component-bindings");
    const nodes = [{ oid: "inst" }, { oid: "plain" }];
    expect(designSizingTargets("ws", record, nodes, "x").map((node) => node.oid)).toEqual(["plain"]);
    expect(designSizingTargets("ws", record, nodes, "y").map((node) => node.oid)).toEqual(["inst", "plain"]);
  });

  it("keeps a group's plain layers and the instance's other axis when the group resizes", async () => {
    const { designWithoutBoundStyles } = await import("../state/design-component-bindings");
    const group = [["inst", { left: "4px", width: "220px", height: "48px" }], ["plain", { left: "300px", width: "80px", height: "48px" }]] as const;
    expect(group.map(([nodeId, styles]) => designWithoutBoundStyles("ws", record, nodeId, styles))).toEqual([
      { left: "4px", height: "48px" }, { left: "300px", width: "80px", height: "48px" }]);
  });
});
