// Ignored entries, driven against the REAL @pierre/trees store rather than a
// stand-in. The pure helpers next door can only prove the arithmetic; what
// actually bit here was what the STORE does with the result:
//
//   • `add` throws on a path it already holds,
//   • `remove` throws on a non-empty directory without `recursive`,
//   • `batch` does NOT roll back — a mid-batch throw leaves the store
//     half-mutated and emits no notification, so the tree and the path list
//     silently disagree,
//   • `resetPaths` throws on a duplicate, or on a path that is a file in one
//     listing and a directory in the other — from inside a layout effect, which
//     unwinds to the app's ROOT error boundary and blanks the whole window.
//
// So these assert against the library, not against our model of it.

import { describe, it, expect } from "vitest";
import { FileTree } from "@pierre/trees";

import { ignoredPathDelta, mergeIgnoredPaths } from "../ignored-entries";
import { ancestorDirPrefixes } from "../tree-paths";

/** A headless controller with the same options WorkspaceFileTree uses. */
function makeTree(paths: string[]) {
  return new FileTree({
    paths,
    initialExpansion: "closed",
    flattenEmptyDirectories: true,
  });
}

const set = (...p: string[]) => new Set(p);
const map = (entries: Array<[string, string[]]>) => new Map(entries);

/** The merge WorkspaceFileTree performs before handing `paths` to the tree —
 *  kept in sync with the memo there. Tracked always wins on a kind clash. */
function mergeForTree(tracked: string[], ignored: string[]) {
  const kinds = new Set<string>();
  for (const p of tracked) {
    kinds.add(p);
    for (const dir of ancestorDirPrefixes(p)) kinds.add(`${dir}/`);
  }
  const keep = ignored.filter(
    (p) =>
      !kinds.has(p) && !kinds.has(p.endsWith("/") ? p.slice(0, -1) : `${p}/`),
  );
  return { paths: [...tracked, ...keep], appliedIgnored: keep };
}

describe("the store accepts every op ignoredPathDelta produces", () => {
  it("removes a deleted ignored directory that still holds children", () => {
    // `rm -rf dist` while dist/ was expanded: the ~6ms roots listing lands
    // first, so `dist/` leaves `next` while its children are still in it. Ops
    // come out parent-first, so the parent's own removal is what used to throw.
    const applied = set("dist/", "dist/app.js", "dist/assets/", "dist/assets/x.css");
    const tree = makeTree(["src/a.ts", ...applied]);
    const ops = ignoredPathDelta(applied, set());
    expect(() => tree.batch(ops)).not.toThrow();
    for (const p of applied) expect(tree.getItem(p)).toBeNull();
    expect(tree.getItem("src/a.ts")).not.toBeNull();
  });

  it("does not collapse tracked browsing on an ignored-only change", () => {
    // The whole reason the incremental path exists. resetPaths rebuilds the
    // store closed and can only replay the IGNORED branches, so a build writing
    // into dist/ would snap the user's src/ browsing shut as collateral.
    const tree = makeTree(["src/a.ts", "src/lib/b.ts", "dist/", "dist/old.js"]);
    for (const dir of ["src/", "src/lib/", "dist/"]) {
      const item = tree.getItem(dir) as { expand(): void };
      item.expand();
    }
    const isOpen = (p: string) =>
      (tree.getItem(p) as { isExpanded(): boolean }).isExpanded();
    expect([isOpen("src/"), isOpen("src/lib/"), isOpen("dist/")]).toEqual([
      true,
      true,
      true,
    ]);
    tree.batch(
      ignoredPathDelta(
        set("dist/", "dist/old.js"),
        set("dist/", "dist/new.js"),
      ),
    );
    expect([isOpen("src/"), isOpen("src/lib/"), isOpen("dist/")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(tree.getItem("dist/new.js")).not.toBeNull();
    expect(tree.getItem("dist/old.js")).toBeNull();
  });

  it("survives a whole browse → collapse → refresh cycle without throwing", () => {
    // Walks the sequence the hook actually drives: roots, expand, load, refresh
    // with a new file, collapse (which prunes the subtree), refresh again.
    const tracked = ["src/a.ts"];
    let applied = new Set<string>();
    const tree = makeTree(tracked);
    const step = (roots: string[], loaded: Array<[string, string[]]>) => {
      const merged = mergeForTree(
        tracked,
        mergeIgnoredPaths(roots, map(loaded)),
      );
      const next = new Set(merged.appliedIgnored);
      expect(() => tree.batch(ignoredPathDelta(applied, next))).not.toThrow();
      applied = next;
    };
    step(["node_modules/", ".env"], []);
    step(["node_modules/", ".env"], [["node_modules", ["node_modules/react/"]]]);
    step(
      ["node_modules/", ".env"],
      [
        ["node_modules", ["node_modules/react/"]],
        ["node_modules/react", ["node_modules/react/index.js"]],
      ],
    );
    step(
      ["node_modules/", ".env"],
      [
        ["node_modules", ["node_modules/react/", "node_modules/vue/"]],
        ["node_modules/react", ["node_modules/react/index.js"]],
      ],
    );
    step(["node_modules/", ".env"], []); // collapse prunes the subtree
    step([], []); // everything gone
    expect(tree.getItem("src/a.ts")).not.toBeNull();
    expect(tree.getItem("node_modules/")).toBeNull();
  });
});

describe("resetPaths input is reconciled before the store sees it", () => {
  it("drops an ignored DIRECTORY that the tracked listing calls a file", () => {
    // `src/generated` is a tracked file; the dev turns it into a gitignored
    // directory. The ignored query reports `src/generated/` while the cached
    // tracked snapshot still says `src/generated`.
    const { paths, appliedIgnored } = mergeForTree(
      ["src/generated", "src/a.ts"],
      ["src/generated/", "node_modules/"],
    );
    expect(() => makeTree(paths)).not.toThrow();
    expect(paths).not.toContain("src/generated/");
    expect(appliedIgnored).toEqual(["node_modules/"]);
  });

  it("drops an ignored FILE that the tracked listing calls a directory", () => {
    // The other direction: a gitignored `build` file next to tracked
    // `build/keep.ts` left over in the cached snapshot.
    const { paths } = mergeForTree(
      ["build/keep.ts"],
      ["build", "node_modules/"],
    );
    expect(() => makeTree(paths)).not.toThrow();
    expect(paths).not.toContain("build");
  });

  it("drops an exact duplicate", () => {
    // Reachable when listWorkspaceFiles falls back to its non-git walk while the
    // ignored query succeeds.
    const { paths } = mergeForTree([".env", "src/a.ts"], [".env"]);
    expect(() => makeTree(paths)).not.toThrow();
    expect(paths.filter((p) => p === ".env")).toHaveLength(1);
  });

  it("confirms the store really would throw on each of those", () => {
    // Guards the guard: if the library ever stops rejecting these, the
    // reconciliation above is dead weight and should go.
    expect(() => makeTree(["src/generated", "src/generated/"])).toThrow();
    expect(() => makeTree(["build", "build/keep.ts"])).toThrow();
    expect(() => makeTree([".env", ".env"])).toThrow();
  });

  it("keeps a nested ignored root that only SHARES a prefix with tracked", () => {
    // Not a clash: `dist-engine/` is a different directory from `dist/`, and
    // `packages/core/node_modules/` lives under a tracked directory legitimately.
    const { paths, appliedIgnored } = mergeForTree(
      ["packages/core/src/a.ts", "dist-engine.config.ts"],
      ["dist-engine/", "packages/core/node_modules/"],
    );
    expect(() => makeTree(paths)).not.toThrow();
    expect(appliedIgnored.sort()).toEqual([
      "dist-engine/",
      "packages/core/node_modules/",
    ]);
  });
});
