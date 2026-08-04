import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isElementActuallyVisible } from "../../zeros/utils/element-visibility";

describe("retained-surface visibility guards", () => {
  it("opts into CSS visibility so visibility:hidden suppresses work", () => {
    const checkVisibility = vi.fn(
      (options?: { visibilityProperty?: boolean }) =>
        options?.visibilityProperty !== true,
    );
    const element = { checkVisibility } as unknown as Element;

    expect(isElementActuallyVisible(element)).toBe(false);
    expect(checkVisibility).toHaveBeenCalledWith({
      visibilityProperty: true,
    });
  });

  it("routes every retained tick, poll, animation, and tokenizer through the guard", () => {
    const sources = [
      "src/loaders/live-duration.tsx",
      "src/loaders/run-horse-shimmer.tsx",
      "src/loaders/zeros-spinner.tsx",
      "src/shell/worktree-missing-panel.tsx",
      "src/shell/column3-tabs/code-editor/shiki-highlight.ts",
    ];
    for (const source of sources) {
      const text = readFileSync(resolve(process.cwd(), source), "utf8");
      expect(text, source).toContain("isElementActuallyVisible(");
      expect(text, source).not.toMatch(/\.checkVisibility\(\s*\)/);
    }
  });
});
