import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DESIGN_FILES_LABEL,
  designDirectoriesIn,
  designDirectoryOfMarker,
  designSectionDirectories,
  filterDesignListing,
  isInsideDesignDirectory,
  sanitizeDesignDirectoryName,
  sectionedDesignDirectories,
} from "../design-files-section";
import {
  DESIGN_PANE_OPEN_FRACTION,
  loadDesignPaneCollapsed,
  saveDesignPaneCollapsed,
} from "../design-files-pane";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Source with comments stripped, for assertions about what the CODE does —
 *  these files explain their history in prose, so a plain search finds the very
 *  approach the comment says was abandoned. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const REALISTIC_LISTING = [
  ".context-graph/local/graph.json",
  ".context-graph/local/notes.md",
  ".env.example",
  ".gitignore",
  ".npmrc",
  "AGENTS.md",
  "Dockerfile",
  "apps/desktop/src/main.tsx",
  "apps/desktop/src/renderer/App.tsx",
  "apps/marketing/index.html",
  "artifacts/api/index.ts",
  "docker-compose.yml",
  "frame-10.html",
  "frame-2.html",
  "lib/README.md",
  "lib/util.ts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "Zebra/notes.md",
  "zulu/notes.md",
];

describe("recognizing the design directory", () => {
  it("takes the directory holding a committed canvas marker", () => {
    expect(designDirectoryOfMarker("ZerosDesign/.zeros-canvas.json")).toBe(
      "ZerosDesign",
    );
    expect(designDirectoryOfMarker("Zeros Design/.zeros-canvas.json")).toBe(
      "Zeros Design",
    );
    // Nested documents are recognized (the engine allows them)…
    expect(designDirectoryOfMarker("apps/web/designs/.zeros-canvas.json")).toBe(
      "apps/web/designs",
    );
  });

  it("is not a marker anywhere else", () => {
    // …but the marker at the repo ROOT would make the repo the design folder,
    // which the engine refuses (depth ≥ 1).
    expect(designDirectoryOfMarker(".zeros-canvas.json")).toBeNull();
    expect(designDirectoryOfMarker("ZerosDesign/frame.html")).toBeNull();
    expect(designDirectoryOfMarker("ZerosDesign/zeros-canvas.json")).toBeNull();
    expect(
      designDirectoryOfMarker("ZerosDesign/.zeros-canvas.json.bak"),
    ).toBeNull();
    expect(designDirectoryOfMarker("")).toBeNull();
  });

  it("refuses the directories the engine's sanitizer refuses", () => {
    expect(sanitizeDesignDirectoryName(".git/design")).toBeNull();
    expect(sanitizeDesignDirectoryName(".zeros/design")).toBeNull();
    expect(sanitizeDesignDirectoryName("../design")).toBeNull();
    expect(sanitizeDesignDirectoryName("/abs/design")).toBeNull();
    expect(sanitizeDesignDirectoryName("C:/design")).toBeNull();
    expect(sanitizeDesignDirectoryName("bad\nname")).toBeNull();
    expect(sanitizeDesignDirectoryName(".")).toBeNull();
    expect(sanitizeDesignDirectoryName("")).toBeNull();
    // Normalized like the engine: backslashes, trailing slash, whitespace.
    expect(sanitizeDesignDirectoryName("a\\b/")).toBe("a/b");
    expect(sanitizeDesignDirectoryName("  Zeros Design  ")).toBe(
      "Zeros Design",
    );
    expect(
      designDirectoryOfMarker(".git/design/.zeros-canvas.json"),
    ).toBeNull();
  });

  it("collects every design document in the listing, deduped and sorted", () => {
    expect(
      designDirectoriesIn([
        "b/.zeros-canvas.json",
        "a/.zeros-canvas.json",
        "b/.zeros-canvas.json",
        "src/index.ts",
        ".zeros-canvas.json",
      ]),
    ).toEqual(["a", "b"]);
    expect(designDirectoriesIn(REALISTIC_LISTING)).toEqual([]);
  });

  it("sections ROOT-level documents only", () => {
    // A nested document stays inline in the code tree: pulling it out would
    // leave its parent with a hole and show a bare nested folder with no
    // visible parent in the section.
    expect(
      sectionedDesignDirectories(["ZerosDesign", "apps/web/designs"]),
    ).toEqual(["ZerosDesign"]);
    expect(
      designSectionDirectories([
        ...REALISTIC_LISTING,
        "apps/web/designs/.zeros-canvas.json",
      ]),
    ).toEqual([]);
    expect(
      designSectionDirectories([
        ...REALISTIC_LISTING,
        "ZerosDesign/.zeros-canvas.json",
      ]),
    ).toEqual(["ZerosDesign"]);
  });
});

describe("membership", () => {
  const dirs = ["ZerosDesign"];

  it("matches the directory itself, its marker form, and its contents", () => {
    expect(isInsideDesignDirectory("ZerosDesign", dirs)).toBe(true);
    expect(isInsideDesignDirectory("ZerosDesign/", dirs)).toBe(true);
    expect(isInsideDesignDirectory("ZerosDesign/frame.html", dirs)).toBe(true);
    expect(isInsideDesignDirectory("ZerosDesign/a/b/c.css", dirs)).toBe(true);
    expect(
      isInsideDesignDirectory("ZerosDesign/.zeros-canvas.json", dirs),
    ).toBe(true);
  });

  it("compares on segment boundaries, not string prefixes", () => {
    // "ZerosDesignArchive" shares the prefix; it is real code and must stay
    // in the code tree.
    expect(isInsideDesignDirectory("ZerosDesignArchive/old.html", dirs)).toBe(
      false,
    );
    expect(isInsideDesignDirectory("ZerosDesign2", dirs)).toBe(false);
    expect(isInsideDesignDirectory("src/ZerosDesign/x", dirs)).toBe(false);
  });

  it("is false with nothing recognized or nothing to test", () => {
    expect(isInsideDesignDirectory("ZerosDesign/frame.html", [])).toBe(false);
    expect(isInsideDesignDirectory("", dirs)).toBe(false);
  });
});

describe("splitting the listing", () => {
  const design = [
    "ZerosDesign/.zeros-canvas.json",
    "ZerosDesign/frame.html",
    "ZerosDesign/assets/logo.svg",
  ];
  const withDesign = [
    ...REALISTIC_LISTING,
    ...design,
    "ZerosDesignArchive/old.html",
  ];
  const dirs = designSectionDirectories(withDesign);

  it("gives the code tree everything but the document", () => {
    const code = filterDesignListing(withDesign, "exclude-design", dirs);
    expect(code).toEqual([...REALISTIC_LISTING, "ZerosDesignArchive/old.html"]);
  });

  it("gives the section's tree nothing but the document", () => {
    expect(filterDesignListing(withDesign, "only-design", dirs)).toEqual(
      design,
    );
  });

  it("returns the SAME reference when nothing is removed", () => {
    // The tree bails out of a state update — and of a resetPaths rebuild, which
    // collapses every open directory — on reference equality with the previous
    // listing. A repo without a design document must therefore hand the code
    // tree the very array it had before.
    expect(filterDesignListing(REALISTIC_LISTING, "exclude-design", [])).toBe(
      REALISTIC_LISTING,
    );
    expect(filterDesignListing(design, "only-design", dirs)).toBe(design);
    expect(filterDesignListing(REALISTIC_LISTING, "only-design", [])).toEqual(
      [],
    );
  });

  it("keeps a nested-only document in the code tree", () => {
    const nested = [
      ...REALISTIC_LISTING,
      "apps/web/designs/.zeros-canvas.json",
    ];
    const nestedDirs = designSectionDirectories(nested);
    expect(nestedDirs).toEqual([]);
    expect(filterDesignListing(nested, "exclude-design", nestedDirs)).toBe(
      nested,
    );
  });

  it("splits ignored entries by the same directories, on segment boundaries", () => {
    const ignored = [
      "node_modules/",
      "ZerosDesign/.cache/",
      "ZerosDesignArchive/dist/",
    ];
    expect(filterDesignListing(ignored, "exclude-design", dirs)).toEqual([
      "node_modules/",
      "ZerosDesignArchive/dist/",
    ]);
    expect(filterDesignListing(ignored, "only-design", dirs)).toEqual([
      "ZerosDesign/.cache/",
    ]);
  });
});

describe("collapsed-state persistence", () => {
  it("defaults to open, remembers collapsed per workspace, and forgets on reopen", () => {
    const store = new Map<string, string>();
    const localStorageMock = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    try {
      expect(loadDesignPaneCollapsed("/ws/a")).toBe(false);
      saveDesignPaneCollapsed("/ws/a", true);
      expect(loadDesignPaneCollapsed("/ws/a")).toBe(true);
      expect(loadDesignPaneCollapsed("/ws/b")).toBe(false);
      saveDesignPaneCollapsed("/ws/a", false);
      expect(loadDesignPaneCollapsed("/ws/a")).toBe(false);
      // Open is the default, so nothing is stored for it.
      expect(JSON.parse(store.get("zeros:design-files-collapsed:v1")!)).toEqual(
        {},
      );
      // Corrupt storage degrades to the default, never throws.
      store.set("zeros:design-files-collapsed:v1", "not json");
      expect(loadDesignPaneCollapsed("/ws/a")).toBe(false);
      expect(loadDesignPaneCollapsed("")).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: previous,
        configurable: true,
      });
    }
  });
});

// The tree is a Shadow-DOM virtualizer; the wiring below is what a unit test
// can pin without a browser. The geometry itself is checked in a real browser
// by the ui-smoke harness.
describe("Files tab wiring", () => {
  const filesTab = read("../files-tab.tsx");
  const pane = read("../design-files-pane.tsx");
  const tree = read("../workspace-file-tree.tsx");

  it("stacks a second tree under the code tree, only when there is a document", () => {
    // The split lives in the HOST: the code tree hides the document, the pane
    // shows nothing else, and neither exists as a concept in a repo without one.
    expect(filesTab).toContain("useHasDesignSection(cwd, gitRefresh, active)");
    // Always on for the code tree: the filter is captured at mount, and a cold
    // listing lands AFTER mount — it is inert (same reference) without a document.
    expect(filesTab).toMatch(/designFilter="exclude-design"/);
    expect(filesTab).toMatch(
      /\{hasDesignSection && cwd && \(\s*<DesignFilesPane/,
    );
    expect(pane).toMatch(/designFilter="only-design"/);
    // Both trees mirror the same open file; the one without it clears.
    expect(
      filesTab.match(/treeSelectionMirrorTarget\(active, tab\.filePath\)/g),
    ).toHaveLength(2);
    // Separate scroll memory per tree.
    expect(filesTab).toContain('"files-design-tree"');
  });

  it("keeps the section out of the search launcher", () => {
    // A filter reorders the list anyway, so a split there would be noise.
    expect(read("../files-search-sidebar.tsx")).not.toContain("designFilter");
  });

  it("has NO synthetic rows, sort override, sticky replica, or scroll tween", () => {
    // Everything the one-list divider needed is gone from the tree: it is the
    // library's stock list again, filtered.
    const code = codeOnly(tree);
    expect(code).not.toContain("DESIGN_");
    expect(code).not.toMatch(/\bsort:/);
    expect(code).not.toContain("data-design-divider-sticky");
    expect(code).not.toContain("requestAnimationFrame");
    expect(code).not.toContain("translateY");
    expect(tree).toContain("filterDesignListing(");
    expect(tree).toContain("designSectionDirectories(");
  });

  it("splits the SEED and the ignored entries too, not just the loaded listing", () => {
    // The seed is what the first paint shows; ignored entries inside the
    // document belong to its tree.
    expect(tree).toMatch(
      /reconcileTreePathList\(splitListing\(warm, designFilterRef\.current\)\)/,
    );
    expect(tree).toMatch(
      /filterDesignListing\(\s*rawIgnoredPaths,\s*filter,\s*designSectionDirectories\(rawTrackedPaths\)/,
    );
  });

  it("opens to exactly HALF the column, whatever it holds — no content sizing", () => {
    // A fixed split: one folder row or a deep expanded document, the open
    // section is 50% and scrolls on its own past that. No row-count reporting
    // anywhere — the tree is not asked how tall it wants to be.
    expect(DESIGN_PANE_OPEN_FRACTION).toBe(0.5);
    expect(pane).toMatch(
      /height: collapsed\s*\? DESIGN_PANE_HEADER_HEIGHT \+ DESIGN_PANE_BORDER\s*: `\$\{DESIGN_PANE_OPEN_FRACTION \* 100\}%`/,
    );
    expect(pane).toMatch(/collapsed && settled && "hidden"/);
    expect(codeOnly(pane)).not.toMatch(
      /contentHeight|max-h-|onContentHeightChange/,
    );
    expect(codeOnly(tree)).not.toMatch(/onContentHeightChange|attributeFilter/);
  });

  it("keeps the tree MOUNTED while collapsed, so expansion and scroll survive", () => {
    // Hidden, not unmounted: reopening shows exactly the folders and scroll
    // position the user left, at the last content height.
    expect(pane).toMatch(/collapsed && settled && "hidden"/);
    expect(pane).toMatch(/active=\{active && !collapsed\}/);
    expect(codeOnly(pane)).not.toMatch(/\{!collapsed && \(/);
  });

  it("gives the section's tree 4px of top padding, the code tree its default", () => {
    expect(pane).toMatch(/const DESIGN_PANE_TREE_PAD_TOP = 4;/);
    expect(pane).toMatch(/paddingTop=\{DESIGN_PANE_TREE_PAD_TOP\}/);
    expect(tree).toMatch(/paddingTop = TREE_CONTENT_PAD_TOP,/);
    expect(filesTab).not.toContain("paddingTop=");
  });

  it("trails the label with the chevron, hidden until hover while collapsed", () => {
    // Label first, chevron after it. Collapsed, the header is a quiet footer
    // label: the chevron is in the DOM (hit target, a11y) but only paints on
    // hover or keyboard focus of the header.
    expect(pane).toMatch(
      /<span className="truncate">\{DESIGN_FILES_LABEL\}<\/span>\s*\{\/\*[\s\S]*?\*\/\}\s*\{collapsed \? \(\s*<ChevronRight/,
    );
    expect(pane).toMatch(
      /<ChevronRight className="[^"]*opacity-0[^"]*group-hover:opacity-100[^"]*group-focus-visible:opacity-100/,
    );
    expect(pane).toMatch(/className="group /);
    expect(pane).toMatch(/<ChevronDown className="size-3\.5 shrink-0" \/>/);
  });

  it("slides open and closed, and only hides the tree once the slide has settled", () => {
    // Height animates because both ends are lengths (never `auto`); the section
    // clips the tree meanwhile and the body fades with it. Hiding before the
    // slide ends would make the tree vanish on the first frame of a collapse.
    expect(pane).toMatch(
      /overflow-hidden border-t transition-\[height\] duration-200 ease-out motion-reduce:transition-none/,
    );
    expect(pane).toMatch(/transition-opacity duration-200/);
    expect(pane).toMatch(/onTransitionEnd=\{onTransitionEnd\}/);
    expect(pane).toMatch(/event\.propertyName !== "height"/);
    // Fallback for when no transitionend arrives (reduced motion, hidden tab).
    expect(pane).toMatch(/DESIGN_PANE_SLIDE_MS \+ 50/);
    expect(pane).toMatch(/const DESIGN_PANE_SLIDE_MS = 200;/);
    // Opening un-hides FIRST and starts the slide a frame later: a display:none
    // body has no opacity to transition from, so a one-commit open would pop.
    expect(pane).toMatch(
      /setSettled\(false\);\s*requestAnimationFrame\(\(\) => setCollapsed\(false\)\);/,
    );
  });

  it("is a real disclosure: a button with aria-expanded, persisted per workspace", () => {
    expect(pane).toMatch(/<button[\s\S]{0,200}aria-expanded=\{!collapsed\}/);
    expect(pane).toContain("loadDesignPaneCollapsed(cwd)");
    expect(pane).toContain("saveDesignPaneCollapsed(cwd, true)");
    expect(pane).toContain("saveDesignPaneCollapsed(cwd, false)");
    expect(pane).toContain('data-testid="design-files-header"');
    expect(pane).toContain('data-testid="design-files-section"');
  });

  it("puts NO padding on the scroll container, in either direction", () => {
    // @pierre/trees derives its own scroll maximum from `itemCount × itemHeight`
    // and writes scrollTop back to it, so padding inside that box is range the
    // library takes away again. The gaps live on the light-DOM root instead.
    const cssStart = tree.indexOf("const TREE_SHADOW_CSS");
    const cssEnd = tree.indexOf("const EMPTY_FILE_PATHS");
    expect(cssStart).toBeGreaterThanOrEqual(0);
    expect(cssEnd).toBeGreaterThan(cssStart);
    const css = tree.slice(cssStart, cssEnd);
    const scrollerRule =
      css.match(
        /\[data-file-tree-virtualized-scroll='true'\] \{([^}]*)\}/,
      )?.[1] ?? null;
    expect(scrollerRule).toBeNull();
    expect(tree).toMatch(/\.\.\.TREE_THEME_VARS,\s*paddingTop,/);
    expect(tree).toMatch(/paddingBottom: TREE_CONTENT_PAD_BOTTOM/);
  });

  it("labels the section from the shared constant", () => {
    expect(DESIGN_FILES_LABEL).toBe("Design files");
    expect(pane).toContain("{DESIGN_FILES_LABEL}");
  });
});
