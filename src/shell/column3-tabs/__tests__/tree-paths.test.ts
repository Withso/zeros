// tree-paths — ancestor prefixes used to expand a collapsed tree branch
// top-down before selecting/scrolling to a file.

import { describe, expect, it } from "vitest";

import {
  ancestorDirPrefixes,
  treeSelectionMirrorIntent,
  treeSelectionMirrorTarget,
  treeSelectionOpenTarget,
} from "../tree-paths";

describe("ancestorDirPrefixes", () => {
  it("returns every ancestor, shortest first", () => {
    expect(ancestorDirPrefixes("src/shell/column3-tabs/files-tab.tsx")).toEqual(
      ["src", "src/shell", "src/shell/column3-tabs"],
    );
  });

  it("returns nothing for a root-level file", () => {
    expect(ancestorDirPrefixes("README.md")).toEqual([]);
  });

  it("ignores empty segments (defensive against stray slashes)", () => {
    expect(ancestorDirPrefixes("a//b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorDirPrefixes("/a/b.ts")).toEqual(["a"]);
    expect(ancestorDirPrefixes("")).toEqual([]);
  });
});

describe("tree selection mirror", () => {
  it("distinguishes an active clear from an inactive suspension", () => {
    expect(treeSelectionMirrorTarget(true, undefined)).toBeNull();
    expect(treeSelectionMirrorTarget(false, "src/a.ts")).toBeUndefined();
    expect(treeSelectionMirrorIntent(null)).toEqual({ kind: "clear" });
    expect(treeSelectionMirrorIntent(undefined)).toEqual({ kind: "suspend" });
  });

  it("retains an active file as the selection target", () => {
    expect(
      treeSelectionMirrorIntent(treeSelectionMirrorTarget(true, "src/a.ts")),
    ).toEqual({ kind: "select", path: "src/a.ts" });
  });
});

describe("treeSelectionOpenTarget", () => {
  it("opens only a newly selected row", () => {
    expect(treeSelectionOpenTarget([], ["src/a.ts"], null)).toBe("src/a.ts");
    expect(
      treeSelectionOpenTarget(["src/a.ts"], ["src/b.ts"], "src/a.ts"),
    ).toBe("src/b.ts");
  });

  it("stays inert on an empty publication", () => {
    expect(treeSelectionOpenTarget(["src/a.ts"], [], null)).toBeNull();
    expect(treeSelectionOpenTarget([], [], undefined)).toBeNull();
  });

  it("filters the mirror echo (the tab's already-open file)", () => {
    expect(treeSelectionOpenTarget([], ["src/a.ts"], "src/a.ts")).toBeNull();
  });

  it("filters a re-publication of an unchanged row once the file closed", () => {
    // The fixed Files home just reverted to blank: mirror target is null, so
    // only the previous-publication guard stands between a store re-emit of
    // the still-selected row and the file instantly re-opening.
    expect(
      treeSelectionOpenTarget(["src/a.ts"], ["src/a.ts"], null),
    ).toBeNull();
  });

  it("lets the same row re-open after a launcher deselect cleared it", () => {
    // deselectAfterOpen publishes [] between clicks, so a repeat click IS a
    // new selection relative to the previous publication.
    expect(treeSelectionOpenTarget([], ["src/a.ts"], null)).toBe("src/a.ts");
  });
});
