import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TreeRowView } from "../files-to-copy-section";

describe("TreeRowView", () => {
  it("paints keyboard focus on the folder disclosure", () => {
    const markup = renderToStaticMarkup(
      createElement(TreeRowView, {
        path: "packages",
        label: "packages",
        depth: 0,
        folder: true,
        branch: true,
        expanded: false,
        checked: false,
        locked: false,
        onToggle: () => {},
        onExpand: () => {},
      }),
    );

    const disclosure = markup.match(
      /<button[^>]*aria-expanded="false"[^>]*class="([^"]+)"/,
    );
    expect(disclosure?.[1]).toContain("focus-visible:ring-1");
    expect(disclosure?.[1]).toContain("focus-visible:ring-highlighted-bright");
  });
});
