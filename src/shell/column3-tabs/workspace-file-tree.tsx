// ──────────────────────────────────────────────────────────
// WorkspaceFileTree — @pierre/trees workspace file tree
// ──────────────────────────────────────────────────────────
//
// The virtualized, gitignore-aware file tree behind TWO surfaces:
//   • the row-1 File tab's SIDEBAR (FilesTab) — persistent selection that
//     mirrors the tab's open file (`selectedPath`), with the built-in
//     filter bar (`search`); clicking a file navigates the same tab.
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
  useEffect,
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
import { ancestorDirPrefixes, treeSelectionMirrorIntent } from "./tree-paths";
import { useScrollMemory } from "../scroll-memory";

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
  "--trees-padding-inline-override": "10px",
  "--trees-scrollbar-gutter-override": "0px",
  // Text: muted default so the selected row (bright) stands out.
  "--trees-fg-override": "var(--fg2)",
  "--trees-fg-muted-override": "var(--fg3)",
  "--trees-selected-fg-override": "var(--fg1)",
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
} as React.CSSProperties;

// Folders render a disclosure chevron ("dropdown") by default. We hide it
// and paint a Lucide `folder` glyph in the icon slot via a CSS mask,
// injected into the tree's shadow root through `unsafeCSS`. Files keep
// their colored type icons untouched. Selectors verified against the
// shipped stylesheet: [data-item-type='folder'] > [data-item-section='icon'].
const FOLDER_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'/%3E%3C/svg%3E\") center / contain no-repeat";
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
  /* Filter input (the \`search\` surfaces only) = the tree column's header —
     breathing room so it doesn't sit cramped against the chrome above.
     Inert when the search bar is disabled. */
  [data-file-tree-search-container] {
    padding-top: 8px;
    padding-bottom: 4px;
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
  /** Bump to force a re-list (e.g. the Source panel's Refresh button). */
  reloadKey?: number;
  /** Owner-keyed scroll memory for the library's Shadow-DOM virtual scroller.
   * Omit for launcher trees whose short-lived position is not navigation. */
  scrollMemoryKey?: string;
  /** Extra classes for the root (sizing). Theme vars + bg already live here. */
  className?: string;
}

export function WorkspaceFileTree({
  cwd,
  initialSelectedPath,
  selectedPath,
  search,
  onOpenFile,
  onOpenInNewTab,
  onCopyPath,
  deselectAfterOpen,
  reloadKey,
  scrollMemoryKey,
  className,
}: WorkspaceFileTreeProps) {
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
  const paths = useMemo(
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

  // Feed paths into the tree imperatively — resetPaths swaps the set
  // without recreating the tree (keeps selection/focus where possible).
  useLayoutEffect(() => {
    model.resetPaths(paths);
    const initial = initialPathRef.current;
    if (paths.length && initial) {
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
  }, [model, paths]);

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
  useEffect(() => {
    const last = selected[selected.length - 1];
    if (!last) return;
    const item = model.getItem(last);
    if (!item || item.isDirectory()) return;
    // A selection the MIRROR itself just applied (the effect below) must
    // not echo back through onOpenFile — the file is already the caller's
    // open path, and re-opening it would clobber its entry-point intent
    // (e.g. flip a Changes-opened Diff view back to Edit).
    if (selectedPathRef.current != null && last === selectedPathRef.current)
      return;
    // Start the exact file read before the selection callback performs its
    // urgent tab update. The viewer joins this keyed request instead of
    // scheduling a second IPC after it mounts.
    prefetchWorkspaceFileRead(cwdRef.current, last);
    onOpenFileRef.current(last);
    // Launcher mode: drop the selection so a second click on the SAME file is
    // a real selection change (and thus re-opens it). Without this, the tree
    // keeps `last` selected, useFileTreeSelection dedups the identical next
    // selection, and this effect never re-fires — a dead click once the file's
    // row-1 tab has been closed. The resulting empty selection re-runs this
    // effect once with no `last` (a harmless no-op), not a loop.
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
      className={cn("bg-bg1 h-full min-h-0 overflow-hidden", className)}
      style={TREE_THEME_VARS}
    >
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
}

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
