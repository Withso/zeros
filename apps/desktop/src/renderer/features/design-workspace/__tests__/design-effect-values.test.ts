import { describe, expect, it } from "vitest";

import {
  defaultDesignShadow,
  designEffectEntries,
  designEffectKindAvailable,
  designEffectLabel,
  designEffectsAdd,
  designEffectsChangeKind,
  designEffectsRemove,
  designEffectsUpdateBlur,
  designRawEffectFilters,
  isDesignShadowListEditable,
  formatDesignBlurFilter,
  formatDesignShadow,
  formatDesignShadowList,
  formatDesignTransform,
  parseDesignBlurFilter,
  parseDesignShadow,
  parseDesignShadowList,
  parseDesignTransform,
} from "../design-effect-values";

describe("design effect values", () => {
  it("parses and formats editable box and text shadows", () => {
    expect(
      parseDesignShadow("inset 4px 8px 16px 2px rgba(1, 2, 3, 0.5)"), // check:ui ignore-line (authored CSS fixture)
    ).toEqual({
      inset: true,
      x: 4,
      y: 8,
      blur: 16,
      spread: 2,
      color: "rgba(1, 2, 3, 0.5)", // check:ui ignore-line (authored CSS fixture)
    });
    expect(
      formatDesignShadow({
        inset: false,
        x: 0,
        y: 6,
        blur: 24,
        spread: 0,
        color: "#00000040", // check:ui ignore-line (authored CSS fixture)
      }),
    ).toBe("0px 6px 24px 0px #00000040"); // check:ui ignore-line (authored CSS fixture)
  });

  it("decomposes common transform functions and 2D matrices", () => {
    expect(
      parseDesignTransform(
        "translateX(12px) translateY(-4px) rotate(30deg) scale(1.2, 0.8)",
      ),
    ).toMatchObject({ x: 12, y: -4, rotate: 30, scaleX: 1.2, scaleY: 0.8 });
    expect(parseDesignTransform("matrix(0, 1, -1, 0, 20, 30)")).toMatchObject({
      x: 20,
      y: 30,
      rotate: 90,
      scaleX: 1,
      scaleY: 1,
    });
    expect(
      parseDesignTransform("matrix(1, 0, 0, 1, 1e-7, -2E+3)"),
    ).toMatchObject({ x: 0.0000001, y: -2_000 });
    expect(
      formatDesignTransform({
        x: 12,
        y: -4,
        rotate: 30,
        scaleX: 1.2,
        scaleY: 0.8,
        skewX: 0,
        skewY: 0,
      }),
    ).toBe("translate(12px, -4px) rotate(30deg) scale(1.2, 0.8)");
  });

  it("preserves authored length and angle units across structured edits", () => {
    expect(
      formatDesignTransform(
        parseDesignTransform(
          "translate(-50%, -2rem) rotate(0.25turn) skew(0.5rad, 10grad)",
        ),
      ),
    ).toBe("translate(-50%, -2rem) rotate(0.25turn) skew(0.5rad, 10grad)");
  });

  it("keeps unsupported or order-sensitive transforms in raw CSS mode", () => {
    for (const value of [
      "perspective(20rem) rotateX(0.25turn)",
      "rotate(0.25turn) translate(-50%, -50%)",
    ]) {
      const parsed = parseDesignTransform(value);
      expect(parsed.raw).toBe(value);
      expect(formatDesignTransform(parsed)).toBe(value);
    }
  });

  it("round-trips every shadow in a list without splitting color functions", () => {
    const shadows = parseDesignShadowList(
      "0px 4px 4px 0px rgba(0, 0, 0, 0.25), inset 1px 2px 3px 4px #fff", // check:ui ignore-line (authored CSS fixture)
    );
    expect(shadows).toHaveLength(2);
    expect(shadows[0]).toMatchObject({ inset: false, y: 4, blur: 4 });
    expect(shadows[1]).toMatchObject({ inset: true, x: 1, spread: 4 });
    expect(formatDesignShadowList(shadows)).toBe(
      "0px 4px 4px 0px rgba(0, 0, 0, 0.25), inset 1px 2px 3px 4px #fff", // check:ui ignore-line (authored CSS fixture)
    );
    expect(parseDesignShadowList("none")).toEqual([]);
    expect(formatDesignShadowList([])).toBe("none");
    expect(formatDesignShadowList([defaultDesignShadow()], false)).toBe(
      "0px 4px 4px rgb(0 0 0 / 0.25)", // check:ui ignore-line (authored CSS fixture)
    );
  });

  it("maps only a single blur() filter onto a blur effect", () => {
    expect(parseDesignBlurFilter("blur(12px)")).toBe(12);
    expect(parseDesignBlurFilter(" blur( 4 ) ")).toBe(4);
    expect(parseDesignBlurFilter("blur(4px) brightness(2)")).toBeNull();
    expect(parseDesignBlurFilter("none")).toBeNull();
    expect(formatDesignBlurFilter(-2)).toBe("blur(0px)");
    expect(formatDesignBlurFilter(7.25)).toBe("blur(7.25px)");
  });
});

describe("design effects list", () => {
  const empty = {
    boxShadow: "none",
    textShadow: "none",
    filter: "none",
    backdropFilter: "none",
  };

  it("lists shadows and single-blur filters as effect rows", () => {
    const entries = designEffectEntries(
      {
        boxShadow: "0px 4px 4px 0px #000, inset 0px 1px 2px 0px #fff", // check:ui ignore-line (authored CSS fixture)
        textShadow: "none",
        filter: "blur(8px)",
        backdropFilter: "saturate(2)",
      },
      false,
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "drop-shadow",
      "inner-shadow",
      "layer-blur",
    ]);
    expect(entries[2]?.radius).toBe(8);
    expect(
      designRawEffectFilters({ ...empty, backdropFilter: "saturate(2)" }),
    ).toEqual({
      boxShadow: false,
      textShadow: false,
      filter: false,
      backdropFilter: true,
    });
    expect(
      designEffectLabel(
        { kind: "drop-shadow", property: "text-shadow" },
        false,
      ),
    ).toBe("Text shadow");
    expect(
      designEffectLabel({ kind: "drop-shadow", property: "text-shadow" }, true),
    ).toBe("Drop shadow");
  });

  it("adds Figma's default drop shadow onto the box or, for text, the glyphs", () => {
    expect(designEffectsAdd(empty, false)).toEqual({
      "box-shadow": "0px 4px 4px 0px rgb(0 0 0 / 0.25)", // check:ui ignore-line (authored CSS fixture)
    });
    expect(designEffectsAdd(empty, true)).toEqual({
      "text-shadow": "0px 4px 4px rgb(0 0 0 / 0.25)", // check:ui ignore-line (authored CSS fixture)
    });
  });

  it("removes, updates and retypes one entry without touching the others", () => {
    const state = {
      ...empty,
      boxShadow: "0px 1px 2px 0px #111, 0px 3px 4px 0px #222", // check:ui ignore-line (authored CSS fixture)
    };
    const [first, second] = designEffectEntries(state, false);
    expect(designEffectsRemove(state, first!)).toEqual({
      "box-shadow": "0px 3px 4px 0px #222", // check:ui ignore-line (authored CSS fixture)
    });
    expect(
      designEffectsChangeKind(state, second!, "inner-shadow", false),
    ).toEqual({
      "box-shadow": "0px 1px 2px 0px #111, inset 0px 3px 4px 0px #222", // check:ui ignore-line (authored CSS fixture)
    });
    expect(designEffectsChangeKind(state, first!, "layer-blur", false)).toEqual(
      {
        "box-shadow": "0px 3px 4px 0px #222", // check:ui ignore-line (authored CSS fixture)
        filter: "blur(4px)",
      },
    );
    const blurred = { ...empty, filter: "blur(6px)" };
    const [blur] = designEffectEntries(blurred, false);
    expect(
      designEffectsChangeKind(blurred, blur!, "background-blur", false),
    ).toEqual({
      filter: "none",
      "backdrop-filter": "blur(6px)",
    });
    expect(designEffectsUpdateBlur(blur!, 10)).toEqual({
      filter: "blur(10px)",
    });
    expect(
      designEffectKindAvailable(
        { ...blurred, backdropFilter: "saturate(2)" },
        blur!,
        "background-blur",
      ),
    ).toBe(false);
  });

  it("keeps shadows the structured editor cannot round-trip as raw CSS", () => {
    expect(isDesignShadowListEditable("0 4px 8px var(--shadow-color)")).toBe(
      true,
    );
    expect(isDesignShadowListEditable("inset 0 0 0 1px #000")).toBe(true); // check:ui ignore-line (authored CSS fixture)
    expect(isDesignShadowListEditable("var(--elevation)")).toBe(false);
    expect(isDesignShadowListEditable("0 calc(2px + 1px) 4px red")).toBe(false);
    expect(isDesignShadowListEditable("0 0.5rem 1rem red")).toBe(false);
    const state = {
      ...empty,
      boxShadow: "var(--elevation)",
    };
    expect(designEffectEntries(state, false)).toEqual([]);
    expect(designRawEffectFilters(state).boxShadow).toBe(true);
  });
});
