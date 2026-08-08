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

  it("reads quoted and unquoted image URLs", () => {
    expect(readDesignImageUrl('url("./hero image.png")')).toBe(
      "./hero image.png",
    );
    expect(readDesignImageUrl("url(./hero.png)")).toBe("./hero.png");
  });
});
