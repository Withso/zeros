import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Every Select list is end-aligned and column-bounded by DEFAULT — the
 *  primitive owns that, so no caller has to remember it. Guarded as a source
 *  contract because the behavior is only observable in a real layout. */
const source = readFileSync(
  "apps/desktop/src/renderer/shared/ui/primitives/select.tsx",
  "utf8",
);

describe("Select popover placement defaults", () => {
  it("end-aligns the list to the trigger", () => {
    expect(source).toMatch(/align = "end",/);
  });

  it("bounds the list by the trigger's layout column, caller override first", () => {
    expect(source).toContain("resolvePopoverBoundary(anchor?.triggerRef.current)");
    expect(source).toContain(
      "collisionBoundary={collisionBoundary ?? columnBoundary ?? undefined}",
    );
  });
});
