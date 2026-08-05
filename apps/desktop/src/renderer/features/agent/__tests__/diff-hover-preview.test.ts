import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DIFF_HOVER_CONTENT_CLASS,
  DiffHoverPreview,
  hasTextualDiffHunk,
} from "../renderers/diff-hover-preview";

describe("hasTextualDiffHunk", () => {
  it("accepts modified, new-file, and deleted-file unified hunks", () => {
    expect(hasTextualDiffHunk("@@ -8,1 +8,1 @@\n-old\n+new\n")).toBe(true);
    expect(hasTextualDiffHunk("@@ -0,0 +1,2 @@\n+one\n+two\n")).toBe(true);
    expect(hasTextualDiffHunk("@@ -1,2 +0,0 @@\n-one\n-two\n")).toBe(true);
  });

  it("rejects empty, binary, and metadata-only patches", () => {
    expect(hasTextualDiffHunk("")).toBe(false);
    expect(
      hasTextualDiffHunk("Binary files a/logo.png and b/logo.png differ\n"),
    ).toBe(false);
    expect(
      hasTextualDiffHunk(
        "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
      ),
    ).toBe(false);
  });
});

describe("DiffHoverPreview layout contract", () => {
  it("keeps both hover-card callers at 450px wide and 350px tall", () => {
    expect(DIFF_HOVER_CONTENT_CLASS).toContain("w-[450px]");
    expect(DIFF_HOVER_CONTENT_CLASS).toContain("min(350px");
    expect(DIFF_HOVER_CONTENT_CLASS).toContain("--diff-hover-available-height");
    expect(DIFF_HOVER_CONTENT_CLASS).toContain("overflow-hidden");
  });

  it("uses a bg1 file header and a vertical-only compact scroll viewport", () => {
    const html = renderToStaticMarkup(
      createElement(DiffHoverPreview, {
        path: "src/long-file.ts",
        patch: "",
        showPath: true,
        compact: true,
      }),
    );

    expect(html).toContain("bg-bg1");
    expect(html).toContain("min(350px");
    expect(html).toContain("bg-sidebar-bg");
    expect(html).toContain("overflow-x-hidden");
    expect(html).toContain("overflow-y-auto");
  });
});
