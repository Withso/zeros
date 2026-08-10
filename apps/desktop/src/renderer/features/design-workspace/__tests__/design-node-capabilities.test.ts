import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { describe, expect, it } from "vitest";

import { canEditDesignNodeText } from "../design-node-capabilities";

function details(textEditable: boolean | undefined): DesignRuntimeNodeDetails {
  return {
    sourceVersion: "111111111111111111111111",
    oid: "node",
    tag: "div",
    name: "Node",
    text: "Hello",
    ...(textEditable === undefined ? {} : { textEditable }),
    selector: '[data-oid="node"]',
    visible: true,
    breadcrumb: ["div · Node"],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    styles: {},
  };
}

describe("design node capabilities", () => {
  it("offers text editing only when the runtime proves replacement is safe", () => {
    expect(canEditDesignNodeText(details(true))).toBe(true);
    expect(canEditDesignNodeText(details(false))).toBe(false);
    expect(canEditDesignNodeText(details(undefined))).toBe(false);
  });
});
