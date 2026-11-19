import { describe, expect, it } from "vitest";
import { designComponentPartNodeId, designComponentSlotNodeId } from "@zeros/protocol/design-runtime";
import { canInsertDesignFrame, designDrawParentAt, designFrameInsertion } from "../design-frame-insertion";
import {
  designComponentInstanceMark,
  designLayerDisplayName,
  designComponentPartHost,
  designFrameIsComponent,
  designComponentTextLock,
  designLayerRowKind,
  isDesignComponentPartNodeId,
  refuseDesignComponentPartWrite,
} from "../state/design-component-parts";

const component = {
  elements: [
    { tag: "zd-option", attributes: [{ name: "name", value: "send-label" }, { name: "type", value: "text" }, { name: "label", value: "Label" }] },
    { tag: "zd-option", attributes: [{ name: "name", value: "mode" }, { name: "type", value: "choice" }] },
  ],
  reach: { "send-label": "structure" as const, mode: "structure" as const },
  boundText: { "cc-send": ["send-label"], "cc-mode": ["mode"], "cc-chip": [] },
};

describe("what a person may not type over in a component", () => {
  it("names the option that sets a layer's text on the main", () => {
    expect(designComponentTextLock({ component }, "cc-send")).toEqual({ kind: "option", message: "Set by option Label" });
    expect(designComponentTextLock({ component }, "cc-mode")).toEqual({ kind: "option", message: "Set by option Mode" });
    expect(designComponentTextLock({ component }, "cc-chip")).toEqual({ kind: "option", message: "Set by the component's template" });
    expect(designComponentTextLock({ component }, "cc-prompt")).toBeNull();
    expect(designComponentTextLock({}, "cc-send")).toBeNull();
  });

  it("lets a style write name a part, as the instance's override, and refuses any other write", () => {
    const part = designComponentPartNodeId("inst", "cc-send");
    expect(() => refuseDesignComponentPartWrite([{ operationId: "s", type: "node.set-styles", nodeId: part, styles: { color: "red" } }])).not.toThrow();
    expect(() => refuseDesignComponentPartWrite([{ operationId: "t", type: "node.set-text", nodeId: part, text: "x" }])).toThrow();
    expect(() => refuseDesignComponentPartWrite([{ operationId: "m", type: "node.move", nodeId: "a", parentId: part, beforeId: null }])).toThrow();
  });

  it("refuses every other write to a part of an instance, and knows its host", () => {
    const part = designComponentPartNodeId("inst", "cc-send#1");
    expect(isDesignComponentPartNodeId(part)).toBe(true);
    expect(isDesignComponentPartNodeId("cc-send")).toBe(false);
    expect(designComponentPartHost(part)).toBe("inst");
    expect(designComponentPartHost("cc-send")).toBe("cc-send");
    expect(designComponentTextLock({}, part)?.kind).toBe("part");
    expect(() => refuseDesignComponentPartWrite({ operations: [{ nodeId: "a" }, { parentId: part }] })).toThrow();
    expect(() => refuseDesignComponentPartWrite({ operations: [{ nodeId: "a" }] })).not.toThrow();
  });
});

describe("an instance's slot", () => {
  const slot = designComponentSlotNodeId("inst", "content");

  it("takes a layer moved or drawn into it, and nothing else", () => {
    expect(() => refuseDesignComponentPartWrite([{ operationId: "m", type: "node.move", nodeId: "a", parentId: slot, beforeId: null }])).not.toThrow();
    expect(() => refuseDesignComponentPartWrite([{ operationId: "h", type: "node.set-html", nodeId: slot, mode: "append", html: "<div></div>" }])).not.toThrow();
    expect(() => refuseDesignComponentPartWrite({ frame: "a.html", nodeId: "a", parentId: slot, parentStyles: { position: "relative" } })).not.toThrow();
    for (const operation of [
      { operationId: "s", type: "node.set-styles", nodeId: slot, styles: { color: "red" } },
      { operationId: "r", type: "node.set-html", nodeId: slot, mode: "replace-inner", html: "<b></b>" },
      { operationId: "d", type: "node.delete", nodeId: slot },
      { operationId: "m", type: "node.move", nodeId: slot, parentId: "root", beforeId: null },
    ]) expect(() => refuseDesignComponentPartWrite([operation]), operation.type).toThrow();
  });

  it("is a part that moves nowhere, named by its slot in Layers, with the instance as its host", () => {
    expect(isDesignComponentPartNodeId(slot)).toBe(true);
    expect(designComponentPartHost(slot)).toBe("inst");
    expect(designLayerRowKind({}, slot)).toBe("slot");
    expect(designLayerDisplayName({}, { oid: slot, tag: "div", name: "div", text: "" } as never)).toBe("Content slot");
  });

  it("draws a layer into its flow, without asking the main's frame to be positioned", () => {
    const parent = { oid: slot, tag: "div", styles: { display: "block", position: "static" }, childCoordinateSpace: [1, 0, 0, 1, 0, 0] };
    const insertion = designFrameInsertion(parent as never, "drawn", { x: 10, y: 10 }, { x: 60, y: 40 });
    expect(insertion.parentStyles).toBeNull();
    expect(insertion.operations).toEqual([expect.objectContaining({ type: "node.set-html", nodeId: slot, mode: "append" })]);
    expect(insertion.insert.style).toContain("position:relative;width:50px;height:30px");
  });

  it("is the only place inside an instance a layer can be drawn or dropped", () => {
    const frame = (oid: string, tag = "div") => ({ oid, tag, name: tag, text: "", styles: { display: "block" } }) as never;
    expect(canInsertDesignFrame(frame(slot))).toBe(true);
    expect(canInsertDesignFrame(frame(designComponentPartNodeId("inst", "cc-panel")))).toBe(false);
    expect(canInsertDesignFrame(frame("inst", "zd-chat-composer"))).toBe(false);
    expect(canInsertDesignFrame(frame("panel"))).toBe(true);
  });

  it("takes a layer drawn over it, though hit testing stops at the instance", async () => {
    const empty = designComponentPartNodeId("inst", "empty");
    const title = designComponentPartNodeId("inst", "title");
    const nodes: Record<string, { tag: string; parentId: string | null }> = {
      main: { tag: "main", parentId: null },
      inst: { tag: "zd-card", parentId: "main" },
      [slot]: { tag: "div", parentId: "inst" },
      [empty]: { tag: "span", parentId: slot },
      [title]: { tag: "h2", parentId: "inst" },
    };
    const details = (oid: string) => ({ oid, tag: nodes[oid]!.tag, name: nodes[oid]!.tag, text: "", styles: { display: "block" },
      layout: { parentId: nodes[oid]!.parentId } }) as never;
    const runtime = (part: string | null) => ({
      supports: (method: string) => method === "getComponentPartAtLoc",
      getElementAtLoc: async () => details("inst"),
      getComponentPartAtLoc: async () => (part ? details(part) : null),
      getNodeDetails: async (oid: string) => details(oid),
    });
    expect((await designDrawParentAt(runtime(empty), { x: 1, y: 1 }))?.oid).toBe(slot);
    expect((await designDrawParentAt(runtime(title), { x: 1, y: 1 }))?.oid).toBe("main");
    expect((await designDrawParentAt(runtime(null), { x: 1, y: 1 }))?.oid).toBe("main");
  });
});

describe("where the canvas marks a component", () => {
  const instances = {
    key: "00000000000000a1",
    components: {
      "chat-composer": { elements: [], reach: {}, file: "home/composer.html", frame: true },
      "status-chip": { elements: [], reach: {}, file: "components/status-chip.html", frame: false },
    },
    hosts: {
      "inst-a": { component: "chat-composer", attributes: {} },
      "inst-b": { component: "status-chip", attributes: {} },
      "inst-c": { component: "missing", attributes: {} },
    },
  };
  const mainTitle = (file: string) => (file === "home/composer.html" ? "Chat composer" : undefined);

  it("tells Layers which rows are instances and which are their parts", () => {
    expect(designLayerRowKind({ instances }, "inst-b")).toBe("instance");
    expect(designLayerRowKind({ instances }, designComponentPartNodeId("inst-b", "chip"))).toBe("part");
    // A host whose component is gone is not offered as an instance.
    expect(designLayerRowKind({ instances }, "inst-c")).toBe("layer");
    expect(designLayerRowKind({ instances }, "constructor")).toBe("layer");
    expect(designLayerRowKind({}, "inst-b")).toBe("layer");
  });

  it("marks a main component frame by its own record, and nothing else as a frame", () => {
    expect(designFrameIsComponent({ component })).toBe(true);
    expect(designFrameIsComponent({})).toBe(false);
    const placesInstances: { component?: typeof component; instances: typeof instances } = { instances };
    expect(designFrameIsComponent(placesInstances)).toBe(false);
  });

  it("marks a selected instance by its host entry, titled by its component", () => {
    expect(designComponentInstanceMark({ instances }, "inst-a", mainTitle)).toEqual({ component: "chat-composer", title: "Chat composer" });
    expect(designComponentInstanceMark({ instances }, "inst-b", mainTitle)).toEqual({ component: "status-chip", title: "Status chip" });
  });

  it("never marks an ordinary layer, a part, an unknown component or an inherited name", () => {
    expect(designComponentInstanceMark({ instances }, "cc-send", mainTitle)).toBeNull();
    expect(designComponentInstanceMark({ instances }, designComponentPartNodeId("inst-a", "cc-send#1"), mainTitle)).toBeNull();
    expect(designComponentInstanceMark({ instances }, "inst-c", mainTitle)).toBeNull();
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect(designComponentInstanceMark({ instances }, name, mainTitle)).toBeNull();
    const mainOnly: { component: typeof component; instances?: typeof instances } = { component };
    expect(designComponentInstanceMark(mainOnly, "inst-a", mainTitle)).toBeNull();
    expect(designComponentInstanceMark({ instances }, null, mainTitle)).toBeNull();
  });
});
