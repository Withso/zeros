import { describe, expect, it } from "vitest";

import {
  designStyleFieldValue,
  isDesignRuntimeStylePropertyAuthored,
  resolveDesignNumericExpression,
  scrubDesignNumericValue,
  parseDesignCssDeclarations,
  readDesignComputedStyle,
  serializeDesignCssDeclarations,
  withDesignPositionContext,
} from "../design-style-values";

describe("design style values", () => {
  it("reads kebab-case properties from the runtime's camel-case snapshot", () => {
    expect(
      readDesignComputedStyle(
        { backgroundColor: "rgb(1, 2, 3)", "--Accent": "red" }, // check:ui ignore-line (CSSOM fixture)
        "background-color",
      ),
    ).toBe("rgb(1, 2, 3)"); // check:ui ignore-line (CSSOM fixture)
    expect(readDesignComputedStyle({ "--Accent": "red" }, "--Accent")).toBe(
      "red",
    );
  });

  it("matches authored runtime keys to kebab-case inspector properties", () => {
    expect(
      isDesignRuntimeStylePropertyAuthored(
        ["marginRight", "backgroundColor"],
        "margin-right",
      ),
    ).toBe(true);
    expect(
      isDesignRuntimeStylePropertyAuthored(["marginRight"], "margin-left"),
    ).toBe(false);
  });

  it("expands authored shorthands and logical declarations into inspector fields", () => {
    expect(
      isDesignRuntimeStylePropertyAuthored(["padding"], "padding-top"),
    ).toBe(true);
    expect(
      isDesignRuntimeStylePropertyAuthored(["margin"], "margin-left"),
    ).toBe(true);
    expect(
      isDesignRuntimeStylePropertyAuthored(["padding-inline"], "padding-right"),
    ).toBe(true);
    expect(
      isDesignRuntimeStylePropertyAuthored(["border"], "border-width"),
    ).toBe(true);
    expect(isDesignRuntimeStylePropertyAuthored(["all"], "margin-bottom")).toBe(
      true,
    );
    for (const [authored, inspected] of [
      ["inset", "left"],
      ["background", "background-image"],
      ["font", "line-height"],
      ["flex", "flex-basis"],
      ["gap", "row-gap"],
      ["place-items", "justify-items"],
      ["transition", "transition-duration"],
      ["animation", "animation-name"],
      ["border-top-width", "border-width"],
    ] as const) {
      expect(
        isDesignRuntimeStylePropertyAuthored([authored], inspected),
        `${authored} should affect ${inspected}`,
      ).toBe(true);
    }
    expect(
      isDesignRuntimeStylePropertyAuthored(["background"], "mix-blend-mode"),
    ).toBe(false);
    expect(
      isDesignRuntimeStylePropertyAuthored(["font"], "letter-spacing"),
    ).toBe(false);
    expect(isDesignRuntimeStylePropertyAuthored(["all"], "direction")).toBe(
      false,
    );
    expect(
      isDesignRuntimeStylePropertyAuthored(["all"], "--component-accent"),
    ).toBe(false);
  });

  it("shows only authored values and leaves untouched fields neutral", () => {
    expect(
      designStyleFieldValue(["margin-right"], "margin-right", "50px"),
    ).toBe("50px");
    expect(designStyleFieldValue(["padding"], "padding-top", "10px")).toBe(
      "10px",
    );
    expect(designStyleFieldValue([], "padding-left", "0px")).toBe("");
    expect(designStyleFieldValue(undefined, "z-index", "auto")).toBe("");
    expect(designStyleFieldValue(undefined, "padding-top", "10px")).toBe(
      "10px",
    );
    expect(designStyleFieldValue(undefined, "margin-right", "0px")).toBe("");
  });

  it("parses a bounded declaration paste without splitting functions", () => {
    expect(
      parseDesignCssDeclarations(`
        color: color-mix(in srgb, var(--accent) 80%, white);
        transform: translate(12px, 4px) scale(1.05);
        background-image: linear-gradient(90deg, red 0%, blue 100%);
      `),
    ).toEqual({
      color: "color-mix(in srgb, var(--accent) 80%, white)",
      transform: "translate(12px, 4px) scale(1.05)",
      "background-image": "linear-gradient(90deg, red 0%, blue 100%)",
    });
  });

  it("round-trips declarations and rejects nested rules", () => {
    const declarations = { color: "red", "padding-inline": "8px 12px" };
    expect(
      parseDesignCssDeclarations(serializeDesignCssDeclarations(declarations)),
    ).toEqual(declarations);
    expect(() =>
      parseDesignCssDeclarations("color:red; &:hover { color: blue; }"),
    ).toThrow("Nested CSS");
  });

  it("scrubs numeric CSS values while preserving units", () => {
    expect(scrubDesignNumericValue("12px", 3.5)).toBe("15.5px");
    expect(scrubDesignNumericValue("0.75", -0.25)).toBe("0.5");
    expect(scrubDesignNumericValue("auto", 10)).toBeNull();
  });

  it("resolves field equations against the focused baseline", () => {
    expect(resolveDesignNumericExpression("+10", "24px")).toBe("34px");
    expect(resolveDesignNumericExpression("*2", "24px")).toBe("48px");
    expect(resolveDesignNumericExpression("(x / 2) + 6", "24px")).toBe("18px");
    expect(resolveDesignNumericExpression("18px", "24px")).toBe("18px");
  });

  it("makes authored offsets effective for statically positioned elements", () => {
    expect(withDesignPositionContext({ left: "12px" }, "static")).toEqual({
      position: "relative",
      left: "12px",
    });
    expect(withDesignPositionContext({ top: null }, "static")).toEqual({
      position: "relative",
      top: null,
    });
    expect(withDesignPositionContext({ width: "12px" }, "static")).toEqual({
      width: "12px",
    });
    expect(withDesignPositionContext({ left: "12px" }, "absolute")).toEqual({
      left: "12px",
    });
    expect(
      withDesignPositionContext({ position: "fixed", left: "12px" }, "static"),
    ).toEqual({ position: "fixed", left: "12px" });
  });
});
