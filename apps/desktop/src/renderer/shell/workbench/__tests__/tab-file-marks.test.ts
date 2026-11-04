import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TabFileMarks } from "../tab-file-marks";

describe("TabFileMarks", () => {
  it("names the status letter and unsaved dot, and explains both on hover like the tree", () => {
    const markup = renderToStaticMarkup(
      createElement(TabFileMarks, { fileStatus: "modified", dirty: true }),
    );
    expect(markup).toMatch(
      /<span role="img" aria-label="Modified" title="Modified"[^>]*>M<\/span>/,
    );
    expect(markup).toMatch(
      /<span role="img" aria-label="Unsaved changes" title="Unsaved changes"/,
    );
  });

  it("draws nothing for a clean tracked file", () => {
    expect(
      renderToStaticMarkup(createElement(TabFileMarks, { dirty: false })),
    ).toBe("");
  });
});
