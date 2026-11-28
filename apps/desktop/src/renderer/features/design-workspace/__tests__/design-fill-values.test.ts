import { describe, expect, it } from "vitest";

import {
  classifyDesignFill,
  formatDesignGradient,
  parseDesignGradient,
  parseEditableDesignGradient,
  readDesignImageUrl,
} from "../design-fill-values";

describe("design fill values", () => {
  it("classifies solid, gradient, and image fills", () => {
    expect(classifyDesignFill("none")).toBe("solid");
    expect(classifyDesignFill("linear-gradient(90deg, red, blue)")).toBe(
      "gradient",
    );
    expect(classifyDesignFill('url("./hero.png")')).toBe("image");
    expect(classifyDesignFill("repeating-conic-gradient(red, blue)")).toBe(
      "gradient",
    );
  });

  it("parses editable linear gradients without splitting functional colors", () => {
    expect(
      parseDesignGradient(
        "linear-gradient(135deg, rgba(1, 2, 3, 0.5) 0%, #ffffff 100%)", // check:ui ignore-line (authored CSS fixture)
      ),
    ).toEqual({
      type: "linear",
      angle: 135,
      start: "rgba(1, 2, 3, 0.5)", // check:ui ignore-line (authored CSS fixture)
      end: "#ffffff", // check:ui ignore-line (authored CSS fixture)
      startPosition: "0%",
      endPosition: "100%",
      startPositionAuthored: true,
      endPositionAuthored: true,
      repeating: false,
    });
    expect(
      formatDesignGradient({
        type: "linear",
        angle: 45,
        start: "red",
        end: "blue",
      }),
    ).toBe("linear-gradient(45deg, red 0%, blue 100%)");
  });

  it("round-trips keyword directions and repeating gradient intervals", () => {
    const keyword = parseDesignGradient("linear-gradient(to right, red, blue)");
    expect(keyword).toMatchObject({
      type: "linear",
      angle: 90,
      start: "red",
      end: "blue",
      repeating: false,
    });
    expect(formatDesignGradient(keyword!)).toBe(
      "linear-gradient(90deg, red 0%, blue 100%)",
    );

    const repeating = parseDesignGradient(
      "repeating-linear-gradient(to bottom right, red 0px, blue 24px)",
    );
    expect(repeating).toMatchObject({
      type: "linear",
      angle: 135,
      start: "red",
      end: "blue",
      startPosition: "0px",
      endPosition: "24px",
      repeating: true,
    });
    expect(formatDesignGradient(repeating!)).toBe(
      "repeating-linear-gradient(135deg, red 0px, blue 24px)",
    );
  });

  it("preserves a var() gradient angle and token stops across partial edits", () => {
    const parsed = parseDesignGradient(
      "linear-gradient(var(--gradient-angle), var(--accent), var(--success))",
    );
    expect(parsed).toMatchObject({
      angle: "var(--gradient-angle)",
      start: "var(--accent)",
      end: "var(--success)",
    });
    expect(formatDesignGradient({ ...parsed!, end: "#FFFFFF" })).toBe( // check:ui ignore-line -- authored CSS fixture
      "linear-gradient(var(--gradient-angle), var(--accent) 0%, #FFFFFF 100%)", // check:ui ignore-line -- authored CSS fixture
    );
    expect(formatDesignGradient({ ...parsed!, angle: 90 })).toBe(
      "linear-gradient(90deg, var(--accent) 0%, var(--success) 100%)",
    );
  });

  it("distinguishes a token angle from an unsupported third token stop", () => {
    expect(
      parseEditableDesignGradient(
        "linear-gradient(var(--accent), red, blue)",
        "linear-gradient(rgb(81, 81, 204) 0%, rgb(255, 0, 0) 50%, rgb(0, 0, 255) 100%)", // check:ui ignore-line -- CSSOM fixture
      ),
    ).toBeNull();
    expect(
      parseEditableDesignGradient(
        "linear-gradient(var(--gradient-angle), var(--accent), var(--success))",
        "linear-gradient(90deg, rgb(81, 81, 204) 0%, rgb(20, 122, 76) 100%)", // check:ui ignore-line -- CSSOM fixture
      ),
    ).toMatchObject({ angle: "var(--gradient-angle)" });
  });

  it("round-trips tokenized stop positions and multiline conic angles", () => {
    const repeating = parseDesignGradient(
      "repeating-linear-gradient(var(--gradient-angle), red 0px, blue var(--stop-end))",
    );
    expect(repeating).toMatchObject({
      angle: "var(--gradient-angle)",
      startPosition: "0px",
      endPosition: "var(--stop-end)",
    });
    expect(formatDesignGradient(repeating!)).toBe(
      "repeating-linear-gradient(var(--gradient-angle), red 0px, blue var(--stop-end))",
    );

    const conic = parseDesignGradient(
      "conic-gradient(from var(--gradient-angle,\n 90deg), red, blue)",
    );
    expect(conic?.angle).toBe("var(--gradient-angle,\n 90deg)");
  });

  it("keeps a commented color token as the stop color", () => {
    const parsed = parseDesignGradient(
      "linear-gradient(90deg, /* accent */ var(--accent), blue)",
    );
    expect(parsed).toMatchObject({
      start: "/* accent */ var(--accent)",
      startPosition: "0%",
    });
    expect(formatDesignGradient(parsed!)).toBe(
      "linear-gradient(90deg, /* accent */ var(--accent) 0%, blue 100%)",
    );
  });

  it("fails closed when a color token supplies hidden stop positions", () => {
    expect(
      parseEditableDesignGradient(
        "linear-gradient(90deg, /* accent */ var(--accent), blue)",
        "linear-gradient(90deg, rgb(81, 81, 204) 0%, rgb(81, 81, 204) 30%, rgb(81, 81, 204) 70%, rgb(0, 0, 255) 100%)", // check:ui ignore-line -- CSSOM fixture
      ),
    ).toBeNull();
    expect(
      parseEditableDesignGradient(
        "linear-gradient(90deg, /* accent */ var(--accent), blue)",
        "linear-gradient(90deg, rgb(81, 81, 204) 20%, rgb(0, 0, 255) 100%)", // check:ui ignore-line -- CSSOM fixture
      ),
    ).toBeNull();
  });

  it("fails closed for gradients the two-stop editor cannot preserve", () => {
    expect(
      parseDesignGradient("linear-gradient(red, yellow 50%, blue)"),
    ).toBeNull();
    expect(
      parseDesignGradient(
        "linear-gradient(in oklab, oklch(60% .2 20), oklch(70% .1 220))", // check:ui ignore-line (unsupported authored CSS fixture)
      ),
    ).toBeNull();
    expect(
      parseDesignGradient("linear-gradient(red 10% 20%, blue)"),
    ).toBeNull();
  });

  it("never formats a non-finite gradient angle into authored CSS", () => {
    expect(
      formatDesignGradient({
        type: "linear",
        angle: Number.NaN,
        start: "red",
        end: "blue",
      }),
    ).toBe("linear-gradient(180deg, red 0%, blue 100%)");
  });

  it("reads quoted and unquoted image URLs", () => {
    expect(readDesignImageUrl('url("./hero image.png")')).toBe(
      "./hero image.png",
    );
    expect(readDesignImageUrl("url(./hero.png)")).toBe("./hero.png");
  });
});
