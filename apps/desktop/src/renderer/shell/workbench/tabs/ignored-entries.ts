// Ignored entries for the Files tree, loaded lazily per directory (engine:
// git/workspace-files.ts). A repo can hold tens of thousands of ignored files
// and the tree materializes every path it gets, so roots come first (`git
// ls-files --directory` collapses an ignored directory to one trailing-slash
// row) and children load only when a directory is expanded.
//
// The tree gets a `gitStatus` entry per known ignored directory; the library
// propagates `ignored` to descendants, so no 60k-entry map is built. Covering
// directory children, not just roots, keeps this correct even with
// `flattenEmptyDirectories` on. `loaded` is pruned on collapse, so cost tracks
// what is on screen, and a mount starts from warm roots (ignored-entries-cache)
// like the tracked listing.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GitStatusEntry } from "@pierre/trees";

import { useWorkbenchStatusSource } from "../tab-status";
import { listIgnoredEntries } from "@/renderer/platform/git";

import {
  peekIgnoredRoots,
  rememberIgnoredRoots,
} from "./ignored-entries-cache";

/** @pierre/trees marks directories with a trailing slash. */
export function isDirEntry(entryPath: string): boolean {
  return entryPath.endsWith("/");
}

/** Strip the directory marker — the form the engine op wants for `dir`. */
export function dirKey(entryPath: string): string {
  return entryPath.replace(/\/+$/, "");
}

/** Every ignored path currently known: the roots plus whatever levels the user
 *  has expanded. Deduped — a root can also appear as a loaded child (a nested
 *  `packages/protocol/node_modules/` shows up in the root listing AND inside its
 *  parent's expansion), and a duplicate path would double a tree row. */
export function mergeIgnoredPaths(
  roots: readonly string[],
  loaded: ReadonlyMap<string, readonly string[]>,
): string[] {
  const seen = new Set<string>(roots);
  for (const children of loaded.values()) {
    for (const child of children) seen.add(child);
  }
  return [...seen];
}

/** Status entries for the tree: every ignored directory plus ignored root files
 *  (`.env`, `.mcp.json`); nested files inherit. Children are covered, not only
 *  roots, so this stays correct under `flattenEmptyDirectories`; collapsing
 *  prunes `loaded`, which bounds it. */
export function ignoredGitStatus(
  roots: readonly string[],
  loaded?: ReadonlyMap<string, readonly string[]>,
): GitStatusEntry[] {
  const seen = new Set<string>(roots);
  if (loaded) {
    for (const children of loaded.values()) {
      for (const child of children) if (isDirEntry(child)) seen.add(child);
    }
  }
  return [...seen].map((path) => ({ path, status: "ignored" as const }));
}

/** One incremental tree mutation. `recursive` is only meaningful for a remove. */
export type IgnoredPathOp = {
  path: string;
  type: "add" | "remove";
  recursive?: true;
};

export interface IgnoredPathDeltaPlan {
  operations: IgnoredPathOp[];
  /** @pierre/trees cannot incrementally replace an inferred directory with a
   *  file without corrupting its child index. The caller must reset from the
   *  already-reconciled full path list for this rare kind change. */
  requiresReset: boolean;
  /** The explicit ignored paths the tree actually represents after operations.
   *  This can temporarily retain a disappearing directory while a roots-first
   *  refresh still carries its previous child listing. */
  applied: ReadonlySet<string>;
}

/** The add/remove ops from `applied` to `next`. Incremental updates keep a
 *  build writing into `dist/` from collapsing open tracked directories
 *  (resetPaths rebuilds closed). The delta must be strict, since `add` throws
 *  on a held path, and removes are recursive and de-nested, since removing a
 *  non-empty directory throws and `batch` does not roll back. Staggered
 *  refreshes and kind changes need planIgnoredPathDelta; this compatibility
 *  helper returns only its operations. */
export function ignoredPathDelta(
  applied: ReadonlySet<string>,
  next: ReadonlySet<string>,
): IgnoredPathOp[] {
  return planIgnoredPathDelta(applied, next).operations;
}

/** Plan a store-safe ignored-path transition and the exact snapshot to use for
 *  the following delta.
 *
 *  Two store semantics make a plain set difference incorrect:
 *
 *  1. File/directory kind changes collide when the add runs before the old
 *     node is removed (`cache` → `cache/`). Only blocking removals move ahead
 *     of adds; ordinary adds remain first so replacing the last child in an
 *     implicit directory does not materialize a stray empty row.
 *  2. Roots and expanded children refresh independently. If `dist/` disappears
 *     one render before stale `dist/old.js`, recursively removing it destroys a
 *     path `next` still claims is present. We defer that parent removal and keep
 *     it in `applied` until the child listing catches up, then one recursive op
 *     clears the branch without a half-applied batch or fallback rebuild. */
export function planIgnoredPathDelta(
  applied: ReadonlySet<string>,
  next: ReadonlySet<string>,
): IgnoredPathDeltaPlan {
  const effectiveNext = new Set(next);
  const nextAncestorDirs = new Set<string>();
  for (const path of next) {
    visitAncestorDirs(path, (ancestor) => nextAncestorDirs.add(ancestor));
  }
  for (const path of applied) {
    if (isDirEntry(path) && !next.has(path) && nextAncestorDirs.has(path)) {
      effectiveNext.add(path);
    }
  }

  const adding: string[] = [];
  for (const path of next) {
    if (!applied.has(path)) adding.push(path);
  }
  const removing = new Set<string>();
  for (const path of applied) {
    if (!effectiveNext.has(path)) removing.add(path);
  }

  // Pre-index removals by logical path and ancestry. Expanded ignored folders
  // can contain tens of thousands of entries, so a cross-product between adds
  // and removes would turn a filesystem burst into quadratic renderer work.
  const removingByKey = new Map<string, string>();
  const removingFiles = new Set<string>();
  const removedDescendantsByAncestor = new Map<string, string[]>();
  for (const remove of removing) {
    removingByKey.set(dirKey(remove), remove);
    if (!isDirEntry(remove)) removingFiles.add(remove);
    visitAncestorDirs(remove, (ancestor) => {
      const descendants = removedDescendantsByAncestor.get(ancestor);
      if (descendants) descendants.push(remove);
      else removedDescendantsByAncestor.set(ancestor, [remove]);
    });
  }

  // A file being added where the current tree has only explicit descendants
  // collides with their implicit directory. @pierre/trees has no safe
  // incremental sequence for that transition: removing the inferred directory
  // corrupts its child index, while removing only descendants leaves the empty
  // inferred node and the add throws. Rebuild this rare shape from the already-
  // reconciled full path list instead of partially mutating the store.
  const requiresReset = adding.some(
    (add) =>
      !isDirEntry(add) &&
      (removedDescendantsByAncestor.get(`${add}/`)?.length ?? 0) > 0,
  );
  if (requiresReset) {
    return { operations: [], requiresReset: true, applied: effectiveNext };
  }

  const blocking = new Set<string>();
  for (const add of adding) {
    const samePath = removingByKey.get(dirKey(add));
    if (samePath) blocking.add(samePath);
    // An existing file must leave before a descendant can materialize its
    // implicit directory chain (`cache` -> `cache/item`).
    visitAncestorDirs(add, (ancestor) => {
      const file = dirKey(ancestor);
      if (removingFiles.has(file)) blocking.add(file);
    });
  }

  const operations: IgnoredPathOp[] = [];
  appendDenestedRemoves(operations, blocking);
  for (const path of adding) operations.push({ path, type: "add" });

  const remaining = new Set(
    [...removing].filter(
      (path) => !blocking.has(path) && !hasRemovedAncestor(path, blocking),
    ),
  );
  appendDenestedRemoves(operations, remaining);
  return { operations, requiresReset: false, applied: effectiveNext };
}

function appendDenestedRemoves(
  ops: IgnoredPathOp[],
  removing: ReadonlySet<string>,
): void {
  for (const path of removing) {
    if (hasRemovedAncestor(path, removing)) continue; // covered recursively
    ops.push(
      isDirEntry(path)
        ? { path, type: "remove", recursive: true }
        : { path, type: "remove" },
    );
  }
}

function visitAncestorDirs(path: string, visit: (directory: string) => void) {
  let slash = path.indexOf("/");
  const last = path.length - 1;
  while (slash !== -1 && slash < last) {
    visit(path.slice(0, slash + 1));
    slash = path.indexOf("/", slash + 1);
  }
}

/** True when some ancestor DIRECTORY of `p` is also in `removing`, so a
 *  recursive remove of that ancestor already covers `p`. */
function hasRemovedAncestor(p: string, removing: ReadonlySet<string>): boolean {
  let slash = p.indexOf("/");
  const last = p.length - 1;
  while (slash !== -1 && slash < last) {
    if (removing.has(p.slice(0, slash + 1))) return true;
    slash = p.indexOf("/", slash + 1);
  }
  return false;
}

/** Ignored directories whose children we have NOT fetched yet — the set the
 *  expansion watcher polls. Bounded by what the user has actually opened. */
export function pendingIgnoredDirs(
  roots: readonly string[],
  loaded: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  const consider = (entryPath: string) => {
    if (!isDirEntry(entryPath)) return;
    const key = dirKey(entryPath);
    if (!loaded.has(key)) out.push(key);
  };
  for (const root of roots) consider(root);
  for (const children of loaded.values()) {
    for (const child of children) consider(child);
  }
  return out;
}

/** The subset of the tree model this hook needs — narrowed so the pure logic
 *  above stays testable without a DOM or the real library. */
export interface IgnoredTreeModel {
  getItem(path: string): { isDirectory(): boolean } | null;
  subscribe(listener: () => void): () => void;
  setGitStatus(entries: readonly GitStatusEntry[] | undefined): void;
}

export interface IgnoredEntriesState {
  /** True after an exact-workspace roots listing has succeeded. */
  resolved: boolean;
  /** Ignored paths to merge into the tree's path list. */
  paths: string[];
  /** Directories we've expanded and loaded — passed to resetPaths as
   *  `initialExpandedPaths` so a refresh doesn't slam the branch shut. */
  expandedDirs: string[];
}

/** Load a workspace's ignored entries and keep them growing as the user
 *  expands. `model` may be null before the tree exists. */
export function useIgnoredEntries(
  cwd: string | undefined,
  reloadKey: number | undefined,
  model: IgnoredTreeModel | null,
  enabled = true,
  fileStatus?: readonly GitStatusEntry[],
): IgnoredEntriesState {
  const [state, setState] = useState<IgnoredState>(() => warmState(cwd));
  const [failure, setFailure] = useState<{
    cwd: string;
    error: unknown;
  } | null>(null);
  const [readPending, setReadPending] = useState(false);
  const retryListing = useRef<(() => Promise<void>) | null>(null);
  const currentCwd = useRef(cwd);
  currentCwd.current = cwd;
  useWorkbenchStatusSource(
    {
      error: failure && failure.cwd === cwd ? failure.error : null,
      pending: enabled && readPending,
      active: enabled,
      retry: () => retryListing.current?.(),
    },
    `ignored:${cwd}`,
  );
  const active = state.cwd === cwd ? state : null;
  // A reused tree fiber can receive another workspace before the effect below
  // re-lists. Fall back to the NEW cwd's warm roots rather than to nothing — and
  // never to the previous workspace's — mirroring what the tracked listing does
  // with peekWorkspaceFiles. Pairing warm roots with an empty `loaded` is safe:
  // `loaded` only ever holds children of the roots it was listed alongside.
  const warmRoots = useMemo(
    () => (active ? null : peekIgnoredRoots(cwd)),
    [active, cwd],
  );
  const activeRoots = active?.roots ?? warmRoots ?? EMPTY;
  const loaded = active?.loaded ?? EMPTY_LOADED;
  // Read by the refresh effect below (which must not re-subscribe when the set
  // changes) and by the expansion watcher.
  const expandedRef = useRef(active?.expanded ?? EMPTY_EXPANDED);
  expandedRef.current = active?.expanded ?? EMPTY_EXPANDED;

  // Re-list on a new workspace and every refresh signal: roots, so a new `dist/`
  // appears, and every open directory, so files written there appear without
  // reopening it. The engine's watcher skips node_modules, so this pass is the
  // only refresh there. Both are no-ops when nothing changed.
  useEffect(() => {
    if (!enabled) return;
    if (!cwd) {
      // Identity-stable, so a reloadKey bump with no workspace doesn't hand the
      // tree a fresh (empty) status array and re-render it for nothing.
      setState((prev) =>
        prev.cwd === undefined && prev.roots.length === 0
          ? prev
          : emptyState(undefined),
      );
      return;
    }
    let cancelled = false;
    let flight: Promise<void> | null = null;
    const refresh = () => {
      if (flight) return flight;
      setReadPending(true);
      let failed = false;
      flight = (async () => {
        try {
          const roots = await listIgnoredEntries(cwd);
          if (cancelled) return;
          // Publish for the NEXT mount on this workspace, from the one place that
          // holds an authoritative answer. Seeding from the hook's own state
          // instead would also publish the empty starting value, and a workspace
          // whose first listing failed would be cached as "ignores nothing".
          rememberIgnoredRoots(cwd, roots);
          setState((prev) => withRoots(prev, cwd, roots));
        } catch (error) {
          failed = true;
          if (!cancelled) setFailure({ cwd, error });
          return;
        }
        // In parallel: reloadKey bumps faster than a serial chain of round-trips while
        // an agent writes, and each bump cancels the previous chain, so the last
        // branches would never refresh. Bounded by the open directories.
        await Promise.all(
          [...expandedRef.current].map(async (dir) => {
            try {
              const children = await listIgnoredEntries(cwd, dir);
              if (cancelled) return;
              setState((prev) => withRefreshedDir(prev, cwd, dir, children));
            } catch (error) {
              failed = true;
              if (!cancelled) setFailure({ cwd, error });
            }
          }),
        );
        if (cancelled || failed) return;
        setFailure(null);
        // Both listings are now current, so anything still marked open that they
        // no longer report is genuinely gone from disk (`rm -rf dist` while `dist/`
        // was expanded). Drop it, or every later refresh spends a round-trip and an
        // engine readdir on a directory that does not exist.
        setState((prev) =>
          prev.cwd === cwd
            ? withoutVanishedDirs(prev, knownIgnoredDirs(prev.roots, prev.loaded))
            : prev,
        );
      })().finally(() => {
        flight = null;
        if (!cancelled) setReadPending(false);
      });
      return flight;
    };
    retryListing.current = refresh;
    void refresh();
    return () => {
      cancelled = true;
      retryListing.current = null;
    };
  }, [cwd, enabled, reloadKey]);

  const loadDir = useCallback(
    async (dir: string): Promise<LoadOutcome> => {
      if (!enabled || !cwd) return "failed";
      let children: string[];
      try {
        children = await listIgnoredEntries(cwd, dir);
      } catch (error) {
        if (currentCwd.current === cwd) setFailure({ cwd, error });
        // A failed listing is not an empty directory. Recording [] would cache the
        // failure with no way to retry, so leave it pending for the next notification
        // or refresh. Report it, though: re-arming the watcher on it would busy-loop an
        // unreadable directory.
        return "failed";
      }
      setState((prev) => withLoadedDir(prev, cwd, dir, children));
      return "loaded";
    },
    [cwd, enabled],
  );

  // Watch for the user expanding an ignored directory we haven't listed yet.
  // The library exposes no expansion event, so we poll the (small, bounded)
  // pending set on its change notifications — one map lookup per pending dir,
  // coalesced to a frame so a burst of model updates costs one pass.
  const pending = useMemo(
    () => pendingIgnoredDirs(activeRoots, loaded),
    [activeRoots, loaded],
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const inFlightRef = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || !model) return;
    // This effect re-runs on a cwd change (loadDir is keyed to it). Drop the
    // in-flight keys with it: a request still settling for the PREVIOUS
    // workspace would otherwise make us skip the same-named directory here —
    // and since scanning is purely event-driven, nothing would come back to
    // re-try it, leaving the branch permanently empty.
    inFlightRef.current = new Set();
    let frame = 0;
    let disposed = false;
    const rescan = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(scan);
    };
    const scan = () => {
      frame = 0;
      for (const dir of pendingRef.current) {
        if (inFlightRef.current.has(dir)) continue;
        const item = model.getItem(`${dir}/`) ?? model.getItem(dir);
        if (!item || !item.isDirectory()) continue;
        if (!isExpanded(item)) continue;
        inFlightRef.current.add(dir);
        void loadDir(dir).then((outcome) => {
          inFlightRef.current.delete(dir);
          // A load that changed nothing produces no model notification, so re-arm
          // explicitly; not after a failure, which would spin on an unreadable directory.
          if (outcome !== "failed") rescan();
        });
      }
      // Forget branches the user closed, so the next refresh doesn't replay
      // them into resetPaths and pop them back open.
      const collapsed: string[] = [];
      for (const dir of expandedRef.current) {
        const item = model.getItem(`${dir}/`) ?? model.getItem(dir);
        // A dir missing from the tree (mid-rebuild, or a workspace swap) is left
        // alone — only an explicit collapse counts here. A branch that is gone
        // for real is pruned from the LISTINGS instead (withoutVanishedDirs),
        // which is the durable signal and doesn't fight a transient tree state.
        if (item && item.isDirectory() && !isExpanded(item))
          collapsed.push(dir);
      }
      if (collapsed.length > 0)
        setState((prev) => withCollapsed(prev, collapsed));
    };
    const unsubscribe = model.subscribe(rescan);
    scan(); // an expansion restored by resetPaths fires no notification
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [enabled, model, loadDir]);

  // Every ignored DIRECTORY, not just the roots — flattened chains break
  // inheritance (see the header). Files inherit and are omitted.
  const status = useMemo(
    () => [...ignoredGitStatus(activeRoots, loaded), ...(fileStatus ?? [])],
    [activeRoots, loaded, fileStatus],
  );
  // A LAYOUT effect, so a seeded mount dims its ignored rows in the SAME commit
  // that puts them on screen. As a passive effect this landed one frame after
  // the rows did, which the warm snapshot made visible: `.env` and
  // `node_modules/` painted like tracked code and then greyed out.
  useLayoutEffect(() => {
    if (!enabled || !model) return;
    model.setGitStatus(status.length > 0 ? status : undefined);
  }, [enabled, model, status]);

  const paths = useMemo(
    () => mergeIgnoredPaths(activeRoots, loaded),
    [activeRoots, loaded],
  );
  // From `expanded`, not `loaded`: `loaded` is keyed by the directories whose
  // children we hold, which is the same set today — but `expanded` is the one
  // with the right lifetime. It survives a refresh that momentarily has no
  // children for a branch, so the re-listing we just triggered lands in a tree
  // that is still open rather than one resetPaths just shut.
  const expandedSet = active?.expanded ?? EMPTY_EXPANDED;
  const expandedDirs = useMemo(() => [...expandedSet], [expandedSet]);
  return {
    paths,
    expandedDirs,
    resolved: active?.resolved ?? warmRoots !== null,
  };
}

/** What `loadDir` did — "failed" is the one the watcher must not re-arm on. */
type LoadOutcome = "loaded" | "failed";

/** Roots AND loaded children in ONE cwd-stamped value. Held together because
 *  they must move together: with separate states a workspace switch landed the
 *  new repo's roots while the old repo's node_modules children were still in
 *  `loaded`, so the tree rendered another worktree's paths. */
export interface IgnoredState {
  cwd: string | undefined;
  resolved: boolean;
  roots: string[];
  /** Directories the user has opened. Sticky across refreshes — it is what we
   *  replay into resetPaths, and what tells us to re-list on a refresh. Cleared
   *  only by an explicit collapse (withCollapsed) or a workspace change. */
  expanded: Set<string>;
  /** dir → its children, as of the last listing. Kept across a refresh and
   *  revalidated in place by withRefreshedDir (which is how an externally
   *  written file shows up without closing the branch); dropped, with its whole
   *  subtree, when the branch is collapsed. */
  loaded: Map<string, string[]>;
}

export function emptyState(cwd: string | undefined): IgnoredState {
  return {
    cwd,
    resolved: false,
    roots: [],
    expanded: new Set(),
    loaded: new Map(),
  };
}

/** A mount's starting state: the previous visit's roots when this workspace is
 *  warm, so a workspace switch paints its ignored rows in the same frame as the
 *  tracked ones instead of splicing them in a couple of round-trips later.
 *  `expanded`/`loaded` still start clean — a fresh tree is fully collapsed, so
 *  there is nothing for them to do until the user opens a branch. */
export function warmState(cwd: string | undefined): IgnoredState {
  const roots = peekIgnoredRoots(cwd);
  return roots
    ? { ...emptyState(cwd), roots, resolved: true }
    : emptyState(cwd);
}

/** A roots listing came back. Same workspace → keep open branches and their
 *  children (they're revalidated separately, see withRefreshedDir); different
 *  workspace → start clean. */
export function withRoots(
  prev: IgnoredState,
  cwd: string,
  roots: string[],
): IgnoredState {
  if (prev.cwd !== cwd) {
    return {
      cwd,
      roots,
      resolved: true,
      expanded: new Set(),
      loaded: new Map(),
    };
  }
  if (prev.resolved && sameList(prev.roots, roots)) return prev;
  return { ...prev, roots, resolved: true };
}

/** A re-listing of an already-open directory — how a file that a terminal, an
 *  agent, or a build just wrote into `dist/` becomes visible without the user
 *  closing and reopening it.
 *
 *  Returns `prev` UNCHANGED when the contents match, which is the point: this
 *  runs on every git refresh, and a new array identity would re-run the tree's
 *  resetPaths and visibly flicker the open branch's rows for no reason. */
export function withRefreshedDir(
  prev: IgnoredState,
  cwd: string,
  dir: string,
  children: string[],
): IgnoredState {
  if (prev.cwd !== cwd) return prev;
  const current = prev.loaded.get(dir);
  if (current && sameList(current, children)) return prev;
  const loaded = new Map(prev.loaded);
  loaded.set(dir, children);
  return { ...prev, loaded };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A directory's children came back. Dropped when the workspace moved on while
 *  the request was in flight, or when this dir is already recorded (recording
 *  an EMPTY result matters — it's what stops a re-request loop). */
export function withLoadedDir(
  prev: IgnoredState,
  cwd: string,
  dir: string,
  children: string[],
): IgnoredState {
  if (prev.cwd !== cwd || prev.loaded.has(dir)) return prev;
  const loaded = new Map(prev.loaded);
  loaded.set(dir, children);
  const expanded = prev.expanded.has(dir)
    ? prev.expanded
    : new Set(prev.expanded).add(dir);
  return { ...prev, expanded, loaded };
}

/** The user collapsed directories: forget them and drop their cached children.
 *  Forgetting `expanded` keeps the next refresh from reopening them. Dropping
 *  `loaded` keeps cost proportional to what is on screen: those children
 *  otherwise stay in the path list, tree store, status map and watcher set
 *  (~2.5ms per notification after one trip into `node_modules/.pnpm`). It also
 *  makes re-expansion re-fetch, so the branch is re-listed and replayed again. */
export function withCollapsed(
  prev: IgnoredState,
  dirs: readonly string[],
): IgnoredState {
  if (dirs.length === 0) return prev;
  const expanded = new Set(prev.expanded);
  const loaded = new Map(prev.loaded);
  let changed = false;
  for (const dir of dirs) {
    changed = expanded.delete(dir) || changed;
    for (const key of [...loaded.keys()]) {
      if (key === dir || key.startsWith(`${dir}/`)) {
        loaded.delete(key);
        expanded.delete(key);
        changed = true;
      }
    }
  }
  return changed ? { ...prev, expanded, loaded } : prev;
}

/** Directories the listings stopped reporting (deleted from disk): drop them
 *  from `expanded` with their children. Keyed on the listings, not on absence
 *  from the tree model, because a row can be missing mid-rebuild. Otherwise a
 *  deleted `dist/` costs a round-trip and an engine readdir on every refresh. */
export function withoutVanishedDirs(
  prev: IgnoredState,
  known: ReadonlySet<string>,
): IgnoredState {
  const gone: string[] = [];
  for (const dir of prev.expanded) if (!known.has(dir)) gone.push(dir);
  return gone.length > 0 ? withCollapsed(prev, gone) : prev;
}

/** Every ignored DIRECTORY the listings currently report, keyed the way
 *  `expanded` and the engine's `dir` param want it (no trailing slash). */
export function knownIgnoredDirs(
  roots: readonly string[],
  loaded: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const out = new Set<string>();
  for (const root of roots) if (isDirEntry(root)) out.add(dirKey(root));
  for (const children of loaded.values()) {
    for (const child of children) if (isDirEntry(child)) out.add(dirKey(child));
  }
  return out;
}

const EMPTY: string[] = [];
const EMPTY_LOADED: ReadonlyMap<string, string[]> = new Map();
const EMPTY_EXPANDED: ReadonlySet<string> = new Set();

function isExpanded(item: { isDirectory(): boolean }): boolean {
  return (
    "isExpanded" in item &&
    typeof (item as { isExpanded?: unknown }).isExpanded === "function" &&
    (item as { isExpanded(): boolean }).isExpanded()
  );
}
