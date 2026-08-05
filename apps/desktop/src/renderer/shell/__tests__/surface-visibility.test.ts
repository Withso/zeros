import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isElementActuallyVisible } from "../../shared/lib/element-visibility";

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
      "apps/desktop/src/renderer/shared/ui/loading/live-duration.tsx",
      "apps/desktop/src/renderer/shared/ui/loading/run-horse-shimmer.tsx",
      "apps/desktop/src/renderer/shared/ui/loading/zeros-spinner.tsx",
      "apps/desktop/src/renderer/shell/worktree-missing-panel.tsx",
      "apps/desktop/src/renderer/shell/workbench/tabs/code-editor/shiki-highlight.ts",
    ];
    for (const source of sources) {
      const text = readFileSync(resolve(process.cwd(), source), "utf8");
      expect(text, source).toContain("isElementActuallyVisible(");
      expect(text, source).not.toMatch(/\.checkVisibility\(\s*\)/);
    }
  });
});
