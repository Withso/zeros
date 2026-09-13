import { describe, expect, it } from "vitest";

import { zerosCodeViewOptions, zerosDiffOptions } from "../diff-theme";

describe("file and diff overflow policy", () => {
  it("wraps PatchDiff content instead of creating a horizontal scroller", () => {
    expect(zerosDiffOptions().overflow).toBe("wrap");
  });

  it("wraps virtualized File/Changes content instead of creating a horizontal scroller", () => {
    expect(zerosCodeViewOptions().overflow).toBe("wrap");
  });

  it("keeps the rendered code and virtual scroll geometry flush with the pane", () => {
    const options = zerosCodeViewOptions({ disableFileHeader: true });
    expect(options.layout).toMatchObject({ paddingTop: 0, paddingBottom: 0 });
    expect(options.itemMetrics).toMatchObject({
      paddingTop: 0,
      paddingBottom: 0,
    });
    // Metrics alone do not remove the shadow DOM's independently painted gap.
    expect(options.unsafeCSS).toMatch(/--diffs-gap-block:\s*0px/);
  });

  it("keeps hover/Review PatchDiff chrome aligned with the Changes file viewer", () => {
    const patch = zerosDiffOptions({
      disableFileHeader: true,
      surface: "sidebar-bg",
    });
    const file = zerosCodeViewOptions({
      disableFileHeader: true,
      surface: "sidebar-bg",
    });

    expect(patch).toMatchObject({
      theme: file.theme,
      themeType: file.themeType,
      diffStyle: file.diffStyle,
      overflow: file.overflow,
      disableFileHeader: file.disableFileHeader,
    });
    expect(file.unsafeCSS).toContain(patch.unsafeCSS);
  });
});
