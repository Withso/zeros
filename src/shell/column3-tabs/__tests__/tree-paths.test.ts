// tree-paths — ancestor prefixes used to expand a collapsed tree branch
// top-down before selecting/scrolling to a file.

import { describe, expect, it } from "vitest";

import {
  ancestorDirPrefixes,
  treeSelectionMirrorIntent,
  treeSelectionMirrorTarget,
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
