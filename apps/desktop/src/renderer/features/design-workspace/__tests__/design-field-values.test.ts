import { describe, expect, it } from "vitest";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  convertDesignLength,
  designAuthoredLength,
  designLengthBasis,
  designLengthUnitOptions,
  designMixedScrubValues,
  designStyleFieldRefusal,
  evaluateDesignNumericExpression,
  normalizeDesignStyleFieldInput,
} from "../design-style-values";

describe("maths in a field", () => {
  it("works out an expression in the value's own unit", () => {
    expect(evaluateDesignNumericExpression("24*2", "330px")).toEqual({ value: "48px" });
    expect(evaluateDesignNumericExpression("+8", "330px")).toEqual({ value: "338px" });
    expect(evaluateDesignNumericExpression("330+12", "330px")).toEqual({ value: "342px" });
    expect(evaluateDesignNumericExpression("x/2", "50%")).toEqual({ value: "25%" });
  });

  it("takes the one unit written in it, so 50%/2 switches to percent", () => {
    expect(evaluateDesignNumericExpression("50%/2", "100px")).toEqual({ value: "25%" });
    expect(evaluateDesignNumericExpression("10px*3", "2rem")).toEqual({ value: "30px" });
    expect(evaluateDesignNumericExpression("x+10px", "20px")).toEqual({ value: "30px" });
  });

  it("refuses mixed units and division by zero", () => {
    expect(evaluateDesignNumericExpression("10px+1rem", "0px")).toEqual({ refused: "mixed-units" });
    expect(evaluateDesignNumericExpression("x+10%", "100px")).toEqual({ refused: "mixed-units" });
    expect(evaluateDesignNumericExpression("100/0", "1px")).toEqual({ refused: "division" });
    expect(evaluateDesignNumericExpression("x/(2-2)", "8px")).toEqual({ refused: "division" });
  });

  it("leaves plain values and CSS functions for the field to judge", () => {
    expect(evaluateDesignNumericExpression("18px", "24px")).toBeNull();
    expect(evaluateDesignNumericExpression("auto", "24px")).toBeNull();
    expect(evaluateDesignNumericExpression("calc(100% - 4px)", "24px")).toBeNull();
    expect(evaluateDesignNumericExpression("", "24px")).toBeNull();
    // A leading minus on a bare number is the value, not x minus it.
    expect(evaluateDesignNumericExpression("-5", "24px")).toEqual({ value: "-5px" });
  });
});

describe("values CSS rejects", () => {
  it("refuses a negative only where CSS does", () => {
    for (const property of ["width", "padding-top", "gap", "border-radius", "font-size", "border-top-width", "transition-duration"])
      expect(designStyleFieldRefusal(property, "-10px"), property).toBe("negative");
    for (const property of ["margin-top", "left", "letter-spacing", "z-index", "text-indent", "rotate"])
      expect(designStyleFieldRefusal(property, "-10px"), property).toBeNull();
    expect(designStyleFieldRefusal("padding", "4px -2px")).toBe("negative");
    expect(designStyleFieldRefusal("width", "calc(100% - 20px)")).toBeNull();
    expect(designStyleFieldRefusal("width", "0px")).toBeNull();
  });

  it("keeps a typed negative for the field to refuse rather than settling on zero", () => {
    expect(normalizeDesignStyleFieldInput("width", "-40", "330px")).toBe("-40px");
    expect(normalizeDesignStyleFieldInput("padding-top", "x-30", "20px")).toBe("-10px");
  });
});

describe("unit conversion", () => {
  const basis = { percent: 400, rem: 16, em: 20 };

  it("converts the value, not just its unit", () => {
    expect(convertDesignLength("12px", "%", basis)).toBe("3%");
    expect(convertDesignLength("12px", "rem", basis)).toBe("0.75rem");
    expect(convertDesignLength("3%", "px", basis)).toBe("12px");
    expect(convertDesignLength("0.75rem", "%", basis)).toBe("3%");
    expect(convertDesignLength("2em", "px", basis)).toBe("40px");
    expect(convertDesignLength("10px", "px", basis)).toBe("10px");
  });

  it("rounds percent and rem to two decimals, and px to a whole number in a whole field", () => {
    expect(convertDesignLength("10px", "%", { percent: 300 })).toBe("3.33%");
    expect(convertDesignLength("10px", "rem", { rem: 12 })).toBe("0.83rem");
    expect(convertDesignLength("3.33%", "px", { percent: 300 }, { whole: true })).toBe("10px");
    expect(convertDesignLength("3.33%", "px", { percent: 300 })).toBe("9.99px");
  });

  it("does not convert without a basis or a number", () => {
    expect(convertDesignLength("12px", "%", {})).toBeNull();
    expect(convertDesignLength("3%", "px", { rem: 16 })).toBeNull();
    expect(convertDesignLength("auto", "px", basis)).toBeNull();
    expect(convertDesignLength("12px", "auto", basis)).toBe("auto");
  });

  it("offers px, percent and rem only with a basis, the authored unit, and Auto where CSS takes it", () => {
    expect(designLengthUnitOptions("width", "px", { percent: 400, rem: 16 })).toEqual(["px", "%", "rem"]);
    expect(designLengthUnitOptions("width", "px", { rem: 16 })).toEqual(["px", "rem"]);
    expect(designLengthUnitOptions("width", "vw", { rem: 16 })).toEqual(["px", "rem", "vw"]);
    expect(designLengthUnitOptions("margin-top", "px", { percent: 400, rem: 16 })).toEqual(["px", "%", "rem", "auto"]);
    expect(designLengthUnitOptions("padding-top", "px", { percent: 400, rem: 16 })).not.toContain("auto");
    // Border widths take no percent at all.
    expect(designLengthUnitOptions("border-top-width", "px", { percent: 400, rem: 16 })).toEqual(["px", "rem"]);
    // Durations keep their own units.
    expect(designLengthUnitOptions("transition-duration", "ms", {})).toEqual(["ms", "s"]);
  });
});

describe("a Mixed scrub", () => {
  const layer = (nodeId: string, value: string) => ({ nodeId, value });

  it("moves each layer by the same step from its own value, in its own unit", () => {
    const result = designMixedScrubValues("padding-top", [layer("a", "8px"), layer("b", "12px"), layer("c", "1rem")], 3, { whole: false });
    expect(result.values).toEqual({ a: "11px", b: "15px", c: "4rem" });
    expect(result.skipped).toEqual([]);
  });

  it("leaves out a layer with no number, and stops a non-negative property at zero", () => {
    const result = designMixedScrubValues("width", [layer("a", "10px"), layer("b", "auto"), layer("c", "calc(100% - 4px)")], -20, { whole: true });
    expect(result.values).toEqual({ a: "0px" });
    expect(result.skipped).toEqual(["b", "c"]);
  });

  it("uses each layer's own fine step where decimals apply", () => {
    const result = designMixedScrubValues("line-height", [layer("a", "1.5"), layer("b", "20px")], 2, { whole: false });
    expect(result.values).toEqual({ a: "1.7", b: "22px" });
  });
});

describe("a field's units, from the layer's details", () => {
  const layer = (extra: Partial<DesignRuntimeNodeDetails> = {}): DesignRuntimeNodeDetails => ({
    sourceVersion: "a".repeat(24), oid: "card", tag: "div", name: "Card", text: null, selector: '[data-oid="card"]',
    visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 200, height: 100 },
    styles: { fontSize: "20px", width: "200px", paddingLeft: "12px" },
    rootFontSize: 16,
    layout: { x: 0, y: 0, parentId: "p", parentWidth: 440, parentHeight: 320, parentDisplay: "block", parentPosition: "relative", isContainingBlock: true, percentBasis: { width: 400 } },
    ...extra,
  });

  it("shows a length as written when it is a plain number with a unit", () => {
    const node = layer({ authoredStyles: {
      width: { origin: "inline", scope: "inline", value: "50%" },
      "padding-left": { origin: "frame", selector: ".card", scope: "element", value: "1rem" },
      "line-height": { origin: "frame", selector: ".card", scope: "element", value: "1.5" },
      height: { origin: "frame", selector: ".card", scope: "element", value: "calc(100% - 4px)" },
      gap: { origin: "frame", selector: ".card", scope: "element", value: "var(--space-4)" },
    } });
    expect(designAuthoredLength(node, "width")).toBe("50%");
    expect(designAuthoredLength(node, "padding-left")).toBe("1rem");
    expect(designAuthoredLength(node, "line-height")).toBeNull();
    expect(designAuthoredLength(node, "height")).toBeNull();
    expect(designAuthoredLength(node, "gap")).toBeNull();
    expect(designAuthoredLength(layer(), "width")).toBeNull();
  });

  it("measures percent against what CSS resolves it against, and rem and em against the fonts", () => {
    expect(designLengthBasis(layer(), "width", "200px")).toEqual({ percent: 400, rem: 16, em: 20 });
    expect(designLengthBasis(layer(), "padding-top", "8px")).toEqual({ percent: 400, rem: 16, em: 20 });
    // In flow a percentage height has no definite basis.
    expect(designLengthBasis(layer(), "height", "100px").percent).toBeUndefined();
    expect(designLengthBasis(layer({ layout: { ...layer().layout!, percentBasis: { width: 440, height: 320 } } }), "top", "0px").percent).toBe(320);
    // A radius resolves against the layer's own box, two ways.
    expect(designLengthBasis(layer(), "border-radius", "4px").percent).toBeUndefined();
    expect(designLengthBasis(layer({ layout: undefined }), "width", "200px").percent).toBeUndefined();
    expect(designLengthBasis(layer({ rootFontSize: undefined }), "width", "200px").rem).toBeUndefined();
  });

  it("derives a font size's parent from the ratio it is written in, or offers no em or percent", () => {
    expect(designLengthBasis(layer(), "font-size", "1.25em")).toEqual({ percent: 16, rem: 16, em: 16 });
    expect(designLengthBasis(layer(), "font-size", "125%")).toEqual({ percent: 16, rem: 16, em: 16 });
    expect(designLengthBasis(layer(), "font-size", "20px")).toEqual({ rem: 16 });
  });
});
