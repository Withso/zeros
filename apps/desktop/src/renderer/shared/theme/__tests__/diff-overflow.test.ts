import { describe, expect, it } from "vitest";

import { zerosCodeViewOptions, zerosDiffOptions } from "../diff-theme";
import { changesDiffOptions } from "@/renderer/shell/workbench/tabs/changes-diff-options";

describe("file and diff overflow policy", () => {
  it("shares the Changes hunk chrome and row colors with expanded Edit cards", () => {
    const patch = zerosDiffOptions();
    const changes = changesDiffOptions({ diffStyle: "unified", codeThemeId: "github-dark" });
    for (const style of ["--diffs-bg-separator-override: var(--bg2)", "--diffs-bg-addition-override:", "--diffs-bg-deletion-override:", 'height: 24px']) {
      expect(patch.unsafeCSS).toContain(style);
      expect(changes.unsafeCSS).toContain(style);
    }
    expect(changes.itemMetrics?.hunkSeparatorHeight).toBe(24);
  });
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
