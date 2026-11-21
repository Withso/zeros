import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editorLineNumberColor } from "../theme";

describe("editor line numbers", () => {
  it("match the Diff view's line numbers on the same surface", () => {
    const pierreStyle = readFileSync(join(process.cwd(), "node_modules/@pierre/diffs/dist/style.js"), "utf8");
    // Pierre's own rule; Zeros sets no --diffs-fg-number-override.
    expect(pierreStyle).toContain("color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg))");
    expect(readFileSync(join(__dirname, "../../../../../shared/theme/diff-theme.ts"), "utf8")).not.toContain("--diffs-fg-number-override");
    expect(editorLineNumberColor("var(--theme-fg)")).toBe("color-mix(in lab, var(--theme-fg) 65%, var(--bg1))");
    expect(editorLineNumberColor(null)).toBe("color-mix(in lab, var(--fg1) 65%, var(--bg1))");
  });
});
