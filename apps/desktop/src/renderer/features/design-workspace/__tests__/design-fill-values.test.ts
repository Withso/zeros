import { describe, expect, it } from "vitest";

import {
  classifyDesignFill,
  formatDesignGradient,
  parseDesignGradient,
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

  it("reads quoted and unquoted image URLs", () => {
    expect(readDesignImageUrl('url("./hero image.png")')).toBe(
      "./hero image.png",
    );
    expect(readDesignImageUrl("url(./hero.png)")).toBe("./hero.png");
  });
});
