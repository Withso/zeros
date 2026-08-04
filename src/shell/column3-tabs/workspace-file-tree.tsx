// ──────────────────────────────────────────────────────────
// WorkspaceFileTree — @pierre/trees workspace file tree
// ──────────────────────────────────────────────────────────
//
// The virtualized, gitignore-aware file tree behind TWO surfaces:
//   • the row-1 File tab's SIDEBAR (FilesTab) — persistent selection that
//     mirrors the tab's open file (`selectedPath`); its shared outer header
//     drives search through WorkspaceFileTreeHandle.
//   • a LAUNCHER (deselectAfterOpen, historically row 2's "All Files") — a launcher
//     (deselectAfterOpen) with no selection mirror and no search bar.
//
// It owns the tree model, the workspace file listing
// (listWorkspaceFiles — the same gitignore-aware listing the @-mention
// picker uses), the selection→open wiring, the shadow-DOM theme bridge,
// and the right-click menu. What "open" MEANS is left to the caller via
// onOpenFile / onOpenInNewTab.
//
// Theming: the tree renders in a Shadow DOM, so global CSS can't reach
// it — but CSS variables inherit through the boundary. We map the tree's
// `--trees-*-override` knobs to live Zeros tokens on this component's
// root, so colors track theme switches automatically with zero JS.
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react";

import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
} from "../workspace-files-cache";
import { prefetchWorkspaceFileRead } from "../workspace-file-data-cache";
import { isNativeRuntime, nativeInvoke } from "@/native/runtime";
import { cn } from "@/zeros/ui/cn";
import {
  ancestorDirPrefixes,
  treeSelectionMirrorIntent,
  treeSelectionOpenTarget,
} from "./tree-paths";
import { useScrollMemory } from "../scroll-memory";
import { ignoredPathDelta, useIgnoredEntries } from "./ignored-entries";

/** Horizontal inset of every tree row AND of the search row (the library uses
 *  one `--trees-padding-inline` for both). Shared with the search-row overlay
 *  below, so the accessory's right edge lands on the same inset as the
 *  input's left border. */
const TREE_PADDING_INLINE = 10;

/** Bridge the tree's Shadow-DOM theme knobs to live Zeros tokens. CSS
 *  variables inherit across the shadow boundary, so these track theme
 *  switches with no re-computation. Set on the component root so they
 *  inherit into the tree's shadow root. */
const TREE_THEME_VARS = {
  // Folder column = column 3's --bg1 surface; hover/selected follow the
  // bg1-surface recipes (hover → bg1-hover, selected chip → bg2-hover).
  "--trees-bg-override": "var(--bg1)",
  "--trees-bg-muted-override": "var(--bg1-hover)", // hovered row
  "--trees-selected-bg-override": "var(--bg2-hover)", // selected row
  // Symmetric 8px inset on both column edges. The lib's scroll container pads
  // `padding-inline − item-margin-x` on the left and subtracts the scrollbar
  // gutter again on the right, so the default (16 − 2 = 14px left, −6px gutter
  // = 8px right) reads lopsided. Drop the gutter reservation to 0 and set
  // padding-inline to 10px → both sides resolve to 10 − 2 = 8px.
  "--trees-padding-inline-override": `${TREE_PADDING_INLINE}px`,
  "--trees-scrollbar-gutter-override": "0px",
  // Text: muted default so the selected row (bright) stands out.
  "--trees-fg-override": "var(--fg2)",
  "--trees-fg-muted-override": "var(--fg3)",
  "--trees-selected-fg-override": "var(--fg1)",
  // .gitignore'd rows (node_modules/, dist/, .env …) read one step back from
  // the tracked files around them. NOTE this is --fg3, not --fg2: --fg2 is
  // already every ordinary row's colour above, so "ignored = fg2" would render
  // identically to tracked and the distinction would be invisible. --fg3 is
  // the tree's existing muted step.
  "--trees-git-ignored-color-override": "var(--fg3)",
  // Filter matches (the `search` surfaces only): matched substrings render
  // brighter + bolder than the muted row text. Inert without a search bar.
  "--trees-search-fg-override": "var(--fg1)",
  "--trees-search-font-weight-override": "600",
  "--trees-border-color-override": "var(--border1)",
  "--trees-accent-override": "var(--highlighted-bright)",
  // No visible focus/selection BORDER — clicking a row shows the
  // selection via its background only (kills the white outline bug).
  "--trees-focus-ring-color-override": "transparent",
  "--trees-selected-focused-border-color-override": "transparent",
  // Nesting step. The library advances each level by level-gap + item row
  // gap (6px) + half the icon width (8px), so its 8px default reads ~22px
  // per level — too airy for a file tree. 2px lands ~15.5px per level while
  // the guides stay centered under their parent folder icons.
  "--trees-level-gap-override": "2px",
} as React.CSSProperties;

/** The same knobs re-based onto the floating-popover surface (--bg3, which is
 *  one lift step above --bg1 in dark). Rows follow the bg3 recipes the menu
 *  primitives use (hover → bg3-hover, like CommandItem); the selected chip
 *  keeps the base tree's bg2-hover step so a focused search match still reads
 *  over a hovered row. Used by the collapsed Files tab's floating panel. */
const TREE_OVERLAY_THEME_VARS = {
  ...TREE_THEME_VARS,
  "--trees-bg-override": "var(--bg3)",
  "--trees-bg-muted-override": "var(--bg3-hover)",
} as React.CSSProperties;

// Folders render a disclosure chevron ("dropdown") by default. We hide it
// and paint a Lucide `folder` glyph in the icon slot via a CSS mask,
// injected into the tree's shadow root through `unsafeCSS`. Files keep
// their colored type icons untouched. Selectors verified against the
// shipped stylesheet: [data-item-type='folder'] > [data-item-section='icon'].
const FOLDER_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'/%3E%3C/svg%3E\") center / contain no-repeat";

// ── Search-row geometry ────────────────────────────────────
// The filter input lives in the tree's SHADOW ROOT, so a React control can't
// be a sibling of it. A `searchRowAccessory` is therefore rendered in the light
// DOM and positioned into a gutter that the shadow CSS reserves at the END of
// the search row: the input is `flex: 1` inside the row container, so padding
// on the container's trailing edge shortens the input by exactly that much and
// the accessory sits BESIDE it, not over it. That only lines up if both sides
// agree on the numbers, so they live here once and are consumed twice: by
// TREE_SHADOW_CSS (inside the shadow root) and by the overlay (outside it).
const SEARCH_ROW_TOP_PAD = 8;
/** The library's default item height, pinned so the overlay can rely on it. */
const SEARCH_ROW_INPUT_HEIGHT = 30;
/** The input's own `margin-block`, from the shipped stylesheet. */
const SEARCH_ROW_INPUT_MARGIN = 1;
const SEARCH_ROW_ACCESSORY_SIZE = 24;
/** Gap between the input's right border and the accessory beside it. */
const SEARCH_ROW_ACCESSORY_GAP = 4;
const TREE_SHADOW_CSS = `
  /* The lib's base layer sets \`color-scheme: light dark\` on :host, which
     makes its light-dark() colors (file-type icon palette, git-status tints)
     follow the OS appearance — not the app theme. \`inherit\` pulls the
     document's resolved scheme (zeros-tokens.css sets color-scheme per
     data-theme) through the shadow boundary instead, so a forced-light app on
     a dark-mode Mac still gets the light icon palette. This wins because
     unsafeCSS lands in the lib's LAST cascade layer (base, unsafe). */
  :host {
    color-scheme: inherit;
  }
  /* Folder rows: hide the disclosure chevron (kept for hit-testing) and
     paint a Lucide folder glyph in its place. Files keep type icons. */
  [data-item-type='folder'] > [data-item-section='icon'] > [data-icon-name='file-tree-icon-chevron'] {
    opacity: 0;
  }
  [data-item-type='folder'] > [data-item-section='icon'] {
    position: relative;
  }
  [data-item-type='folder'] > [data-item-section='icon']::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-color: var(--fg2);
    -webkit-mask: ${FOLDER_MASK};
    mask: ${FOLDER_MASK};
  }
  /* An ignored folder's glyph is painted by the mask above, whose colour is a
     LITERAL — the library's git-status rule sets \`color\`, which a mask ignores,
     so without this the row's name dims to --fg3 and its folder icon stays
     --fg2. The opacity reset matters too: the library already applies
     \`opacity: .5\` to an ignored row's icon section, and --fg3 at half opacity is
     a second dimming step on top of the one we asked for. One step, here. */
  [data-item-git-status='ignored'] > [data-item-section='icon'] {
    opacity: 1;
  }
  [data-item-git-status='ignored'] > [data-item-section='icon']::after {
    background-color: var(--fg3);
  }
  /* We pass \`gitStatus\` for ONE reason: to mark ignored entries. Supplying it
     at all switches on the library's git lane, which (a) reserves
     --trees-git-lane-width on EVERY row, indenting the whole tree, and (b)
     paints a "contains changes" dot on every ancestor of every entry — so a
     package folder holding a nested node_modules/ would sprout a change dot it
     never had. The lane carries nothing we want (an ignored row has no status
     letter by design, and Changes is where git state lives in this app).
     Switching it off recovers the indent and the dot; it does NOT restore the
     pre-change DOM — passing gitStatus also enables the library's decoration
     lane, so every row now carries an extra empty \`[data-item-section=
     'decoration']\` div. That one is harmless (\`flex: 1 1 0; min-width: 0\`
     against a \`flex: 0 1 auto\` content box) and is left alone. */
  [data-item-section='git'] {
    display: none;
  }
  /* Filter input (the \`search\` surfaces only) = the tree column's header —
     breathing room so it doesn't sit cramped against the chrome above.
     Inert when the search bar is disabled. */
  [data-file-tree-search-container] {
    padding-top: ${SEARCH_ROW_TOP_PAD}px;
    padding-bottom: 4px;
  }
  /* Pin the input's height rather than inheriting --trees-row-height. A
     \`searchRowAccessory\` is a LIGHT-DOM control positioned beside this box from
     outside the shadow root, and a shadow-scoped custom property can't be read
     from out there — so both sides derive from the same constants instead, and
     a change to the library's density default can't silently drift the control
     off the row. 30px is the library's own default item height. */
  [data-file-tree-search-input] {
    box-sizing: border-box;
    height: ${SEARCH_ROW_INPUT_HEIGHT}px;
    line-height: ${SEARCH_ROW_INPUT_HEIGHT - 2}px;
    /* The input is \`flex: 1\`, but a flex item won't shrink past its intrinsic
       min-content width — for an <input> that's its \`size\` default (~214px),
       so it overflowed the row on any sidebar under ~234px (the drag floor is
       140px). Harmless-looking until the row has to reserve a gutter: the
       overflowing input would slide straight back under the accessory. */
    min-width: 0;
  }
  /* Reserve the accessory's gutter at the END of the row. The container is the
     library's flex row and the input is its only \`flex: 1\` child, so trailing
     padding here shortens the INPUT — which is what puts the control outside
     it. The left inset stays on --trees-padding-inline. */
  :host([data-search-accessory='true']) [data-file-tree-search-container] {
    padding-inline-end: ${TREE_PADDING_INLINE + SEARCH_ROW_ACCESSORY_GAP + SEARCH_ROW_ACCESSORY_SIZE}px;
  }
  /* Indent guides are structure, not a hover affordance. The library ships
     them hidden (opacity 0) and fades them in only under :host(:hover) — so
     the tree's nesting vanished whenever the pointer left the column. Pin the
     library's own hover opacity permanently; the :host(:hover) rule then
     changes nothing. */
  [data-item-section='spacing-item'] {
    opacity: 0.75;
  }
`;

const EMPTY_FILE_PATHS: string[] = [];

/** Basename of a POSIX repo-relative path. Exported so callers labelling a
 *  tab from a tree path don't re-implement it. */
export function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function joinPath(cwd: string, rel: string): string {
  return cwd.endsWith("/") ? cwd + rel : `${cwd}/${rel}`;
}

/** A repo-relative POSIX path that stays inside the workspace — no
 *  absolute paths, no `..` escapes. Mirrors the read_file IPC gate so the
 *  shell-reveal call site can't be pointed outside cwd, keeping the two
 *  Files-tab IPCs consistent (reveal_in_finder is a shared handler that
 *  doesn't enforce workspace containment itself). */
function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split("/").some((seg) => seg === "..");
}

interface WorkspaceFileTreeProps {
  /** Workspace/worktree folder whose files to list (the repo root the tree
   *  paths are relative to). Undefined → an empty tree until one resolves. */
  cwd: string | undefined;
  /** Pre-select + scroll to this file on first mount (FilesTab passes the
   *  tab's open file; the Source "All Files" view omits it). Captured once. */
  initialSelectedPath?: string | null;
  /** Selection MIRROR (the row-1 File-tab sidebar): whenever this changes to a
   *  path the tree isn't already selected on, its branch is expanded, the row
   *  selected, and the tree scrolled there — so external navigation (a Changes
   *  click swapping the active tab's file in place) keeps the sidebar honest.
   *  `null` explicitly clears the selection; `undefined` omits/suspends the
   *  mirror for launcher surfaces or while the surface is hidden, so it can
   *  re-assert on tab re-activation. A programmatic mirror never echoes back
   *  through onOpenFile. */
  selectedPath?: string | null;
  /** Show the tree's built-in filter ("search") bar as the column header
   *  (the row-1 sidebar). Captured once at mount. Default off (launcher). */
  search?: boolean;
  /** A control to sit at the RIGHT END OF THE SEARCH ROW, OUTSIDE the filter
   *  input (the Working-folders picker). That input is inside the library's
   *  shadow root, so this can't be a real sibling of it: the row reserves a
   *  trailing gutter — which shortens the input — and this is rendered in the
   *  light DOM into that gutter, both sides using the shared geometry
   *  constants above. Ignored without `search`, the only surface with a row
   *  for it to sit in. */
  searchRowAccessory?: React.ReactNode;
  /** A FILE row was activated (selected). Folders are filtered out before
   *  this fires. Read through a ref so the selection effect only runs on a
   *  real selection change — not when this callback's identity churns. */
  onOpenFile: (path: string) => void;
  /** "Open in new tab" context-menu action. Omit to hide the menu item. */
  onOpenInNewTab?: (path: string) => void;
  /** Copy-path action. Defaults to writing the path to the clipboard. */
  onCopyPath?: (path: string) => void;
  /** Launcher mode: clear the tree selection right after onOpenFile fires, so
   *  the tree never holds a sticky selection. Use this when "open" targets a
   *  SEPARATE, closable surface (the Source "All Files" tab opens a row-1 File
   *  tab) — otherwise re-clicking the already-selected file is a dead click,
   *  because useFileTreeSelection dedups identical selections and the effect
   *  never re-fires. FilesTab leaves this off so its selection highlight
   *  persists (its viewer mirrors the selected row). */
  deselectAfterOpen?: boolean;
  /** Surface the tree sits on. "base" (default) — the column's --bg1, the
   *  sidebar recipes. "overlay" — a floating popover (--bg3): the root and
   *  row states swap to the popover recipes so the popup reads as one
   *  surface (in dark, bg3 is a visible lift step above bg1). */
  surface?: "base" | "overlay";
  /** Bump to force a re-list (e.g. the Source panel's Refresh button). */
  reloadKey?: number;
  /** Owner-keyed scroll memory for the library's Shadow-DOM virtual scroller.
   * Omit for launcher trees whose short-lived position is not navigation. */
  scrollMemoryKey?: string;
  /** Extra classes for the root (sizing). Theme vars + bg already live here. */
  className?: string;
}

/** Imperative search bridge for hosts that place their filter in shared chrome
 * outside the tree's Shadow DOM (the Files tab's full-width header row). */
export interface WorkspaceFileTreeHandle {
  setSearch: (value: string) => void;
  focusNextSearchMatch: () => void;
  focusPreviousSearchMatch: () => void;
}

export const WorkspaceFileTree = React.forwardRef<
  WorkspaceFileTreeHandle,
  WorkspaceFileTreeProps
>(function WorkspaceFileTree(
  {
    cwd,
    initialSelectedPath,
    selectedPath,
    search,
    searchRowAccessory,
    onOpenFile,
    onOpenInNewTab,
    onCopyPath,
    surface = "base",
    deselectAfterOpen,
    reloadKey,
    scrollMemoryKey,
    className,
  },
  ref,
) {
  // Seed the model from the shared snapshot in the very first render. The old
  // `[]` seed guaranteed a visible empty-tree paint followed by row-by-row
  // reconstruction in an effect whenever a File surface remounted.
  const initialPathsRef = useRef(
    cwd ? (peekWorkspaceFiles(cwd) ?? EMPTY_FILE_PATHS) : EMPTY_FILE_PATHS,
  );
  const [pathsSnapshot, setPathsSnapshot] = useState<{
    cwd: string | undefined;
    paths: string[];
  }>(() => ({ cwd, paths: initialPathsRef.current }));
  // A reused tree fiber can receive another workspace before its load effect
  // runs. Associate rows with their cwd and synchronously use that cwd's warm
  // snapshot; never expose the prior workspace's paths under the new chrome.
  const trackedPaths = useMemo(
    () =>
      pathsSnapshot.cwd === cwd
        ? pathsSnapshot.paths
        : cwd
          ? (peekWorkspaceFiles(cwd) ?? EMPTY_FILE_PATHS)
          : EMPTY_FILE_PATHS,
    [cwd, pathsSnapshot],
  );

  // Captured once: a pre-opened tree starts focused on its file. Read via
  // ref so the model is created exactly once (the memo deps stay empty).
  const initialPathRef = useRef(initialSelectedPath ?? undefined);
  // Captured once, like every other model option: whether this surface shows
  // the built-in filter bar is static per surface (sidebar yes, launcher no).
  const searchRef = useRef(search === true);
  const { model } = useFileTree(
    useMemo(
      () => ({
        paths: initialPathsRef.current,
        // The filter bar is per-surface: the row-1 sidebar shows it (the
        // reference design's "Filter files" header); the launcher mode
        // stays bare — a dedicated workspace search is its own surface.
        search: searchRef.current,
        initialExpansion: "closed" as const,
        flattenEmptyDirectories: true,
        icons: { set: "complete" as const, colored: true },
        unsafeCSS: TREE_SHADOW_CSS,
        composition: { contextMenu: { enabled: true } },
        ...(initialPathRef.current
          ? { initialSelectedPaths: [initialPathRef.current] }
          : {}),
      }),
      [],
    ),
  );

  // The Files tab owns a native Zeros Input in its shared header row. Bridge
  // that input directly into this stable tree model; search never performs a
  // file-list read and keeps the library's match/highlight behavior intact.
  useImperativeHandle(
    ref,
    () => ({
      setSearch: (value) => model.setSearch(value || null),
      focusNextSearchMatch: () => model.focusNextSearchMatch(),
      focusPreviousSearchMatch: () => model.focusPreviousSearchMatch(),
    }),
    [model],
  );

  // The .gitignore'd side of the worktree — node_modules/, dist/, .env — which
  // `git ls-files` deliberately omits and which the user's setup script and
  // agents are exactly what creates. Lazy: roots now, a directory's children
  // when it's opened. Feeds the model directly for the incremental adds and
  // the ignored colouring; we merge its paths into `paths` below so a reset
  // (a git refresh) rebuilds the tree WITH them.
  const { paths: ignoredPaths, expandedDirs } = useIgnoredEntries(
    cwd,
    reloadKey,
    model,
  );
  // The two lists come from different git queries against a worktree that is
  // being written to, so they can disagree — and EVERY form of disagreement is a
  // throw from the tree store, inside a layout effect, which unwinds to the ROOT
  // error boundary and blanks the whole window (not just this tab). Three shapes,
  // all reconciled here rather than caught downstream:
  //
  //   • the same path twice          → "Duplicate path"
  //   • ignored `x/` + tracked `x`   → "Path collides with an existing entry"
  //   • ignored `x`  + tracked `x/…` → "…collides with an existing file while
  //                                     creating directory"
  //
  // The last two are reachable the moment a path changes KIND between the two
  // queries: `src/generated` is a tracked file, the dev turns it into a
  // gitignored directory, and the ~6ms ignored query reports `src/generated/`
  // while the cached tracked snapshot still says `src/generated`. Tracked always
  // wins — it is the listing the tab existed for, and the ignored side
  // self-corrects on the next refresh.
  //
  // `appliedIgnored` is the SAME filtered list, returned alongside so the
  // incremental delta below describes exactly the rows the ignored branch owns.
  // Diffing unfiltered `ignoredPaths` made it claim rows the tracked listing had
  // put in the store, which then produced an `add` for a path already there
  // (throw → full rebuild) or, worse, a silent `remove` of a tracked row.
  const { paths, appliedIgnored } = useMemo(() => {
    if (ignoredPaths.length === 0) {
      return { paths: trackedPaths, appliedIgnored: EMPTY_FILE_PATHS };
    }
    const trackedKinds = new Set<string>();
    for (const p of trackedPaths) {
      trackedKinds.add(p);
      for (const dir of ancestorDirPrefixes(p)) trackedKinds.add(`${dir}/`);
    }
    const keep = ignoredPaths.filter(
      (p) =>
        !trackedKinds.has(p) &&
        !trackedKinds.has(p.endsWith("/") ? p.slice(0, -1) : `${p}/`),
    );
    return {
      paths: keep.length > 0 ? [...trackedPaths, ...keep] : trackedPaths,
      appliedIgnored: keep,
    };
  }, [trackedPaths, ignoredPaths]);

  // @pierre/trees owns the actual virtual scroller inside an open ShadowRoot.
  // Observe the host because the library creates that node from its own child
  // layout effect; a parent callback ref alone can run one commit too early.
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const [treeScrollEl, setTreeScrollEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const host = treeRootRef.current?.querySelector("file-tree-container");
    const shadow = host?.shadowRoot;
    if (!shadow) {
      setTreeScrollEl(null);
      return;
    }
    const connect = () => {
      const next = shadow.querySelector<HTMLElement>(
        "[data-file-tree-virtualized-scroll='true']",
      );
      if (next)
        setTreeScrollEl((current) => (current === next ? current : next));
      return next !== null;
    };
    if (connect()) return;
    const observer = new MutationObserver(() => {
      if (connect()) observer.disconnect();
    });
    observer.observe(shadow, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [model]);
  useScrollMemory(treeScrollEl, scrollMemoryKey ?? null);

  // Tell the shadow stylesheet an accessory is present, so it reserves the
  // trailing padding for it. An attribute on the HOST (rather than a class on
  // our root) is what `:host([data-search-accessory])` can see from inside.
  const hasSearchAccessory = searchRef.current && searchRowAccessory != null;
  useLayoutEffect(() => {
    const host = treeRootRef.current?.querySelector("file-tree-container");
    if (!host) return;
    if (hasSearchAccessory) host.setAttribute("data-search-accessory", "true");
    else host.removeAttribute("data-search-accessory");
  }, [hasSearchAccessory, model]);

  // Load (and reload) the workspace file list for this cwd. `reloadKey`
  // lets a parent (the Source Refresh button) force a re-list.
  useEffect(() => {
    if (!cwd) {
      setPathsSnapshot({ cwd: undefined, paths: EMPTY_FILE_PATHS });
      return;
    }
    let cancelled = false;
    // Ordinary remounts may reuse the short-lived cache. A real refresh signal
    // invalidates this cwd in useGitRefreshKey BEFORE reloadKey changes, so a
    // create/delete always performs a fresh list and cannot serve a stale path.
    void loadWorkspaceFiles(cwd)
      .then((files) => {
        if (!cancelled) {
          setPathsSnapshot((current) =>
            current.cwd === cwd && current.paths === files
              ? current
              : { cwd, paths: files },
          );
        }
      })
      .catch(() => {
        // Keep the last exact-key tree (or a stable cold blank). A reconnect
        // advances reloadKey and retries without publishing a false empty list.
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, reloadKey]);

  // Feed paths into the tree imperatively. TWO paths, because resetPaths
  // rebuilds the store from `initialExpansion: "closed"` and therefore
  // COLLAPSES every open directory:
  //
  //   • tracked listing changed → resetPaths, as before. Ignored branches are
  //     replayed via initialExpandedPaths so a lazily-loaded `node_modules/…`
  //     doesn't shut every time an unrelated file is saved.
  //   • only the IGNORED side changed → an incremental add/remove batch. This
  //     is the common case now (a build writing into an open `dist/`, a new
  //     ignored root appearing), and routing it through resetPaths would
  //     collapse the user's `src/` browsing as collateral for a node_modules
  //     update — a regression the tracked-only listing never had.
  const expandedDirsRef = useRef(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const appliedRef = useRef<{ tracked: string[]; ignored: Set<string> } | null>(
    null,
  );
  const trackedPathsRef = useRef(trackedPaths);
  trackedPathsRef.current = trackedPaths;
  // resetPaths, but never able to take the window down with it. The store throws
  // on any duplicate or file/directory collision in its input; `paths` reconciles
  // the shapes we know about, and this is the backstop for the ones we don't —
  // degrade to "ignored files hidden", which is the pre-feature behaviour, rather
  // than to a blank app from the root error boundary (the only one in the app is
  // at src/main.tsx, and it replaces the entire window).
  const resetPathsSafely = useCallback(
    (next: string[], restore: readonly string[]) => {
      const opts =
        restore.length > 0 ? { initialExpandedPaths: [...restore] } : undefined;
      try {
        model.resetPaths(next, opts);
      } catch (err) {
        console.error("[files] tree rejected the merged path list:", err);
        try {
          model.resetPaths(trackedPathsRef.current, opts);
        } catch {
          model.resetPaths(EMPTY_FILE_PATHS);
        }
      }
    },
    [model],
  );
  useLayoutEffect(() => {
    const applied = appliedRef.current;
    const ignoredSet = new Set(appliedIgnored);
    if (applied && applied.tracked === trackedPaths) {
      const ops = ignoredPathDelta(applied.ignored, ignoredSet);
      appliedRef.current = { tracked: trackedPaths, ignored: ignoredSet };
      if (ops.length > 0) {
        try {
          model.batch(ops);
        } catch (err) {
          // batch does NOT roll back — an op that throws leaves the store
          // half-mutated and emits no notification, so the store and `paths`
          // would silently disagree. The rebuild is the only way back.
          console.error("[files] incremental ignored update failed:", err);
          resetPathsSafely(paths, expandedDirsRef.current);
        }
      }
      return;
    }
    resetPathsSafely(paths, expandedDirsRef.current);
    appliedRef.current = { tracked: trackedPaths, ignored: ignoredSet };
    const initial = initialPathRef.current;
    // Gate on the TRACKED listing, not the merged one: the ignored roots come
    // from a single ~6 ms git call and routinely land first, and a `paths`
    // that is only `node_modules/` + `.env` would consume this one-shot with
    // nothing to reveal — so the tab would never scroll to the file it was
    // opened on.
    if (trackedPaths.length && initial) {
      // ONE-shot: cleared after the first populated listing so a later
      // reload (reloadKey / git refresh) can't yank the tree back to the
      // mount-time file after the user browsed or navigated elsewhere.
      initialPathRef.current = undefined;
      // Expand the branch first: scrollToPath silently no-ops on a row hidden
      // inside a collapsed ancestor (initialExpansion is "closed"). The `in`
      // check narrows the file/directory handle union — only directories
      // carry expand().
      for (const dir of ancestorDirPrefixes(initial)) {
        const item = model.getItem(dir);
        if (item && "expand" in item) item.expand();
      }
      try {
        model.scrollToPath(initial, { focus: false });
      } catch {
        /* path may not exist in this workspace */
      }
    }
  }, [model, paths, trackedPaths, appliedIgnored, resetPathsSafely]);

  // Selection → open. Folders are skipped (the tree owns expand/collapse).
  // The latest onOpenFile is read through a ref so this effect fires ONLY
  // when the selection changes — not when onOpenFile's identity churns
  // (e.g. the dedup handler that closes over the live tab list), which
  // would otherwise re-open/re-activate the same file on unrelated tab
  // mutations.
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  // Latest mirror target, read inside the effects below without re-running
  // them on every prop identity change.
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const selected = useFileTreeSelection(model);
  // Latest live selection for the mirror effect — reading it via ref keeps
  // the mirror from re-running (and fighting a just-clicked row) on every
  // selection change.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // The previous publication, so only a NEWLY selected row can open a file —
  // see treeSelectionOpenTarget. Updated on every publication (including the
  // ones that open nothing) to mirror exactly what the user last saw selected.
  const prevSelectedRef = useRef<readonly string[]>([]);
  useEffect(() => {
    const prevSelected = prevSelectedRef.current;
    prevSelectedRef.current = selected;
    // Both echo guards (mirror echo + re-publication echo) live in the pure
    // helper. Without the re-publication guard, closing the fixed Files
    // home's file while its tree was expanded re-opened the file instantly:
    // the revert clears the mirror target, so a re-emitted selection of the
    // still-known row sailed straight through the mirror guard.
    const target = treeSelectionOpenTarget(
      prevSelected,
      selected,
      selectedPathRef.current,
    );
    if (!target) return;
    const item = model.getItem(target);
    if (!item || item.isDirectory()) return;
    // Start the exact file read before the selection callback performs its
    // urgent tab update. The viewer joins this keyed request instead of
    // scheduling a second IPC after it mounts.
    prefetchWorkspaceFileRead(cwdRef.current, target);
    onOpenFileRef.current(target);
    // Launcher mode: drop the selection so a second click on the SAME file is
    // a real selection change (and thus re-opens it). Without this, the tree
    // keeps `target` selected, useFileTreeSelection dedups the identical next
    // selection, and this effect never re-fires — a dead click once the file's
    // row-1 tab has been closed. The resulting empty selection re-runs this
    // effect once with no target (a harmless no-op), not a loop.
    if (deselectAfterOpen) item.deselect();
  }, [selected, model, deselectAfterOpen]);

  // Selection MIRROR (sidebar mode): keep the selected row on `selectedPath`.
  // Runs when the target changes (external navigation swapped/cleared the open
  // file), when the listing lands (a target set before paths loaded), or when
  // the mirror is re-enabled (undefined → path on tab re-activation — heals
  // the divergence left when a click was diverted away from a dirty tab).
  // Already selected → no-op, so a user's own click never causes a scroll
  // jump. A target absent from the listing (e.g. a deleted file's tab) clears
  // any stale highlight.
  useEffect(() => {
    // `undefined` means the caller intentionally suspended the mirror (hidden
    // tab / launcher). `null` means the active blank File tab was explicitly
    // cleared, so its old row must be deselected or re-clicking it is deduped by
    // useFileTreeSelection and cannot reopen the file.
    const intent = treeSelectionMirrorIntent(selectedPath);
    if (intent.kind === "suspend" || paths.length === 0) return;
    const current = selectedRef.current;
    if (intent.kind === "clear") {
      for (const p of current) model.getItem(p)?.deselect();
      return;
    }
    const targetPath = intent.path;
    if (current.length === 1 && current[0] === targetPath) return;
    const target = model.getItem(targetPath);
    if (!target || "expand" in target) {
      // The open file isn't in the tree (deleted / not listed): clear any
      // stale highlight rather than pointing at a file that isn't open.
      for (const p of current) model.getItem(p)?.deselect();
      return;
    }
    // Expand the branch top-down so the row is actually visible — neither
    // select() nor scrollToPath expands collapsed ancestors themselves.
    for (const dir of ancestorDirPrefixes(targetPath)) {
      const item = model.getItem(dir);
      if (item && "expand" in item) item.expand();
    }
    // "Select only": the public model exposes per-item handles, not the
    // controller's selectOnlyPath — drop the rest of the selection, then
    // select the mirror target.
    for (const p of current) {
      if (p !== targetPath) model.getItem(p)?.deselect();
    }
    target.select();
    try {
      model.scrollToPath(targetPath, { focus: false });
    } catch {
      /* defensive — scrollToPath validates its input */
    }
  }, [model, selectedPath, paths]);

  return (
    <div
      ref={treeRootRef}
      className={cn(
        "relative h-full min-h-0 overflow-hidden",
        surface === "overlay" ? "bg-bg3" : "bg-bg1",
        className,
      )}
      style={surface === "overlay" ? TREE_OVERLAY_THEME_VARS : TREE_THEME_VARS}
    >
      {hasSearchAccessory && (
        // Dropped into the gutter the shadow CSS reserves past the input's
        // right border, vertically centred on it (see the geometry constants).
        // It overlaps nothing, so it needs no pointer-events escape hatch.
        <div
          className="absolute z-10 flex items-center justify-end"
          style={{
            top: SEARCH_ROW_TOP_PAD + SEARCH_ROW_INPUT_MARGIN,
            height: SEARCH_ROW_INPUT_HEIGHT,
            right: TREE_PADDING_INLINE,
            width: SEARCH_ROW_ACCESSORY_SIZE,
          }}
        >
          {searchRowAccessory}
        </div>
      )}
      <FileTree
        model={model}
        style={{ height: "100%" }}
        renderContextMenu={(item, ctx) => (
          <TreeMenu
            isFile={item.kind === "file"}
            onOpenNewTab={
              onOpenInNewTab
                ? () => {
                    onOpenInNewTab(item.path);
                    ctx.close();
                  }
                : undefined
            }
            onCopyPath={() => {
              if (onCopyPath) onCopyPath(item.path);
              else
                void navigator.clipboard?.writeText(item.path).catch(() => {});
              ctx.close();
            }}
            onReveal={() => {
              if (cwd && isNativeRuntime() && isSafeRelPath(item.path)) {
                void nativeInvoke("reveal_in_finder", {
                  path: joinPath(cwd, item.path),
                }).catch(() => {});
              }
              ctx.close();
            }}
          />
        )}
      />
    </div>
  );
});

// ── Right-click menu ───────────────────────────────────────
// Rendered by the tree (possibly inside its shadow root), so it's styled
// with inline styles + CSS-var references rather than Tailwind classes,
// which can't cross the shadow boundary.

function TreeMenu({
  isFile,
  onOpenNewTab,
  onCopyPath,
  onReveal,
}: {
  isFile: boolean;
  /** Omitted when the host doesn't want an "Open in new tab" action. */
  onOpenNewTab?: () => void;
  onCopyPath: () => void;
  /** Omitted on the web build (no host Finder) — the item is then hidden. */
  onReveal?: () => void;
}) {
  return (
    <div
      style={{
        minWidth: 180,
        padding: 4,
        borderRadius: 8,
        background: "var(--bg2)",
        border: "1px solid var(--border1)",
        boxShadow: "var(--shadow-dropdown)",
        fontSize: 13,
        color: "var(--fg1)",
      }}
    >
      {isFile && onOpenNewTab && (
        <MenuButton label="Open in new tab" onClick={onOpenNewTab} />
      )}
      <MenuButton label="Copy path" onClick={onCopyPath} />
      {onReveal && <MenuButton label="Reveal in Finder" onClick={onReveal} />}
    </div>
  );
}

function MenuButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        borderRadius: 4,
        border: "none",
        cursor: "pointer",
        color: "inherit",
        background: hover ? "var(--bg2-hover)" : "transparent",
      }}
    >
      {label}
    </button>
  );
}
