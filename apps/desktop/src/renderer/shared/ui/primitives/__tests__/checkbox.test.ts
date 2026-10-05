import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Checkbox } from "../checkbox";

describe("Checkbox", () => {
  it("paints keyboard focus on the visible box", () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, {
        checked: false,
        onChange: () => {},
        "aria-label": "Copy .env",
      }),
    );

    expect(markup).toContain("peer");
    expect(markup).toContain("peer-focus-visible:ring-[3px]");
    expect(markup).toContain("peer-focus-visible:ring-highlighted-bright/50");
    // Opaque focus core under the halo.
    expect(markup).toContain("peer-focus-visible:border-highlighted-bright");
  });

  it("outlines the unchecked box with the subtle border4 recipe", () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, {
        checked: false,
        onChange: () => {},
        "aria-label": "Copy .env",
      }),
    );

    expect(markup).toContain("border-border4");
  });
});
