import { describe, expect, it } from "vitest";

import {
  nextFilesSidebarMode,
  reconcileFilesSidebarSelection,
} from "../files-sidebar-mode";

describe("nextFilesSidebarMode", () => {
  it("switches directly between the one visible Files sidebar modes", () => {
    expect(nextFilesSidebarMode("tree", "search", true)).toBe("search");
    expect(nextFilesSidebarMode("search", "directories", true)).toBe(
      "directories",
    );
    expect(nextFilesSidebarMode("directories", "tree", true)).toBe("tree");
  });

  it("closes an active sidebar when its action is clicked again", () => {
    expect(nextFilesSidebarMode("tree", "tree", true)).toBeNull();
    expect(nextFilesSidebarMode("search", "search", true)).toBeNull();
    expect(nextFilesSidebarMode("directories", "directories", true)).toBeNull();
  });

  it("keeps a blank File tab usable by falling back to its tree", () => {
    expect(nextFilesSidebarMode("tree", "tree", false)).toBe("tree");
    expect(nextFilesSidebarMode("search", "search", false)).toBe("tree");
    expect(nextFilesSidebarMode("directories", "directories", false)).toBe(
      "tree",
    );
  });
});

describe("reconcileFilesSidebarSelection", () => {
  it.each(["search", "directories"] as const)(
    "resets a mounted %s sidebar to Tree when its fixed File tab becomes blank",
    (mode) => {
      const blankSelection = reconcileFilesSidebarSelection(
        { hasFile: true, mode },
        false,
      );

      expect(blankSelection).toEqual({ hasFile: false, mode: "tree" });
      expect(reconcileFilesSidebarSelection(blankSelection, true)).toEqual({
        hasFile: true,
        mode: "tree",
      });
    },
  );
});
