// Files-to-copy model — the logic behind the settings pane's checklist.
//
// The contract that matters: a row is ticked because the PATTERNS select it,
// not because someone clicked it. That is what keeps a hand-written `.env*`
// and a ticked box meaning the same thing, and it is why the interesting cases
// here are all "what does the pattern list say about this row".

import { describe, it, expect } from "vitest";

import type {
  FilesToCopyCandidateWire,
  FilesToCopyFileWire,
  FilesToCopyPreviewWire,
} from "../../bridge/workspace-bridge";
import {
  applyDraftOverlay,
  baseFor,
  canMaterialize,
  hasConfirmedEmptyCandidates,
  sameList,
  buildCandidateRows,
  buildCandidateTree,
  flattenTree,
  formatPatternText,
  isCommentPattern,
  isLiteralPattern,
  literalPatternPath,
  materializePatterns,
  nodeCheck,
  nodeLocked,
  normalizePattern,
  parsePatternText,
  patternStatsForBox,
  patternsDescribeBox,
  summaryLead,
  toggleManyPatterns,
  togglePattern,
  toggleablePaths,
  type CandidateTreeNode,
} from "../files-to-copy-model";

const file = (
  path: string,
  bytes = 10,
  ignored = true,
): FilesToCopyFileWire => ({ path, bytes, ignored });
const cand = (
  path: string,
  isDir = false,
  bytes = 10,
): FilesToCopyCandidateWire => ({ path, isDir, bytes: isDir ? -1 : bytes });

function preview(
  over: Partial<FilesToCopyPreviewWire> = {},
): FilesToCopyPreviewWire {
  return {
    source: "file_include_globs",
    rootPath: "/repo",
    patterns: [],
    files: [],
    totalCount: 0,
    totalBytes: 0,
    truncated: false,
    trackedMatches: [],
    candidates: [],
    warnings: [],
    complete: true,
    ...over,
  };
}

describe("parsePatternText", () => {
  it("drops blank lines and strips only TRAILING SPACES", () => {
    // git's own parser strips spaces and nothing else — a trailing tab is part
    // of the pattern, and eating it would stop the named file from matching.
    expect(parsePatternText(".env  \n\n\tlead\ntab\t\n")).toEqual([
      ".env",
      "\tlead",
      "tab\t",
    ]);
  });

  it("KEEPS comment lines", () => {
    // The text round-trips through this on every keystroke. Dropping comments
    // would silently delete the user's own notes from their settings file.
    expect(parsePatternText("# team list\n.env\n")).toEqual([
      "# team list",
      ".env",
    ]);
  });

  it("round-trips through formatPatternText", () => {
    const text = "# note\n.env\n!.env.production";
    expect(formatPatternText(parsePatternText(text))).toBe(text);
  });
});

describe("normalizePattern / isLiteralPattern", () => {
  it("strips the root anchor and the directory marker", () => {
    expect(normalizePattern("/certs/")).toBe("certs");
    expect(normalizePattern("certs")).toBe("certs");
    expect(normalizePattern(" /a/b/ ")).toBe("a/b");
  });

  it("only a plain path is literal", () => {
    expect(isLiteralPattern("/.env")).toBe(true);
    expect(isLiteralPattern("config/local.json")).toBe(true);
    expect(isLiteralPattern(".env*")).toBe(false);
    expect(isLiteralPattern("certs/**")).toBe(false);
    expect(isLiteralPattern("log-[0-9].txt")).toBe(false);
    expect(isLiteralPattern("!.env")).toBe(false);
    expect(isLiteralPattern("# comment")).toBe(false);
  });

  it("an ESCAPED metacharacter is literal; a live one next to it is not", () => {
    expect(isLiteralPattern("/dist/\\[id\\].js")).toBe(true);
    expect(isLiteralPattern("/a\\*b")).toBe(true);
    // `\\` is an escaped BACKSLASH, so the `*` after it is live.
    expect(isLiteralPattern("/a\\\\*")).toBe(false);
    expect(literalPatternPath("/a\\\\b")).toBe("a\\b");
  });
});

describe("isCommentPattern", () => {
  it("recognises a note the user wrote to themselves", () => {
    // The engine scores a comment `matchCount: 0`, which the per-line stats
    // rendered as a red 0 and the words "matches nothing" — the pane calling
    // the user's own note a typo, in a box that is now open by default.
    expect(isCommentPattern("# secrets for the api")).toBe(true);
    expect(isCommentPattern("   # indented")).toBe(true);
    expect(isCommentPattern(".env*")).toBe(false);
    expect(isCommentPattern("!.env.production")).toBe(false);
    // `#` is only a comment at the START of a line, as in .gitignore.
    expect(isCommentPattern("build/#tmp")).toBe(false);
  });
});

describe("buildCandidateRows", () => {
  it("ticks a row the patterns matched, leaves the rest clear", () => {
    const rows = buildCandidateRows(
      preview({
        candidates: [cand(".env"), cand("debug.log")],
        files: [file(".env")],
      }),
      ["/.env"],
    );
    expect(rows.map((r) => [r.path, r.selected])).toEqual([
      [".env", true],
      ["debug.log", false],
    ]);
  });

  it("ticks a COLLAPSED directory when anything inside it matched", () => {
    // `node_modules/` arrives as one candidate row but the matches are the
    // files under it — without the prefix walk the row would read as unticked
    // while thousands of its files were queued for copying.
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("node_modules", true)],
        files: [file("node_modules/left-pad/index.js")],
      }),
      ["/node_modules"],
    );
    expect(rows[0].selected).toBe(true);
  });

  it("locks a row selected by a GLOB — a checkbox can't take that back", () => {
    const rows = buildCandidateRows(
      preview({ candidates: [cand(".env")], files: [file(".env")] }),
      [".env*"],
    );
    expect(rows[0].selected).toBe(true);
    expect(rows[0]).toMatchObject({ locked: true, lockedBy: ".env*" });
  });

  it("locks WITHOUT naming a line when several globs could be responsible", () => {
    // `globs[0]` was printed regardless of which one matched, so a `.env` row
    // in a list starting with `*.log` read "from *.log" — sending the user to
    // edit a pattern that had nothing to do with it.
    const rows = buildCandidateRows(
      preview({ candidates: [cand(".env")], files: [file(".env")] }),
      ["*.log", ".env*"],
    );
    expect(rows[0]).toMatchObject({ locked: true, lockedBy: null });
  });

  it("locks a row a literal PARENT directory selects, and names that line", () => {
    // `/certs` selects `certs/a.pem`, but no checkbox can say "everything
    // under /certs except this one". Left unlocked the box rendered enabled
    // and `togglePattern` removed nothing: a permanent no-op click.
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("certs/a.pem")],
        files: [file("certs/a.pem")],
      }),
      ["/certs"],
    );
    expect(rows[0]).toMatchObject({
      selected: true,
      locked: true,
      lockedBy: "/certs",
    });
  });

  it("a literal line for the exact path beats an overlapping glob", () => {
    // Both select `.env`; the literal is the one the user can delete, so the
    // row stays tickable instead of being needlessly frozen.
    const rows = buildCandidateRows(
      preview({ candidates: [cand(".env")], files: [file(".env")] }),
      [".env*", "/.env"],
    );
    expect(rows[0]).toMatchObject({ locked: false, lockedBy: null });
  });

  it("nothing is locked before a first edit — the default is materializable", () => {
    // With no saved list the pane passes an empty pattern list, and ticking
    // materializes what is matched. Locking those rows would make the very
    // first click impossible.
    const rows = buildCandidateRows(
      preview({
        source: "default",
        candidates: [cand(".env")],
        files: [file(".env")],
      }),
      [],
    );
    expect(rows[0]).toMatchObject({ selected: true, locked: false });
  });

  it("reads an ESCAPED literal as the file it names, not as a glob", () => {
    // `dist/[id].js` is an ordinary route file. The line the pane writes for
    // it is backslash-escaped; reading that as a character class froze the row
    // it had just created.
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("dist/[id].js")],
        files: [file("dist/[id].js")],
      }),
      ["/dist/\\[id\\].js"],
    );
    expect(rows[0]).toMatchObject({
      selected: true,
      locked: false,
      lockedBy: null,
    });
  });

  it("flags a matched file git is NOT ignoring", () => {
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("config/local.json")],
        files: [file("config/local.json", 20, false)],
      }),
      ["/config/local.json"],
    );
    expect(rows[0].notIgnored).toBe(true);
  });

  it("an unselected row is never flagged or locked", () => {
    const rows = buildCandidateRows(
      preview({ candidates: [cand("debug.log")], files: [] }),
      [".env*"],
    );
    expect(rows[0]).toMatchObject({
      selected: false,
      locked: false,
      lockedBy: null,
      notIgnored: false,
    });
  });
});

describe("applyDraftOverlay", () => {
  const rowsFor = (patterns: string[]) =>
    buildCandidateRows(
      preview({
        candidates: [cand(".env"), cand("debug.log")],
        files: patterns.includes("/.env") ? [file(".env")] : [],
      }),
      patterns,
    );

  it("ticks a box the moment it is clicked, not when the scan lands", () => {
    // The bug this exists for: rows come from the last PREVIEW, so a click
    // left the box unticked for a whole debounce — and clicking again in that
    // window read the stale "not selected" and did nothing at all.
    const rows = rowsFor([]);
    expect(rows.find((r) => r.path === ".env")?.selected).toBe(false);
    const live = applyDraftOverlay(rows, [], ["/.env"]);
    expect(live.find((r) => r.path === ".env")?.selected).toBe(true);
  });

  it("unticks immediately too", () => {
    const rows = rowsFor(["/.env"]);
    const live = applyDraftOverlay(rows, ["/.env"], []);
    expect(live.find((r) => r.path === ".env")?.selected).toBe(false);
  });

  it("keeps list identity when the draft matches the preview", () => {
    // Rendering hot rows depends on this: an unchanged list must not
    // re-render every row on every keystroke elsewhere in the pane.
    const rows = rowsFor(["/.env"]);
    expect(applyDraftOverlay(rows, ["/.env"], ["/.env"])).toBe(rows);
  });

  it("leaves GLOB-selected rows alone — a checkbox never wrote them", () => {
    const rows = buildCandidateRows(
      preview({ candidates: [cand(".env")], files: [file(".env")] }),
      [".env*"],
    );
    const live = applyDraftOverlay(rows, [".env*"], [".env*"]);
    expect(live[0]).toMatchObject({ selected: true, lockedBy: ".env*" });
  });

  it("does not touch rows the user hasn't clicked", () => {
    const rows = rowsFor([]);
    const live = applyDraftOverlay(rows, [], ["/.env"]);
    expect(live.find((r) => r.path === "debug.log")).toBe(
      rows.find((r) => r.path === "debug.log"),
    );
  });

  it("unticks a COLLAPSED directory whose literals are its children", () => {
    // Materialization always writes a directory out file by file, so an
    // exact-path test said "unchanged" on both sides: the box stayed visibly
    // ticked for the debounce PLUS the whole scan, and clicking again was a
    // no-op — the lag this function exists to remove.
    const saved = ["/certs/a.pem", "/certs/sub/b.pem"];
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("certs", true)],
        files: [file("certs/a.pem"), file("certs/sub/b.pem")],
      }),
      saved,
    );
    expect(rows[0].selected).toBe(true);
    const live = applyDraftOverlay(
      rows,
      saved,
      togglePattern(saved, "certs", false),
    );
    expect(live[0].selected).toBe(false);
  });

  it("unticks on the FIRST edit, where the baseline is the materialized set", () => {
    // With nothing saved the pane composes the edit from `baseFor`, so the
    // overlay's baseline has to be that same materialized list. Passing the
    // empty list made every row's "before" false, so the first untick had
    // nothing to flip and the box stayed ticked.
    const fresh = preview({
      source: "default",
      candidates: [cand(".env"), cand(".env.local")],
      files: [file(".env"), file(".env.local")],
    });
    const rows = buildCandidateRows(fresh, []);
    const base = baseFor(fresh, null);
    const live = applyDraftOverlay(
      rows,
      base,
      togglePattern(base, ".env", false),
    );
    expect(live.find((r) => r.path === ".env")?.selected).toBe(false);
    expect(live.find((r) => r.path === ".env.local")?.selected).toBe(true);
  });

  it("does not turn untouched defaults into draft deletions", () => {
    // With no repo-local list and no draft, the pane used `[]` as the live
    // side of the overlay. That reinterpreted every default-selected row as an
    // explicit deletion even though the preview and summary still selected it.
    const fresh = preview({
      source: "default",
      candidates: [cand(".env"), cand(".env.local")],
      files: [file(".env"), file(".env.local")],
      totalCount: 2,
    });
    const rows = buildCandidateRows(fresh, []);
    const base = baseFor(fresh, null);
    const live = applyDraftOverlay(rows, base, null);

    expect(live).toBe(rows);
    expect(live.map((row) => row.selected)).toEqual([true, true]);
  });
});

describe("togglePattern", () => {
  it("adds the ANCHORED form", () => {
    // Unanchored `certs` would also match `packages/app/certs` — copying a
    // directory the user never saw in the list they were ticking.
    expect(togglePattern([], "certs", true)).toEqual(["/certs"]);
  });

  it("does not duplicate an entry that is already there", () => {
    expect(togglePattern(["/certs"], "certs", true)).toEqual(["/certs"]);
    expect(togglePattern(["certs/"], "certs", true)).toEqual(["certs/"]);
  });

  it("removes every literal spelling of the path", () => {
    expect(togglePattern(["/.env", ".env", "/other"], ".env", false)).toEqual([
      "/other",
    ]);
  });

  it("leaves a glob alone when unticking — it is not ours to delete", () => {
    expect(togglePattern([".env*"], ".env", false)).toEqual([".env*"]);
  });

  it("leaves comments and negations intact", () => {
    expect(
      togglePattern(["# keep", "!.env.production", "/.env"], ".env", false),
    ).toEqual(["# keep", "!.env.production"]);
  });
});

describe("toggleManyPatterns", () => {
  // A folder checkbox moves every path under it at once. The contract is
  // "togglePattern applied in sequence", in one pass instead of k passes.
  const fold = (list: string[], paths: string[], on: boolean) =>
    paths.reduce((acc, p) => togglePattern(acc, p, on), list);

  it("agrees with folding togglePattern when ticking", () => {
    const paths = ["lib/a", "lib/b", "lib/c"];
    expect(toggleManyPatterns([], paths, true)).toEqual(fold([], paths, true));
    expect(toggleManyPatterns([], paths, true)).toEqual([
      "/lib/a",
      "/lib/b",
      "/lib/c",
    ]);
  });

  it("agrees with folding togglePattern when unticking", () => {
    const base = ["/lib/a", "/lib/b/x.pem", "/.env", "*.log"];
    const paths = ["lib/a", "lib/b"];
    expect(toggleManyPatterns(base, paths, false)).toEqual(
      fold(base, paths, false),
    );
    // The glob and the untouched literal both survive.
    expect(toggleManyPatterns(base, paths, false)).toEqual(["/.env", "*.log"]);
  });

  it("does not duplicate a path already in the list, or one repeated in the batch", () => {
    expect(toggleManyPatterns(["/lib/a"], ["lib/a", "lib/a"], true)).toEqual([
      "/lib/a",
    ]);
  });

  it("escapes glob metacharacters, like the single-path form", () => {
    expect(toggleManyPatterns([], ["dist/[id].js"], true)).toEqual([
      "/dist/\\[id\\].js",
    ]);
  });

  it("does not mistake a sibling directory for a child", () => {
    expect(toggleManyPatterns(["/certs-old/a.pem"], ["certs"], false)).toEqual([
      "/certs-old/a.pem",
    ]);
  });

  it("is a no-op copy for an empty batch", () => {
    expect(toggleManyPatterns(["/.env"], [], true)).toEqual(["/.env"]);
    expect(toggleManyPatterns(["/.env"], [], false)).toEqual(["/.env"]);
  });
});

describe("materializePatterns / baseFor", () => {
  it("turns the effective match set into explicit anchored lines", () => {
    expect(
      materializePatterns(preview({ files: [file(".env"), file("a/b.key")] })),
    ).toEqual(["/.env", "/a/b.key"]);
  });

  it("ESCAPES glob metacharacters so the line names the real file", () => {
    // `/dist/[id].js` is a character class matching `dist/1.js`, not the file
    // it was written for — so the first tick silently stopped seeding it.
    const m = materializePatterns(preview({ files: [file("dist/[id].js")] }));
    expect(m).toEqual(["/dist/\\[id\\].js"]);
    // …and round-trips: the row it came from still reads as literal.
    expect(isLiteralPattern(m[0])).toBe(true);
    expect(literalPatternPath(m[0])).toBe("dist/[id].js");
  });

  it("unticks a file whose line had to be escaped", () => {
    expect(togglePattern(["/dist/\\[id\\].js"], "dist/[id].js", false)).toEqual(
      [],
    );
  });

  it("a first edit starts from what is currently matched, not from empty", () => {
    // Any saved list REPLACES the built-in `.env*`. Starting empty would make
    // the first tick silently drop the user's .env.
    const p = preview({ source: "default", files: [file(".env")] });
    expect(baseFor(p, null)).toEqual(["/.env"]);
  });

  it("an existing saved list is used as-is", () => {
    const p = preview({ files: [file(".env")] });
    expect(baseFor(p, [".env*"])).toEqual([".env*"]);
  });

  it("an EXPLICIT empty list is honoured, not treated as 'unset'", () => {
    // `[]` means "copy nothing". Falling back to materialize here would make
    // that state impossible to reach: untick the last row, and the built-in
    // default reappears and re-ticks it.
    const p = preview({ files: [file(".env")] });
    expect(baseFor(p, [])).toEqual([]);
  });
});

describe("buildCandidateTree", () => {
  // The shape this exists for: 10 flat rows that are really 4 directories.
  const REAL = [
    cand(".DS_Store"),
    cand("artifacts/.DS_Store"),
    cand("artifacts/api-server/dist", true),
    cand("artifacts/api-server/node_modules", true),
    cand("lib/api-spec/node_modules", true),
    cand("node_modules", true),
    cand("scripts/node_modules", true),
    cand("site/dist", true),
    cand("site/node_modules", true),
    cand("site/tsconfig.tsbuildinfo"),
  ];
  const rowsOf = (
    candidates: FilesToCopyCandidateWire[],
    files: FilesToCopyFileWire[] = [],
    patterns: string[] = [],
  ) => buildCandidateRows(preview({ candidates, files }), patterns);

  it("folds a flat list into the handful of folders it actually is", () => {
    const tree = buildCandidateTree(rowsOf(REAL));
    // Folders first, then files, alphabetical within each.
    expect(tree.map((n) => n.name)).toEqual([
      "artifacts",
      "lib/api-spec/node_modules",
      "node_modules",
      "scripts/node_modules",
      "site",
      ".DS_Store",
    ]);
  });

  it("merges a folder that holds exactly one thing into a single row", () => {
    // `scripts` → `node_modules/` is a disclosure triangle hiding nothing.
    const tree = buildCandidateTree(rowsOf(REAL));
    const scripts = tree.find((n) => n.name === "scripts/node_modules");
    expect(scripts?.path).toBe("scripts/node_modules");
    expect(scripts?.children).toEqual([]);
  });

  it("drops a candidate under a directory git already collapsed", () => {
    // Otherwise the same selection is drawn twice, in two places, behind two
    // checkboxes that disagree the moment one is clicked.
    const tree = buildCandidateTree(
      rowsOf([cand("node_modules", true), cand("node_modules/pkg/index.js")]),
    );
    expect(tree.map((n) => n.path)).toEqual(["node_modules"]);
    expect(tree[0].leafCount).toBe(1);
  });

  it("drops a nested candidate even when a sibling sorts between them", () => {
    // `-` and `.` precede `/` in ASCII, so `a-b` and `a.txt` both sort BETWEEN
    // the directory candidate `a` and its descendant `a/b`. A running
    // "last directory seen" prefix is cleared by those siblings and `a/b` gets
    // in after all — producing a SECOND node at path `a`, one row drawn twice,
    // two checkboxes disagreeing, and a duplicate React key.
    const tree = buildCandidateTree(
      rowsOf([cand("a", true), cand("a-b"), cand("a.txt"), cand("a/b")]),
    );
    expect(tree.map((n) => n.path)).toEqual(["a", "a-b", "a.txt"]);
    const flat = flattenTree(tree, new Set());
    const paths = flat.map((r) => r.node.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("counts leaves, selection and what a checkbox can move", () => {
    const rows = rowsOf(
      [
        cand("site/dist", true),
        cand("site/node_modules", true),
        cand("site/x.log"),
      ],
      [file("site/dist/bundle.js")],
      ["/site/dist"],
    );
    const site = buildCandidateTree(rows)[0];
    expect(site.name).toBe("site");
    expect([site.leafCount, site.selectedCount, site.toggleableCount]).toEqual([
      3, 1, 3,
    ]);
    expect(nodeCheck(site)).toBe("mixed");
  });

  it("a folder is ticked only when everything under it is", () => {
    const all = buildCandidateTree(
      rowsOf(
        [cand("a/x.log"), cand("a/y.log")],
        [file("a/x.log"), file("a/y.log")],
        ["/a/x.log", "/a/y.log"],
      ),
    )[0];
    expect(nodeCheck(all)).toBe("on");
    const none = buildCandidateTree(
      rowsOf([cand("a/x.log"), cand("a/y.log")]),
    )[0];
    expect(nodeCheck(none)).toBe("off");
  });

  it("a folder holding nothing but glob-locked rows is itself locked", () => {
    // Every row under it is held by `*.log`, which no checkbox can take back.
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("a/x.log"), cand("a/y.log")],
        files: [file("a/x.log"), file("a/y.log")],
      }),
      ["*.log"],
    );
    const a = buildCandidateTree(rows)[0];
    expect(nodeLocked(a)).toBe(true);
    expect(toggleablePaths(a)).toEqual([]);
  });

  it("offers only the unlocked rows when a folder is ticked", () => {
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("a/x.log"), cand("a/keep.txt")],
        files: [file("a/x.log")],
      }),
      ["*.log"],
    );
    const a = buildCandidateTree(rows)[0];
    expect(toggleablePaths(a)).toEqual(["a/keep.txt"]);
  });
});

describe("flattenTree", () => {
  const CANDS = [
    cand("lib/a.log"),
    cand("lib/deep/b.log"),
    cand("lib/c.log"),
    cand(".env"),
  ];
  const tree = (selected: string[] = []): CandidateTreeNode[] =>
    buildCandidateTree(
      buildCandidateRows(
        preview({ candidates: CANDS, files: selected.map((p) => file(p)) }),
        selected.map((p) => `/${p}`),
      ),
    );

  it("shows a closed folder as one row", () => {
    const flat = flattenTree(tree(), new Set());
    expect(flat.map((r) => r.label)).toEqual(["lib", ".env"]);
    expect(flat[0].branch).toBe(true);
    expect(flat[0].expanded).toBe(false);
  });

  it("walks into a folder that is open", () => {
    const flat = flattenTree(tree(), new Set(["lib"]));
    // `deep` held one file, so it merged into it and reads as one row.
    expect(flat.map((r) => [r.label, r.depth])).toEqual([
      ["lib", 0],
      ["a.log", 1],
      ["c.log", 1],
      ["deep/b.log", 1],
      [".env", 0],
    ]);
  });

  it("keeps a SELECTED row visible even when its folder is closed", () => {
    // The rule that makes closing safe: the row you ticked is the row you have
    // to find again to untick, so collapsing hides only what is unselected.
    const flat = flattenTree(tree(["lib/deep/b.log"]), new Set());
    expect(flat.map((r) => [r.label, r.pinned])).toEqual([
      ["lib", false],
      // Labelled relative to the folder that surfaced it, so the row still
      // says where it lives without re-opening anything.
      ["deep/b.log", true],
      [".env", false],
    ]);
  });

  it("does NOT burst a fully-ticked folder open", () => {
    // Its own box already says "all of this". Surfacing every child as well
    // meant one click on a closed folder replaced it with a wall of rows.
    const all = ["lib/a.log", "lib/c.log", "lib/deep/b.log"];
    const flat = flattenTree(tree(all), new Set());
    expect(flat.map((r) => r.label)).toEqual(["lib", ".env"]);
    expect(nodeCheck(flat[0].node)).toBe("on");
  });

  it("surfaces a wholly-ticked subfolder as one row, not as its files", () => {
    const rows = buildCandidateRows(
      preview({
        candidates: [
          cand("p/db/x.log"),
          cand("p/db/y.log"),
          cand("p/keep.txt"),
        ],
        files: [file("p/db/x.log"), file("p/db/y.log")],
      }),
      ["/p/db/x.log", "/p/db/y.log"],
    );
    const flat = flattenTree(buildCandidateTree(rows), new Set());
    expect(flat.map((r) => [r.label, r.folder, r.pinned])).toEqual([
      ["p", true, false],
      ["db", true, true],
    ]);
  });

  it("emits every node at most once, so paths are usable as keys", () => {
    const flat = flattenTree(tree(["lib/a.log", "lib/deep/b.log"]), new Set());
    const paths = flat.map((r) => r.node.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("first-use sequence", () => {
  // The whole pane in miniature: a repo with nothing saved, where the effective
  // list is the built-in `.env*` default. Any saved list REPLACES that default,
  // so the first click is the moment a user could silently lose their .env.
  const fresh = preview({
    source: "default",
    candidates: [cand(".env"), cand(".env.local"), cand("debug.log")],
    files: [file(".env"), file(".env.local")],
  });

  it("ticking a NEW row keeps everything the default already gave you", () => {
    const rows = buildCandidateRows(fresh, []);
    const debugRow = rows.find((r) => r.path === "debug.log");
    expect(debugRow?.selected).toBe(false);

    const next = togglePattern(baseFor(fresh, null), "debug.log", true);
    expect(next).toEqual(["/.env", "/.env.local", "/debug.log"]);
  });

  it("unticking one row keeps the OTHER defaults", () => {
    // The failure this guards: starting from an empty list would write
    // `["/.env"]` and quietly drop `.env.local` from every new workspace.
    const next = togglePattern(baseFor(fresh, null), ".env.local", false);
    expect(next).toEqual(["/.env"]);
  });

  it("two clicks in a row compose instead of overwriting", () => {
    let list = baseFor(fresh, null);
    list = togglePattern(list, "debug.log", true);
    list = togglePattern(list, ".env", false);
    expect(list).toEqual(["/.env.local", "/debug.log"]);
  });

  it("unticking everything ends at an empty list, which clears the setting", () => {
    let list = baseFor(fresh, null);
    for (const p of [".env", ".env.local"])
      list = togglePattern(list, p, false);
    expect(list).toEqual([]);
  });
});

describe("regressions the pane shipped with", () => {
  it("unticking a COLLAPSED directory removes the literals inside it", () => {
    // Materialization writes per-FILE lines, so nothing ever named `certs`.
    // Matching only the exact path removed zero lines, the resulting list was
    // identical, and unticking the row was a permanent no-op with no error.
    const base = ["/certs/a.pem", "/certs/sub/b.pem", "/.env"];
    expect(togglePattern(base, "certs", false)).toEqual(["/.env"]);
  });

  it("does not mistake a sibling directory for a child", () => {
    expect(togglePattern(["/certs-old/a.pem"], "certs", false)).toEqual([
      "/certs-old/a.pem",
    ]);
  });

  it("a directory row counts as tickable when literals name its contents", () => {
    const rows = buildCandidateRows(
      preview({
        candidates: [cand("certs", true)],
        files: [file("certs/a.pem")],
      }),
      ["/certs/a.pem"],
    );
    expect(rows[0]).toMatchObject({ selected: true, lockedBy: null });
  });

  it("never blames a NEGATION for a selection", () => {
    // "from !secret.txt" points the user at the one line that definitionally
    // did not cause the row to be selected.
    const rows = buildCandidateRows(
      preview({ candidates: [cand(".env")], files: [file(".env")] }),
      ["!secret.txt", ".env*"],
    );
    expect(rows[0].lockedBy).toBe(".env*");
  });

  it("refuses to materialize from a scan that is not the whole truth", () => {
    // A cut-short scan reports `files: []`; materializing would write an empty
    // list and stop seeding everything. A truncated one reports the first N of
    // many, so it would silently drop the rest from every future workspace.
    expect(canMaterialize(preview())).toBe(true);
    expect(canMaterialize(preview({ complete: false }))).toBe(false);
    expect(canMaterialize(preview({ truncated: true }))).toBe(false);
  });

  it("compares lists, so a trailing newline is not an edit", () => {
    // As joined text these differ, which left the pane permanently dirty and
    // unable to ever adopt an external change again.
    expect(sameList(parsePatternText("/.env\n"), ["/.env"])).toBe(true);
    expect(sameList(null, [])).toBe(false); // unset ≠ "copy nothing"
    expect(sameList(null, null)).toBe(true);
    expect(sameList(["a"], ["b"])).toBe(false);
  });
});

describe("patternsDescribeBox", () => {
  it("refuses to attribute counts to lines that are not in the box", () => {
    // With nothing saved the box is empty and the inherited `.env*` is what
    // ran — which printed a red "0 · .env* matches nothing" under an empty
    // editor, blaming the user for a pattern they never wrote.
    expect(patternsDescribeBox([], [{ raw: ".env*" }])).toBe(false);
  });

  it("attributes when the box is what the engine measured", () => {
    expect(patternsDescribeBox([".env*"], [{ raw: ".env*" }])).toBe(true);
    expect(patternsDescribeBox([], [])).toBe(true);
  });

  it("compares the way the engine normalizes a settings array", () => {
    // Entries are trimmed and blanks dropped before they ever reach git.
    expect(patternsDescribeBox(["  .env*  ", ""], [{ raw: ".env*" }])).toBe(
      true,
    );
  });

  it("stays quiet while a draft is still inside its debounce", () => {
    expect(patternsDescribeBox([".env*", "certs/"], [{ raw: ".env*" }])).toBe(
      false,
    );
  });
});

describe("patternStatsForBox", () => {
  const measured = {
    raw: ".env*",
    pattern: ".env*",
    negate: false,
    line: 1,
    matchCount: 0,
  };

  it("hides counts inherited from the user-level list", () => {
    const inherited = preview({
      source: "file_include_globs",
      sourceLayer: "user",
      patterns: [measured],
    });

    expect(patternStatsForBox([], inherited)).toEqual([]);
  });

  it("shows counts only when the measured lines are in the editor", () => {
    const own = preview({
      source: "file_include_globs",
      sourceLayer: "repo-local",
      patterns: [measured],
    });

    expect(patternStatsForBox([".env*"], own)).toEqual([measured]);
    expect(patternStatsForBox(["certs/**"], own)).toEqual([]);
  });

  it("never scores comment lines as broken patterns", () => {
    const comment = {
      raw: "# local secrets",
      pattern: "# local secrets",
      negate: false,
      line: 1,
      matchCount: 0,
    };
    const own = preview({
      source: "file_include_globs",
      sourceLayer: "repo-local",
      patterns: [comment],
    });

    expect(patternStatsForBox(["# local secrets"], own)).toEqual([]);
  });
});

describe("hasConfirmedEmptyCandidates", () => {
  it("distinguishes a confirmed zero from an incomplete scan", () => {
    expect(hasConfirmedEmptyCandidates(preview({ complete: true }), 0)).toBe(
      true,
    );
    expect(hasConfirmedEmptyCandidates(preview({ complete: false }), 0)).toBe(
      false,
    );
    expect(hasConfirmedEmptyCandidates(preview({ complete: true }), 1)).toBe(
      false,
    );
  });
});

describe("summaryLead", () => {
  it("says nothing rather than '0 files'", () => {
    expect(summaryLead(0)).toBe("Nothing");
  });

  it("stays a noun phrase in both branches", () => {
    // The pane completes it with "will be copied from …". A lead that was
    // itself a sentence printed "Nothing will be copied will be copied from".
    expect(summaryLead(1)).toBe("1 file");
    expect(summaryLead(3)).toBe("3 files");
    expect(summaryLead(5000)).toBe("5000 files");
  });
});
