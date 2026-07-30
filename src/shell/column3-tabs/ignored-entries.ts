// ──────────────────────────────────────────────────────────
// Ignored entries in the Files tree — lazy, per-directory
// ──────────────────────────────────────────────────────────
//
// The Files tab used to render `git ls-files -co --exclude-standard`, i.e. the
// paths git cares about. That quietly excluded everything a setup script, an
// agent, or a terminal command actually produces — `node_modules/`, `dist/`,
// `.env` — so the tab could not answer "did the install work?" at all.
//
// Showing them is not a matter of dropping a flag: this repo has 60,888
// ignored files against ~2,300 tracked ones, and the tree model materializes
// every path it is given. So the listing is TWO-PHASE (engine side:
// git/workspace-files.ts):
//
//   • roots — `git ls-files --directory` collapses a wholly-ignored directory
//     to one trailing-slash entry, so the initial paint costs ~8 extra rows.
//     A trailing slash is @pierre/trees' marker for "directory node with no
//     children yet", which is exactly an unexpanded `node_modules/`.
//   • children — fetched only when the user expands one of those directories,
//     one level at a time.
//
// This hook only produces the path list and the expansion set; how they reach
// the tree is workspace-file-tree.tsx's business — it applies an ignored-only
// change as an incremental `model.batch()` precisely so that a build writing
// into an open `dist/` doesn't collapse the user's tracked browsing along with
// it. `expandedDirs` is what the whole-tree rebuild path replays.
//
// COLOUR: we hand the tree a `gitStatus` entry per ignored DIRECTORY we know
// about — the roots plus the directory children of whatever is open. The library
// propagates `ignored` down to every descendant of an ignored directory
// (model/gitStatus.js), so we never build a 60k-entry status map; ignored FILES
// inside a known ignored directory inherit and are left out.
//
// Roots alone are NOT enough, because this tree sets `flattenEmptyDirectories`.
// The library only propagates from an ancestor that is a VISIBLE ROW
// (`row.ancestorPaths`), and a flattened chain's head is not one: a fresh
// `node_modules/` whose only child is `.pnpm/` renders as a single flattened row
// keyed on the TERMINAL, so a roots-only entry left it painted like tracked
// code. Flattening only ever chains directory→directory (path-store/flatten.js),
// so covering every known ignored directory covers every possible terminal.
//
// MEMORY: `loaded` is pruned when a branch is collapsed (see withCollapsed), so
// everything above is bounded by what is actually on screen rather than by the
// deepest the user ever browsed.
//
// SWITCHING WORKSPACES: a mount starts from ignored-entries-cache's warm roots
// (warmState) rather than from nothing, because the tracked listing is seeded
// the same way — and half a seeded tree is worse than none. See that module's
// header for why an unseeded mount made the whole tab look like it reloaded.
// ──────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GitStatusEntry } from "@pierre/trees";

import { listIgnoredEntries } from "@/native/git";

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
 *  `packages/core/node_modules/` shows up in the root listing AND inside its
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

/** The status entries to hand the tree: every ignored path that is a DIRECTORY,
 *  plus any ignored ROOT that is a file (`.env`, `.mcp.json` — nothing above
 *  them to inherit from). Files nested inside a known ignored directory are
 *  omitted; the library propagates `ignored` down to them.
 *
 *  Directory children matter and not just roots because of
 *  `flattenEmptyDirectories` — see the header. Bounded by what is open, because
 *  collapsing prunes `loaded`. */
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

/** The add/remove ops that take the tree from `applied` to `next`.
 *
 *  Applying an ignored-side change incrementally instead of through resetPaths
 *  is what keeps a build writing into `dist/` from collapsing every TRACKED
 *  directory the user had open — resetPaths rebuilds the store closed, and only
 *  the ignored branches can be replayed. It has to be a strict delta: `add`
 *  throws on a path the store already holds.
 *
 *  REMOVES ARE RECURSIVE AND DE-NESTED, both because the store throws otherwise
 *  and because that throw is expensive: `batch` does not roll back, so a
 *  mid-batch throw leaves the store half-mutated and the caller has to fall back
 *  to the whole-tree rebuild this function exists to avoid.
 *    • `remove` on a directory that still holds children throws
 *      "Cannot remove a non-empty directory without recursive" — reachable
 *      whenever a directory disappears while its children are still in `next`
 *      (a build deletes `dist/` between the roots listing and the child listing).
 *    • ops came out PARENT-FIRST (the merged set is seeded from roots), so the
 *      parent's own removal is what hit that throw. Dropping any remove whose
 *      ancestor is also being removed makes the order irrelevant. */
export function ignoredPathDelta(
  applied: ReadonlySet<string>,
  next: ReadonlySet<string>,
): IgnoredPathOp[] {
  const ops: IgnoredPathOp[] = [];
  for (const path of next) {
    if (!applied.has(path)) ops.push({ path, type: "add" });
  }
  const removing = new Set<string>();
  for (const path of applied) {
    if (!next.has(path)) removing.add(path);
  }
  for (const path of removing) {
    if (hasRemovedAncestor(path, removing)) continue; // covered recursively
    ops.push(
      isDirEntry(path)
        ? { path, type: "remove", recursive: true }
        : { path, type: "remove" },
    );
  }
  return ops;
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
): IgnoredEntriesState {
  const [state, setState] = useState<IgnoredState>(() => warmState(cwd));
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

  // Re-listed for a new workspace AND on every refresh signal — the same bus
  // that tells the tracked listing a file changed. Two passes:
  //   • roots, so a `dist/` a build just created shows up; and
  //   • every OPEN directory, so a file written into one from a terminal, an
  //     agent, or an install shows up without closing and reopening it. (The
  //     engine's chokidar watcher skips node_modules entirely, so for that
  //     subtree this pass is the only thing that refreshes it — which is why
  //     it re-lists rather than trusting an event.)
  // Both are no-ops when nothing changed, so an idle refresh costs two cheap
  // reads and does not touch React state.
  useEffect(() => {
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
    void (async () => {
      try {
        const roots = await listIgnoredEntries(cwd);
        if (cancelled) return;
        // Publish for the NEXT mount on this workspace, from the one place that
        // holds an authoritative answer. Seeding from the hook's own state
        // instead would also publish the empty starting value, and a workspace
        // whose first listing failed would be cached as "ignores nothing".
        rememberIgnoredRoots(cwd, roots);
        setState((prev) => withRoots(prev, cwd, roots));
      } catch {
        // No bridge / not a repo — the tree simply shows what git tracks,
        // which is strictly better than an error in a file browser.
        return;
      }
      // In PARALLEL, not in sequence. reloadKey bumps faster than a chain of
      // bridge round-trips can finish while an agent is writing, and each bump
      // cancels the previous chain — so a serial loop would restart from the
      // top every time and the branches at the end of the list would never be
      // refreshed at all. The count is bounded by how many directories the user
      // has open, which is a handful.
      await Promise.all(
        [...expandedRef.current].map(async (dir) => {
          try {
            const children = await listIgnoredEntries(cwd, dir);
            if (cancelled) return;
            setState((prev) => withRefreshedDir(prev, cwd, dir, children));
          } catch {
            /* keep the last good listing for this branch */
          }
        }),
      );
      if (cancelled) return;
      // Both listings are now current, so anything still marked open that they
      // no longer report is genuinely gone from disk (`rm -rf dist` while `dist/`
      // was expanded). Drop it, or every later refresh spends a round-trip and an
      // engine readdir on a directory that does not exist.
      setState((prev) =>
        prev.cwd === cwd
          ? withoutVanishedDirs(prev, knownIgnoredDirs(prev.roots, prev.loaded))
          : prev,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, reloadKey]);

  const loadDir = useCallback(
    async (dir: string): Promise<LoadOutcome> => {
      if (!cwd) return "failed";
      let children: string[];
      try {
        children = await listIgnoredEntries(cwd, dir);
      } catch {
        // A FAILED listing is not an empty directory. Recording [] would cache
        // the failure as fact — `withLoadedDir` refuses to overwrite an existing
        // entry and a loaded dir is never "pending", so a single bridge timeout
        // left `node_modules/` looking genuinely empty with no way to retry
        // (collapse/re-expand included). Leave it unrecorded so it stays pending
        // and the next notification or refresh retries it — but report the
        // failure, because the caller must NOT re-arm the watcher on it (that
        // would busy-loop a dir that is reliably unreadable).
        return "failed";
      }
      setState((prev) => withLoadedDir(prev, cwd, dir, children));
      return "loaded";
    },
    [cwd],
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
    if (!model) return;
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
          // A load that resolved to no state change (workspace moved on, dir
          // already recorded) produces no model notification, so re-arm
          // explicitly rather than waiting for an interaction that may never
          // come. NOT on a failure: the dir is deliberately left pending, so
          // re-arming would spin on a reliably-unreadable directory. It gets
          // retried by the next notification or refresh instead.
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
        if (item && item.isDirectory() && !isExpanded(item)) collapsed.push(dir);
      }
      if (collapsed.length > 0) setState((prev) => withCollapsed(prev, collapsed));
    };
    const unsubscribe = model.subscribe(rescan);
    scan(); // an expansion restored by resetPaths fires no notification
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [model, loadDir]);

  // Every ignored DIRECTORY, not just the roots — flattened chains break
  // inheritance (see the header). Files inherit and are omitted.
  const status = useMemo(
    () => ignoredGitStatus(activeRoots, loaded),
    [activeRoots, loaded],
  );
  // A LAYOUT effect, so a seeded mount dims its ignored rows in the SAME commit
  // that puts them on screen. As a passive effect this landed one frame after
  // the rows did, which the warm snapshot made visible: `.env` and
  // `node_modules/` painted like tracked code and then greyed out.
  useLayoutEffect(() => {
    if (!model) return;
    model.setGitStatus(status.length > 0 ? status : undefined);
  }, [model, status]);

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
  return { paths, expandedDirs };
}

/** What `loadDir` did — "failed" is the one the watcher must not re-arm on. */
type LoadOutcome = "loaded" | "failed";

/** Roots AND loaded children in ONE cwd-stamped value. Held together because
 *  they must move together: with separate states a workspace switch landed the
 *  new repo's roots while the old repo's node_modules children were still in
 *  `loaded`, so the tree rendered another worktree's paths. */
export interface IgnoredState {
  cwd: string | undefined;
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
  return { cwd, roots: [], expanded: new Set(), loaded: new Map() };
}

/** A mount's starting state: the previous visit's roots when this workspace is
 *  warm, so a workspace switch paints its ignored rows in the same frame as the
 *  tracked ones instead of splicing them in a couple of round-trips later.
 *  `expanded`/`loaded` still start clean — a fresh tree is fully collapsed, so
 *  there is nothing for them to do until the user opens a branch. */
export function warmState(cwd: string | undefined): IgnoredState {
  const roots = peekIgnoredRoots(cwd);
  return roots ? { ...emptyState(cwd), roots } : emptyState(cwd);
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
    return { cwd, roots, expanded: new Set(), loaded: new Map() };
  }
  if (sameList(prev.roots, roots)) return prev;
  return { ...prev, roots };
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

/** The user collapsed directories. Forgets them AND drops their cached children,
 *  the whole subtree.
 *
 *  Forgetting `expanded` keeps the next refresh from re-opening a branch they
 *  just closed. Dropping `loaded` is what keeps the feature's cost proportional
 *  to what is on SCREEN rather than to the deepest the user ever browsed: those
 *  children stay in the merged path list, in the tree store, in the git-status
 *  map, and in the set the expansion watcher walks on every model notification —
 *  so one trip into `node_modules/.pnpm` used to cost ~2.5ms of main-thread work
 *  per notification (and ~1s of engine stat calls per refresh) for the lifetime
 *  of the workspace, invisibly.
 *
 *  It also repairs re-expansion: a dir still in `loaded` is not "pending", and
 *  `withLoadedDir` is the only writer of `expanded` — so before this pruned, a
 *  collapse/re-expand cycle left the branch permanently absent from `expanded`,
 *  which stopped it being re-listed on refresh (new files never appeared) and
 *  left it out of the resetPaths replay (it slammed shut on the next unrelated
 *  save). Re-expanding now simply re-fetches, one bridge round-trip. */
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

/** Directories that are no longer ignored paths at all — the branch was deleted
 *  from disk, so the roots/children listings stopped reporting it. Drops them
 *  from `expanded` (and their cached children with them).
 *
 *  Distinct from a collapse, and deliberately NOT keyed on "absent from the tree
 *  model": a row can be missing mid-rebuild, and closing a branch over that would
 *  fight the user. Keyed on the listings instead, which is the durable signal.
 *  Without it, expanding `dist/` and then `rm -rf dist` left `dist` in `expanded`
 *  forever, so every later refresh spent a bridge round-trip and an engine
 *  readdir on a directory that does not exist. */
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
