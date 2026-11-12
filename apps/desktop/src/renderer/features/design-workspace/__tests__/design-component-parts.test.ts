import { describe, expect, it } from "vitest";
import { designComponentPartNodeId } from "@zeros/protocol/design-runtime";
import {
  designComponentPartHost,
  designComponentTextLock,
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
