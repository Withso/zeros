import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TruncateStart } from "../truncate-start";

describe("TruncateStart", () => {
  it("moves the overflow to the start while the text keeps its order", () => {
    const markup = renderToStaticMarkup(
      createElement(TruncateStart, { className: "text-fg3" }, ".github/workflows"),
    );
    expect(markup).toBe(
      '<span data-slot="truncate-start" dir="rtl" class="min-w-0 truncate text-left text-fg3"><bdi dir="ltr">.github/workflows</bdi></span>',
    );
  });
});
