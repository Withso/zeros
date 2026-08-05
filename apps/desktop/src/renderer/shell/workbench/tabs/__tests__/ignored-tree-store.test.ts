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

import {
  ignoredPathDelta,
  mergeIgnoredPaths,
  planIgnoredPathDelta,
} from "../ignored-entries";
import { ancestorDirPrefixes } from "../tree-paths";

/** A headless controller with the same options WorkspaceFileTree uses.
 *  `flattenEmptyDirectories` went false on 2026-08-03 (Finder-style nesting —
 *  the graph's one-folder-per-attachment layout turned every listing into
 *  "local/attachments" composite rows); keep this in lockstep with
 *  workspace-file-tree.tsx or these prove behavior the app doesn't have. */
function makeTree(paths: string[]) {
  return new FileTree({
    paths,
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
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
    const applied = set(
      "dist/",
      "dist/app.js",
      "dist/assets/",
      "dist/assets/x.css",
    );
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
    step(
      ["node_modules/", ".env"],
      [["node_modules", ["node_modules/react/"]]],
    );
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

  it("survives the roots-first deletion race without a fallback rebuild", () => {
    const tree = makeTree(["src/a.ts", "dist/", "dist/old.js"]);
    let applied = set("dist/", "dist/old.js");

    // Roots have refreshed (dist/ gone), but the expanded-dir request has not.
    const rootsPass = planIgnoredPathDelta(applied, set("dist/old.js"));
    expect(() => tree.batch(rootsPass.operations)).not.toThrow();
    applied = new Set(rootsPass.applied);
    expect(tree.getItem("dist/old.js")).not.toBeNull();

    // The child request catches up. One recursive remove now clears both the
    // explicit directory and its old child without ever desynchronising the
    // model from the applied snapshot.
    const childPass = planIgnoredPathDelta(applied, set());
    expect(() => tree.batch(childPass.operations)).not.toThrow();
    expect(tree.getItem("dist/")).toBeNull();
    expect(tree.getItem("dist/old.js")).toBeNull();
    expect(tree.getItem("src/a.ts")).not.toBeNull();
  });

  it("accepts ignored file-to-directory kind changes incrementally", () => {
    const tree = makeTree(["src/a.ts", "cache"]);
    const ops = ignoredPathDelta(set("cache"), set("cache/", "cache/x.bin"));
    expect(ops[0]).toEqual({ path: "cache", type: "remove" });
    expect(() => tree.batch(ops)).not.toThrow();
    expect(tree.getItem("cache/")?.isDirectory()).toBe(true);
    expect(tree.getItem("cache/x.bin")).not.toBeNull();
  });

  it("rebuilds when replacing an inferred directory and its descendants with a file", () => {
    const tree = makeTree(["src/a.ts", "cache/item.bin"]);
    const plan = planIgnoredPathDelta(
      set("cache/item.bin"),
      set("cache"),
    );

    expect(plan.requiresReset).toBe(true);
    expect(plan.operations).toEqual([]);
    expect(() => tree.resetPaths(["src/a.ts", "cache"])).not.toThrow();
    expect(tree.getItem("cache")?.isDirectory()).toBe(false);
    expect(tree.getItem("cache/item.bin")).toBeNull();
    expect(tree.getItem("src/a.ts")).not.toBeNull();
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
    // `packages/protocol/node_modules/` lives under a tracked directory legitimately.
    const { paths, appliedIgnored } = mergeForTree(
      ["packages/protocol/src/a.ts", "dist-engine.config.ts"],
      ["dist-engine/", "packages/protocol/node_modules/"],
    );
    expect(() => makeTree(paths)).not.toThrow();
    expect(appliedIgnored.sort()).toEqual([
      "dist-engine/",
      "packages/protocol/node_modules/",
    ]);
  });
});

describe("the context graph under the production tree options", () => {
  // The row-level "no `local/attachments` composite" contract lives in the
  // library's renderer, which has no headless API — what CAN be pinned is
  // that under the unflattened options every level of the graph's
  // one-folder-per-attachment chain is its own expandable directory item,
  // and that the lazy ignored-listing shape (a root that materialises one
  // level at a time) keeps working against the store.
  it("keeps each level of the attachment chain its own directory item", () => {
    const tree = makeTree([
      ".context-graph/.gitignore",
      ".context-graph/local/attachments/UKhj7y/shot.png",
      "src/app.ts",
    ]);
    const levels = [
      ".context-graph/",
      ".context-graph/local/",
      ".context-graph/local/attachments/",
      ".context-graph/local/attachments/UKhj7y/",
    ];
    for (const dir of levels) {
      const item = tree.getItem(dir);
      expect(item, dir).not.toBeNull();
      expect(item!.isDirectory(), dir).toBe(true);
      (item as unknown as { expand(): void }).expand();
      expect(
        (item as unknown as { isExpanded(): boolean }).isExpanded(),
        dir,
      ).toBe(true);
    }
    expect(
      tree.getItem(".context-graph/local/attachments/UKhj7y/shot.png"),
    ).not.toBeNull();
  });

  it("grows a lazily-listed graph root one level at a time without throwing", () => {
    // The Files tab's actual sequence for `.context-graph/local/` — a root
    // with no children yet, then each expansion adds the next level.
    const tracked = ["src/a.ts"];
    let applied = new Set<string>([".context-graph/local/"]);
    const tree = makeTree([...tracked, ...applied]);
    const grow = (next: Set<string>) => {
      expect(() => tree.batch(ignoredPathDelta(applied, next))).not.toThrow();
      applied = next;
    };
    grow(set(".context-graph/local/", ".context-graph/local/attachments/"));
    grow(
      set(
        ".context-graph/local/",
        ".context-graph/local/attachments/",
        ".context-graph/local/attachments/UKhj7y/",
      ),
    );
    grow(
      set(
        ".context-graph/local/",
        ".context-graph/local/attachments/",
        ".context-graph/local/attachments/UKhj7y/",
        ".context-graph/local/attachments/UKhj7y/shot.png",
      ),
    );
    expect(
      tree.getItem(".context-graph/local/attachments/UKhj7y/shot.png"),
    ).not.toBeNull();
  });
});
