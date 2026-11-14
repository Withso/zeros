import { describe, expect, it } from "vitest";
import { designComponentPartNodeId } from "@zeros/protocol/design-runtime";
import {
  designComponentInstanceMark,
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

  it("refuses every part of an instance, and knows its host", () => {
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

  it("tells Layers which rows are instances and which are their read-only parts", () => {
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
