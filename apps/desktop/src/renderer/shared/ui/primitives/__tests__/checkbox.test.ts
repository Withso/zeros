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
    // One accent line a pixel off the box, so it shows around the accent fill.
    expect(markup).toContain("peer-focus-visible:outline-1");
    expect(markup).toContain("peer-focus-visible:outline-offset-1");
    expect(markup).toContain("peer-focus-visible:outline-accent");
    expect(markup).not.toContain("peer-focus-visible:ring-[3px]");
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
