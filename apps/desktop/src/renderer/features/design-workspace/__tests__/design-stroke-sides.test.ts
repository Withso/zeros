import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import { designStrokeSideStyles, designStrokeSides } from "../design-stroke-editor";

const layer = (widths: [string, string, string, string]) =>
  ({
    styles: {
      borderTopWidth: widths[0],
      borderRightWidth: widths[1],
      borderBottomWidth: widths[2],
      borderLeftWidth: widths[3],
    },
  }) as unknown as DesignRuntimeNodeDetails;

describe("stroke sides", () => {
  it("reads All, one side, or Custom from the four widths", () => {
    expect(designStrokeSides(layer(["1px", "1px", "1px", "1px"]))).toBe("all");
    expect(designStrokeSides(layer(["0px", "0px", "2px", "0px"]))).toBe("bottom");
    expect(designStrokeSides(layer(["1px", "2px", "1px", "2px"]))).toBe("custom");
  });

  it("writes the chosen side at the stroke's weight and clears the others", () => {
    expect(designStrokeSideStyles("all", "2px")).toEqual({ "border-width": "2px" });
    expect(designStrokeSideStyles("top", "2px")).toEqual({
      "border-top-width": "2px",
      "border-right-width": "0px",
      "border-bottom-width": "0px",
      "border-left-width": "0px",
    });
  });
});
