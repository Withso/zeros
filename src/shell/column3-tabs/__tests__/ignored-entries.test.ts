// The merge/status/pending arithmetic behind the Files tab's ignored entries.
// It runs against a 60k-file node_modules, so the properties that matter are
// "no duplicate rows", "one status entry per subtree, not per file", and
// "never re-request a directory we already have".

import { beforeEach, describe, it, expect } from "vitest";
import {
  dirKey,
  emptyState,
  ignoredGitStatus,
  ignoredPathDelta,
  isDirEntry,
  knownIgnoredDirs,
  mergeIgnoredPaths,
  pendingIgnoredDirs,
  warmState,
  withCollapsed,
  withLoadedDir,
  withRefreshedDir,
  withRoots,
  withoutVanishedDirs,
} from "../ignored-entries";
import {
  rememberIgnoredRoots,
  resetIgnoredRootsCacheForTests,
} from "../ignored-entries-cache";

const map = (entries: Array<[string, string[]]>) => new Map(entries);

describe("isDirEntry / dirKey", () => {
  it("reads @pierre/trees' trailing-slash directory marker", () => {
    expect(isDirEntry("node_modules/")).toBe(true);
    expect(isDirEntry(".env")).toBe(false);
    expect(dirKey("node_modules/")).toBe("node_modules");
    expect(dirKey("node_modules")).toBe("node_modules");
  });
});

describe("mergeIgnoredPaths", () => {
  it("combines the roots with every loaded level", () => {
    const merged = mergeIgnoredPaths(
      ["node_modules/", ".env"],
      map([["node_modules", ["node_modules/react/", "node_modules/.bin/"]]]),
    );
    expect(merged.sort()).toEqual([
      ".env",
      "node_modules/",
      "node_modules/.bin/",
      "node_modules/react/",
    ]);
  });

  it("dedupes a nested root that also appears as a loaded child", () => {
    // `git ls-files --directory` reports packages/core/node_modules/ as its own
    // root AND it turns up when the user expands packages/core — feeding both
    // to the tree would render the row twice.
    const merged = mergeIgnoredPaths(
      ["node_modules/", "packages/core/node_modules/"],
      map([["packages/core", ["packages/core/node_modules/"]]]),
    );
    expect(merged.filter((p) => p === "packages/core/node_modules/")).toHaveLength(1);
  });

  it("is empty when nothing is ignored", () => {
    expect(mergeIgnoredPaths([], map([]))).toEqual([]);
  });
});

describe("ignoredGitStatus", () => {
  it("emits ONE entry per root — descendants inherit", () => {
    // @pierre/trees propagates `ignored` from a directory to everything under
    // it, so per-file entries would be ~60k objects for identical rendering.
    expect(ignoredGitStatus(["node_modules/", ".env"])).toEqual([
      { path: "node_modules/", status: "ignored" },
      { path: ".env", status: "ignored" },
    ]);
  });

  it("covers ignored FILES too, which have nothing to inherit from", () => {
    expect(ignoredGitStatus([".env"])[0]).toEqual({
      path: ".env",
      status: "ignored",
    });
  });

  it("covers loaded DIRECTORIES, because flattening breaks inheritance", () => {
    // This tree sets `flattenEmptyDirectories`, and the library only inherits
    // `ignored` from an ancestor that is a VISIBLE ROW. A `node_modules/` whose
    // only child is `.pnpm/` renders as ONE flattened row keyed on the terminal,
    // so a roots-only entry left it painted like tracked code. Very common: a
    // fresh install, `dist/` holding only `assets/`, `target/` only `debug/`.
    const status = ignoredGitStatus(
      ["node_modules/"],
      map([["node_modules", ["node_modules/.pnpm/"]]]),
    );
    expect(status).toContainEqual({
      path: "node_modules/.pnpm/",
      status: "ignored",
    });
  });

  it("does NOT emit an entry per loaded FILE — that is what inherits", () => {
    // Flattening only ever chains directory→directory (path-store/flatten.js),
    // so a file can never be a flattened terminal and never needs its own entry.
    // This is what keeps the map bounded instead of one-per-ignored-file.
    const status = ignoredGitStatus(
      ["node_modules/"],
      map([["node_modules/react", ["node_modules/react/index.js"]]]),
    );
    expect(status.map((s) => s.path)).toEqual(["node_modules/"]);
  });
});

describe("state transitions — a workspace switch must not mix worktrees", () => {
  const A = "/w/alpha";
  const B = "/w/beta";
  const opened = withLoadedDir(
    withRoots(emptyState(A), A, ["node_modules/"]),
    A,
    "node_modules",
    ["node_modules/react/"],
  );

  it("a refresh keeps branches open and their children loaded", () => {
    const next = withRoots(opened, A, ["node_modules/", "dist/"]);
    expect(next.roots).toEqual(["node_modules/", "dist/"]);
    expect([...next.expanded]).toEqual(["node_modules"]);
    expect([...next.loaded.keys()]).toEqual(["node_modules"]);
  });

  it("an unchanged roots listing returns the SAME object", () => {
    // reloadKey bumps constantly while an agent works. A fresh identity here
    // would re-run the tree's resetPaths every time and flicker open branches.
    expect(withRoots(opened, A, ["node_modules/"])).toBe(opened);
  });

  it("re-listing an open directory surfaces a file written into it", () => {
    // The case the user cares about: a terminal / agent / install wrote into a
    // directory that is already expanded.
    const refreshed = withRefreshedDir(opened, A, "node_modules", [
      "node_modules/react/",
      "node_modules/vue/",
    ]);
    expect(refreshed.loaded.get("node_modules")).toEqual([
      "node_modules/react/",
      "node_modules/vue/",
    ]);
    expect(mergeIgnoredPaths(refreshed.roots, refreshed.loaded)).toContain(
      "node_modules/vue/",
    );
  });

  it("re-listing with NO change is a no-op, identity included", () => {
    expect(withRefreshedDir(opened, A, "node_modules", ["node_modules/react/"])).toBe(
      opened,
    );
    // …and a result for a workspace we've already left is dropped.
    expect(withRefreshedDir(opened, B, "node_modules", ["x/"])).toBe(opened);
  });

  it("a DIFFERENT workspace starts clean", () => {
    const next = withRoots(opened, B, ["node_modules/"]);
    expect(next.cwd).toBe(B);
    expect(next.loaded.size).toBe(0);
    expect(next.expanded.size).toBe(0);
  });

  it("a collapsed branch is forgotten, so a refresh can't re-open it", () => {
    const collapsed = withCollapsed(opened, ["node_modules"]);
    expect([...collapsed.expanded]).toEqual([]);
    expect(withRoots(collapsed, A, ["node_modules/"]).expanded.size).toBe(0);
    // Unknown dirs are a no-op, and the object identity is preserved so the
    // hook's memos don't churn.
    expect(withCollapsed(opened, ["never-opened"])).toBe(opened);
    expect(withCollapsed(opened, [])).toBe(opened);
  });

  it("collapsing DROPS the cached children, whole subtree", () => {
    // Everything under a collapsed branch still cost real work while cached: tree
    // rows, git-status entries, and one map lookup per entry on every model
    // notification — plus an engine readdir per open dir on every refresh. One
    // trip into node_modules/.pnpm used to pin that for the workspace's lifetime.
    const deep = withLoadedDir(
      withLoadedDir(opened, A, "node_modules/react", [
        "node_modules/react/index.js",
      ]),
      A,
      "node_modules/react/lib",
      ["node_modules/react/lib/a.js"],
    );
    expect(deep.loaded.size).toBe(3);
    const collapsed = withCollapsed(deep, ["node_modules"]);
    expect([...collapsed.loaded.keys()]).toEqual([]);
    expect([...collapsed.expanded]).toEqual([]);
    expect(mergeIgnoredPaths(collapsed.roots, collapsed.loaded)).toEqual([
      "node_modules/",
    ]);
  });

  it("RE-EXPANDING a collapsed branch loads it again", () => {
    // The bug this pruning also repairs: a dir still in `loaded` is not
    // "pending", and withLoadedDir is the only writer of `expanded` — so a
    // collapse/re-expand cycle left the branch permanently out of `expanded`. It
    // then stopped being re-listed on refresh (files written into it never
    // appeared) and was left out of the resetPaths replay, so it slammed shut on
    // the next unrelated save.
    const collapsed = withCollapsed(opened, ["node_modules"]);
    expect(pendingIgnoredDirs(collapsed.roots, collapsed.loaded)).toContain(
      "node_modules",
    );
    const reopened = withLoadedDir(collapsed, A, "node_modules", [
      "node_modules/react/",
    ]);
    expect([...reopened.expanded]).toEqual(["node_modules"]);
  });

  it("drops a branch the listings no longer report, but not one merely off-tree", () => {
    // `rm -rf dist` while dist/ was open. Left in `expanded`, it cost a bridge
    // round-trip and an engine readdir on every later refresh, forever.
    const withDist = withLoadedDir(
      withRoots(opened, A, ["node_modules/", "dist/"]),
      A,
      "dist",
      ["dist/bundle.js"],
    );
    expect([...withDist.expanded].sort()).toEqual(["dist", "node_modules"]);
    const gone = withRoots(withDist, A, ["node_modules/"]);
    const pruned = withoutVanishedDirs(
      gone,
      knownIgnoredDirs(gone.roots, gone.loaded),
    );
    expect([...pruned.expanded]).toEqual(["node_modules"]);
    expect(pruned.loaded.has("dist")).toBe(false);
    // Still-reported dirs are untouched, identity included.
    const known = knownIgnoredDirs(withDist.roots, withDist.loaded);
    expect(withoutVanishedDirs(withDist, known)).toBe(withDist);
  });

  it("children that land after a workspace switch are dropped", () => {
    // The listing is async: switching workspaces mid-flight used to graft the
    // previous worktree's node_modules rows onto the new one.
    const switched = withRoots(opened, B, []);
    const late = withLoadedDir(switched, A, "node_modules", [
      "node_modules/stale/",
    ]);
    expect(late).toBe(switched);
    expect(mergeIgnoredPaths(late.roots, late.loaded)).toEqual([]);
  });

  it("does not overwrite a directory already recorded", () => {
    const again = withLoadedDir(opened, A, "node_modules", ["node_modules/x/"]);
    expect(again).toBe(opened);
  });

  it("records an EMPTY directory so it is not re-requested forever", () => {
    // An unreadable or genuinely empty dir must still be marked loaded — the
    // expansion watcher polls the pending set on every model notification, so
    // an unrecorded one would be re-fetched on every tick.
    const withEmpty = withLoadedDir(opened, A, "dist", []);
    expect(withEmpty.loaded.has("dist")).toBe(true);
    expect(pendingIgnoredDirs(["dist/"], withEmpty.loaded)).not.toContain("dist");
  });
});

describe("warmState — a workspace switch must not re-lay-out the tree", () => {
  const A = "/w/alpha";

  beforeEach(() => {
    resetIgnoredRootsCacheForTests();
  });

  it("is empty for a workspace this session has never listed", () => {
    expect(warmState(A)).toEqual(emptyState(A));
    expect(warmState(undefined).cwd).toBeUndefined();
  });

  it("starts a re-mount on the previous visit's roots", () => {
    // The glitch this exists for: without a seed the tab painted tracked files
    // only, then spliced `.env`/`node_modules/` into the middle of the sorted
    // list two round-trips later and shoved every row below them down.
    rememberIgnoredRoots(A, ["node_modules/", ".env"]);
    expect(mergeIgnoredPaths(warmState(A).roots, warmState(A).loaded)).toEqual([
      "node_modules/",
      ".env",
    ]);
  });

  it("starts collapsed even so — a fresh tree has nothing open to restore", () => {
    rememberIgnoredRoots(A, ["node_modules/"]);
    const seeded = warmState(A);
    expect([...seeded.expanded]).toEqual([]);
    expect([...seeded.loaded.keys()]).toEqual([]);
    // So the branch is still pending, and expanding it fetches as it always did.
    expect(pendingIgnoredDirs(seeded.roots, seeded.loaded)).toEqual([
      "node_modules",
    ]);
  });

  it("absorbs the revalidation that follows without a new identity", () => {
    // The seed is immediately re-listed. When the workspace is unchanged that
    // response must land as a no-op, or the tree resetPaths right after the
    // paint the seed existed to make clean.
    rememberIgnoredRoots(A, ["node_modules/", ".env"]);
    const seeded = warmState(A);
    expect(withRoots(seeded, A, ["node_modules/", ".env"])).toBe(seeded);
  });

  it("yields to the listing when the workspace moved on while parked", () => {
    rememberIgnoredRoots(A, ["node_modules/", "dist/"]);
    const next = withRoots(warmState(A), A, ["node_modules/"]);
    expect(next.roots).toEqual(["node_modules/"]);
  });
});

describe("pendingIgnoredDirs", () => {
  it("lists unloaded directories, skipping files", () => {
    expect(pendingIgnoredDirs(["node_modules/", ".env"], map([])).sort()).toEqual(
      ["node_modules"],
    );
  });

  it("drops a directory once its children are loaded", () => {
    const loaded = map([["node_modules", ["node_modules/react/"]]]);
    expect(pendingIgnoredDirs(["node_modules/"], loaded)).toEqual([
      "node_modules/react",
    ]);
  });

  it("keeps a loaded-but-EMPTY directory out of the pending set", () => {
    // Otherwise the expansion watcher re-requests it on every model tick.
    const loaded = map([["node_modules", []]]);
    expect(pendingIgnoredDirs(["node_modules/"], loaded)).toEqual([]);
  });

  it("grows one level at a time as the user descends", () => {
    const loaded = map([
      ["node_modules", ["node_modules/.pnpm/", "node_modules/react/"]],
      ["node_modules/.pnpm", ["node_modules/.pnpm/react@18/"]],
    ]);
    // Only the frontier is pending — never the whole subtree.
    expect(pendingIgnoredDirs(["node_modules/"], loaded).sort()).toEqual([
      "node_modules/.pnpm/react@18",
      "node_modules/react",
    ]);
  });
});

describe("ignoredPathDelta", () => {
  const set = (...p: string[]) => new Set(p);

  it("adds only what's new and removes only what's gone", () => {
    // Must be a STRICT delta: the tree store throws on adding a path it
    // already holds, and that throw escapes the layout effect that applies it.
    expect(
      ignoredPathDelta(
        set("node_modules/", "dist/"),
        set("node_modules/", "node_modules/react/"),
      ),
    ).toEqual([
      { path: "node_modules/react/", type: "add" },
      { path: "dist/", type: "remove", recursive: true },
    ]);
  });

  it("is empty when nothing moved", () => {
    // The common case on an idle refresh — no ops means no tree mutation at
    // all, so no chance of disturbing what the user has open.
    expect(ignoredPathDelta(set("node_modules/"), set("node_modules/"))).toEqual([]);
    expect(ignoredPathDelta(set(), set())).toEqual([]);
  });

  it("handles a first load and a full clear", () => {
    expect(ignoredPathDelta(set(), set("dist/"))).toEqual([
      { path: "dist/", type: "add" },
    ]);
    expect(ignoredPathDelta(set("dist/"), set())).toEqual([
      { path: "dist/", type: "remove", recursive: true },
    ]);
  });

  it("removes a DIRECTORY recursively and drops its covered descendants", () => {
    // `rm -rf dist` while dist/ was open: the ~6ms roots listing lands first, so
    // `dist/` is gone from `next` while its children are still there. The store
    // throws "Cannot remove a non-empty directory without recursive" — and
    // because the merged set is seeded from roots, the ops came out PARENT-FIRST,
    // so the parent's own removal was what hit it. batch does not roll back, so
    // that throw left the store half-mutated and forced the whole-tree rebuild
    // this delta exists to avoid, collapsing the user's tracked browsing.
    const ops = ignoredPathDelta(
      set("dist/", "dist/app.js", "dist/assets/", "dist/assets/x.css"),
      set(),
    );
    expect(ops).toEqual([{ path: "dist/", type: "remove", recursive: true }]);
  });

  it("keeps a sibling remove that no removed directory covers", () => {
    const ops = ignoredPathDelta(set("dist/", "dist/a.js", ".env"), set());
    expect(ops).toEqual([
      { path: "dist/", type: "remove", recursive: true },
      { path: ".env", type: "remove" },
    ]);
  });

  it("does not mistake a name PREFIX for an ancestor", () => {
    // `dist/` must not swallow `dist-engine/` — string prefixes are not paths.
    const ops = ignoredPathDelta(set("dist/", "dist-engine/"), set());
    expect(ops).toEqual([
      { path: "dist/", type: "remove", recursive: true },
      { path: "dist-engine/", type: "remove", recursive: true },
    ]);
  });

  it("removes a file whose parent SURVIVES, without touching the parent", () => {
    // The everyday case: a build replaces one chunk inside an open dist/.
    const ops = ignoredPathDelta(
      set("dist/", "dist/old.js"),
      set("dist/", "dist/new.js"),
    );
    expect(ops).toEqual([
      { path: "dist/new.js", type: "add" },
      { path: "dist/old.js", type: "remove" },
    ]);
  });
});
