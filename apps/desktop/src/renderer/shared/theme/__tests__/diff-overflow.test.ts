import { describe, expect, it } from "vitest";

import { zerosCodeViewOptions, zerosDiffOptions } from "../diff-theme";

describe("file and diff overflow policy", () => {
  it("wraps PatchDiff content instead of creating a horizontal scroller", () => {
    expect(zerosDiffOptions().overflow).toBe("wrap");
  });

  it("wraps virtualized File/Changes content instead of creating a horizontal scroller", () => {
    expect(zerosCodeViewOptions().overflow).toBe("wrap");
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
      unsafeCSS: file.unsafeCSS,
      diffStyle: file.diffStyle,
      overflow: file.overflow,
      disableFileHeader: file.disableFileHeader,
    });
  });
});
