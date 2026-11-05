import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Slider } from "../slider";

describe("Slider", () => {
  it("names its thumb and says the value in words, as a range input does", () => {
    const markup = renderToStaticMarkup(
      createElement(Slider, {
        label: "Seek video",
        valueText: "0:12 of 1:30",
        min: 0,
        max: 90,
        value: [12],
      }),
    );
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-label="Seek video"');
    expect(markup).toContain('aria-valuetext="0:12 of 1:30"');
  });
});
