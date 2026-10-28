import { describe, expect, it } from "vitest";
import {
  DESIGN_RELOCATION_MAX_INHERITED_STYLES,
  designRelocationFlowStyles,
  designRelocationInheritedStyles,
  designRelocationStyles,
  type DesignRuntimeRelocationContext,
} from "../design-relocation";

// A label that takes the frame body's dark text and Georgia, inside a frame
// whose cards set white text (`.card { color: white }`).
const body = { color: "rgb(20, 20, 20)", "font-family": "Georgia" };
const label: DesignRuntimeRelocationContext = {
  inheritedStyles: { "font-size": "30px", "--accent": "red" },
  baseStyles: body,
  rootStyles: { "--accent": "" },
  unsupported: [],
};
const card: DesignRuntimeRelocationContext = {
  inheritedStyles: { color: "white", "--surface": "navy" },
  baseStyles: body,
  rootStyles: { "--surface": "snow" },
  unsupported: [],
};

describe("relocation inherited styles", () => {
  it("carries each value the drop parent does not already give the layer", () => {
    // The body's dark text equals the label's own, but the card would turn it
    // white; only Georgia, which the card also gives, stays behind.
    expect(designRelocationInheritedStyles(label, card)).toEqual({
      "font-size": "30px",
      "--accent": "red",
      color: "rgb(20, 20, 20)",
    });
  });

  it("does not carry the body's value for a property the layer sets itself", () => {
    const navy = { ...label, inheritedStyles: { color: "white" } };
    expect(designRelocationInheritedStyles(navy, card)).toEqual({});
  });

  it("keeps a custom property the parent sets at the root's value within one document", () => {
    const own = designRelocationInheritedStyles(label, card, true);
    expect(own["--surface"]).toBe("snow");
    // Another frame's root is not the layer's, so its value is unknown there.
    expect(designRelocationInheritedStyles(label, card)).not.toHaveProperty("--surface");
    // A root that sets none leaves the property unset under the parent too.
    const blank = { ...card, rootStyles: { "--surface": "" } };
    expect(designRelocationInheritedStyles(label, blank, true)["--surface"]).toBe("initial");
  });

  it("carries only the layer's own context into a new frame and everything into an unmeasured parent", () => {
    expect(designRelocationInheritedStyles(label)).toEqual({ "font-size": "30px", "--accent": "red" });
    expect(designRelocationInheritedStyles(label, null)).toEqual({
      "font-size": "30px",
      "--accent": "red",
      ...body,
    });
  });

  it("keeps the layer's own values first when the bound truncates", () => {
    const crowded: DesignRuntimeRelocationContext = {
      inheritedStyles: Object.fromEntries(
        Array.from({ length: DESIGN_RELOCATION_MAX_INHERITED_STYLES }, (_, index) => [`--own-${index}`, "1px"]),
      ),
      baseStyles: body,
      unsupported: [],
    };
    const carried = designRelocationInheritedStyles(crowded, null);
    expect(Object.keys(carried)).toHaveLength(DESIGN_RELOCATION_MAX_INHERITED_STYLES);
    expect(carried).not.toHaveProperty("color");
  });
});

describe("relocation placement", () => {
  it("places a layer by left and top, so its saved position is the X and Y a person reads", () => {
    // A translate in transform paints at the same place but reads as X 0, Y 0
    // and survives into auto layout as a stray offset.
    expect(designRelocationStyles({ width: 100, height: 80, matrix: [1, 0, 0, 1, 65.5, 223.25], inheritedStyles: {} })).toMatchObject({
      position: "absolute", left: "65.5px", top: "223.25px", width: "100px", height: "80px", transform: "none",
    });
  });

  it("keeps rotation, scale and reflection in the transform, about the layer's corner", () => {
    expect(designRelocationStyles({ width: 100, height: 80, matrix: [0, 2, -3, 0, 240, 0], inheritedStyles: { color: "navy" } })).toMatchObject({
      left: "240px", top: "0px", transform: "matrix(0,2,-3,0,0,0)", "transform-origin": "0 0", color: "navy",
    });
  });

  it("joins a flow slot with its appearance, size and rotation but no free-layout offset", () => {
    const styles = designRelocationFlowStyles(
      { width: 100, height: 80, matrix: [0, 1, -1, 0, 40, 60], inheritedStyles: { color: "navy" } },
      { position: "relative", left: "auto", top: "auto", right: "auto", bottom: "auto", order: "2", "flex-grow": "0" },
    );
    expect(styles).toMatchObject({
      color: "navy", position: "relative", inset: "auto", width: "100px", height: "80px",
      margin: "0", transform: "matrix(0,1,-1,0,0,0)", translate: "none", order: "2", "flex-grow": "0",
    });
    expect(Object.keys(styles).length).toBeLessThanOrEqual(64);
    expect(() => designRelocationFlowStyles({ width: 1, height: 1, matrix: [1, 0, 0, 1, 0, 0], inheritedStyles: {} }, { position: "absolute" })).toThrow(/flow/);
  });
});
