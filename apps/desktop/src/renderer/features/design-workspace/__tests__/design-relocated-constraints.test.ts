import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { designLayoutActionStyles } from "../design-layout-values";

function stretchedNode(): DesignRuntimeNodeDetails {
  // The authored source has auto width/height with both opposing insets.
  // Computed styles report the used size. The stretch hints are the normal
  // inspector constraint contract; translate must not change that size.
  return {
    sourceVersion: "a".repeat(24), oid: "child", tag: "div", name: "Child",
    text: null, selector: '[data-oid="child"]', visible: true, breadcrumb: [],
    rect: { x: 50, y: 50, width: 100, height: 60 },
    layout: { x: 40, y: 30, parentId: "parent", parentWidth: 400, parentHeight: 300,
      parentDisplay: "block", parentPosition: "relative", isContainingBlock: true },
    styles: {
      position: "absolute", left: "40px", right: "260px", top: "30px", bottom: "210px",
      width: "100px", height: "60px", boxSizing: "border-box",
      transform: "matrix(1,0,0,1,10,20)", transformOrigin: "0px 0px",
      "--zeros-layout-x": "stretch", "--zeros-layout-y": "stretch",
    },
  };
}

describe("relocated stretched constraints", () => {
  it("keeps a vertically stretched child's height when editing only X", () => {
    const details = stretchedNode();
    const updates = designLayoutActionStyles(details, { type: "position", axis: "x", value: 80 });
    const top = Number.parseFloat(updates.top ?? details.styles.top!);
    const bottom = Number.parseFloat(updates.bottom ?? details.styles.bottom!);
    expect(updates.transform).toBe("none");
    expect(top).toBe(50);
    expect(details.layout!.parentHeight - top - bottom).toBe(details.rect.height);
  });

  it("keeps a horizontally stretched child's width when editing only Y", () => {
    const details = stretchedNode();
    const updates = designLayoutActionStyles(details, { type: "position", axis: "y", value: 80 });
    const left = Number.parseFloat(updates.left ?? details.styles.left!);
    const right = Number.parseFloat(updates.right ?? details.styles.right!);
    expect(updates.transform).toBe("none");
    expect(left).toBe(50);
    expect(details.layout!.parentWidth - left - right).toBe(details.rect.width);
  });
});
