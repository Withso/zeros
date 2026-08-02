import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Pill } from "../pill";

describe("Pill", () => {
  it("is a compact native button with visible keyboard focus", () => {
    const markup = renderToStaticMarkup(
      createElement(Pill, { "aria-label": "App resources" }, "1.24 GB"),
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("h-7");
    expect(markup).toContain("focus-visible:ring-[3px]");
    expect(markup).toContain("1.24 GB");
  });
});
