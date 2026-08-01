import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Toolbar } from "../toolbar";

describe("Toolbar", () => {
  it("owns the elevated chrome and toolbar semantics", () => {
    const markup = renderToStaticMarkup(
      createElement(Toolbar, { "aria-label": "Canvas tools" }, "tools"),
    );

    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Canvas tools"');
    expect(markup).toContain("bg-bg2");
    expect(markup).toContain("shadow-[var(--shadow-xl)]");
  });
});
