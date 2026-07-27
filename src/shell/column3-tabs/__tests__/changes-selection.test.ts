import { describe, expect, it } from "vitest";

import { reconcileChangesSelection } from "../changes-selection";

describe("reconcileChangesSelection", () => {
  it("selects the first row on first open", () => {
    expect(reconcileChangesSelection([], ["a.ts", "b.ts"], null)).toBe("a.ts");
  });

  it("keeps a selection that still exists", () => {
    expect(
      reconcileChangesSelection(
        ["a.ts", "b.ts", "c.ts"],
        ["a.ts", "b.ts", "c.ts"],
        "b.ts",
      ),
    ).toBe("b.ts");
  });

  it("advances to the next surviving row when the selected file disappears", () => {
    expect(
      reconcileChangesSelection(
        ["a.ts", "b.ts", "c.ts", "d.ts"],
        ["a.ts", "d.ts"],
        "b.ts",
      ),
    ).toBe("d.ts");
  });

  it("falls back to the closest prior row when the last row disappears", () => {
    expect(
      reconcileChangesSelection(
        ["a.ts", "b.ts", "c.ts"],
        ["a.ts", "b.ts"],
        "c.ts",
      ),
    ).toBe("b.ts");
  });

  it("clears selection when no changes remain", () => {
    expect(reconcileChangesSelection(["a.ts"], [], "a.ts")).toBeNull();
  });
});
