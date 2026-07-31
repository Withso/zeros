// ──────────────────────────────────────────────────────────
// Files to copy — the repo page's per-project seeding pane
// ──────────────────────────────────────────────────────────
//
// A new workspace branches from the remote, so it holds TRACKED files only:
// `.env`, local config and certificates are all missing and the project won't
// run. This pane picks what rides along.
//
// It is deliberately a CHECKLIST first. The engine has already scanned the
// repo by the time this paints, so the pane can show the real ignored files
// instead of asking someone who has never written a `.gitignore` to type
// `.env*` into an empty box and hope. The pattern editor sits underneath,
// always visible, and both editors write the same setting.
//
// The list is a FOLDER TREE, closed by default. Flat, the same repo is two or
// three real directories wearing two dozen rows (`lib/api-zod/node_modules/`,
// `lib/db/node_modules/`, …) and the file you came to tick is buried in the
// middle of them. One rule keeps closing safe: a selection is never invisible,
// so a partly-ticked folder surfaces what is ticked inside it even while
// closed — the row you ticked is the row you need to find again to untick.
//
// Scope is per-repo, full stop. "Which files does this project need" has no
// sensible cross-project answer, so there is no global/per-project switch —
// saving always writes this repo's own `.zeros/settings.local.toml`.
//
// All pattern/row/tree logic lives in files-to-copy-model.ts (pure,
// unit-tested); this file is the wiring and the markup.
// ──────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, Info, RotateCw } from "lucide-react";

import type { Project } from "../store/projects-store";
import { useBridge, useBridgeStatus } from "../bridge/use-bridge";
import {
  bridgeFilesToCopyPreview,
  type FilesToCopyPreviewWire,
} from "../bridge/workspace-bridge";
import { revealInFinder } from "../../native/native";
import {
  filesToCopyPreviewCache,
  filesToCopyPreviewKey,
  filesToCopyPreviewRequest,
  invalidateFilesToCopyForRepo,
} from "../store/read-caches";
import { useCachedRead } from "../store/use-cached-read";
import { useSettingsChanged, useSettingsLayer } from "../settings/use-settings";
import { SettingsSection } from "../settings/settings-ui";
import {
  Button,
  Checkbox,
  CodeTextarea,
  Tooltip,
  toast,
  type CheckedState,
} from "../ui/primitives";
import { cn } from "../ui/cn";
import {
  applyDraftOverlay,
  baseFor,
  buildCandidateRows,
  buildCandidateTree,
  canMaterialize,
  flattenTree,
  formatPatternText,
  hasConfirmedEmptyCandidates,
  materializePatterns,
  nodeCheck,
  nodeLocked,
  parsePatternText,
  patternStatsForBox,
  sameList,
  summaryLead,
  toggleManyPatterns,
  toggleablePaths,
  type CandidateTreeNode,
  type CandidateTreeRow,
} from "./files-to-copy-model";
import type { EditableRepoLayer } from "./repositories-panel";

/** Pause after the last keystroke before an unsaved draft is previewed. Long
 *  enough that typing a pattern doesn't fork a `git ls-files` per character,
 *  short enough to feel like live feedback. */
const PREVIEW_DEBOUNCE_MS = 400;
/** Autosave debounce for the pattern editor. Matches ScriptsSection so the two
 *  free-text settings bodies on the repo page behave identically. */
const AUTOSAVE_DEBOUNCE_MS = 500;
/** A preview is a `git ls-files` over the checkout — cheap, but not free, and
 *  ignored files do not churn second to second. */
const PREVIEW_MAX_AGE_MS = 30_000;

interface FilesToCopyDoc {
  file_include_globs?: unknown;
}

/** Read the saved list off a settings layer document. `null` when the key is
 *  ABSENT — which is a different statement from an empty list, and the whole
 *  reason "copy nothing" can be expressed at all. Tolerates a hand-edited
 *  file: the engine sanitizer drops a non-array, but this renders whatever is
 *  on disk RIGHT NOW, which may be mid-edit. */
function savedGlobsOf(doc: unknown): string[] | null {
  const value = (doc as FilesToCopyDoc | undefined)?.file_include_globs;
  if (!Array.isArray(value)) return null;
  return value.filter((g): g is string => typeof g === "string");
}

export function FilesToCopySection({
  project,
  layer,
  root,
  surfaceActive = true,
}: {
  project: Project;
  layer: EditableRepoLayer;
  root: string;
  /** False while the repo page keeps this pane in its retained deck. A hidden
   *  surface must not scan the repo — the read goes inert and its last snapshot
   *  paints instantly on the next open. */
  surfaceActive?: boolean;
}) {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus();
  const local = useSettingsLayer(layer, root);
  // `null` = this project has NO list of its own (the key is absent) and is
  // using whatever is below it. `[]` = an explicit "copy nothing". Keeping the
  // two apart is what makes unticking the last row mean something — as a
  // string they were both "" and the edit was a silent no-op.
  const savedGlobs = useMemo(
    () => savedGlobsOf(local.layer?.doc),
    [local.layer?.doc],
  );
  // The edit in progress, as a LIST. `null` = untouched since the last save.
  const [pending, setPending] = useState<string[] | null>(null);
  // Which folders are open. Ephemeral by design — it is a view of the list,
  // not a choice about the project, so it lives and dies with the mount.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Adopt an external change (a hand-edit, another window) only while the user
  // has nothing of their own in flight — the same rule useSyncedDraft applies
  // to a string, applied to the list.
  const savedRef = useRef(savedGlobs);
  useEffect(() => {
    const prev = savedRef.current;
    savedRef.current = savedGlobs;
    setPending((p) => (p === null || sameList(p, prev) ? null : p));
  }, [savedGlobs]);

  const effective = pending ?? savedGlobs;
  const dirty = pending !== null && !sameList(pending, savedGlobs);
  const draft = useMemo(() => formatPatternText(effective ?? []), [effective]);
  const setDraft = useCallback(
    (text: string) => setPending(parsePatternText(text)),
    [],
  );

  // ── preview ────────────────────────────────────────────
  // The edit only enters the cache key after the user pauses. Keying on every
  // keystroke would mint a cache entry (and a git scan) per character.
  const [debounced, setDebounced] = useState<string[] | null>(null);
  useEffect(() => {
    if (sameList(debounced, pending)) return;
    const t = window.setTimeout(
      () => setDebounced(pending),
      PREVIEW_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(t);
  }, [pending, debounced]);

  // `null` = preview what is SAVED. An array — including an empty one — is a
  // draft the engine evaluates literally.
  const previewPatterns = useMemo(
    () =>
      debounced !== null && !sameList(debounced, savedGlobs) ? debounced : null,
    [debounced, savedGlobs],
  );
  const connected = !!bridge && bridgeStatus === "connected";
  const previewKey =
    surfaceActive && connected && root
      ? filesToCopyPreviewKey(root, previewPatterns)
      : null;
  const read = useCachedRead(
    filesToCopyPreviewCache,
    previewKey,
    // Read the request back OUT of the key being loaded rather than off the
    // current render. The cache defers a queued follow-up until the in-flight
    // scan settles, and by then `previewPatterns` may have moved on — which
    // stored the newer draft's preview under the older draft's key, fresh and
    // error-free, so editing back to it repainted the wrong list from cache.
    (key) => {
      const request = filesToCopyPreviewRequest(key);
      return bridgeFilesToCopyPreview(
        bridge as NonNullable<typeof bridge>,
        request.repoRoot,
        request.patterns ? { patterns: request.patterns } : {},
      );
    },
    { maxAgeMs: PREVIEW_MAX_AGE_MS },
  );
  // Every toggle mints a NEW cache key, whose snapshot starts empty — so
  // without this the whole checklist was replaced by "Scanning…" 400ms after
  // each click. Hold the last result we did get and keep rendering it while
  // the new key loads: stale rows are far closer to the truth than none.
  const lastGood = useRef<FilesToCopyPreviewWire | undefined>(undefined);
  if (read.data) lastGood.current = read.data;
  const preview = read.data ?? lastGood.current;

  // A settings write (ours or a hand-edit) and a `.worktreeinclude` change both
  // move what a preview would return. Invalidate keeps the rows on screen and
  // revalidates behind them.
  const onSettingsChanged = useCallback(() => {
    if (root) invalidateFilesToCopyForRepo(root);
  }, [root]);
  useSettingsChanged(onSettingsChanged);

  // ── autosave (serialized, ScriptsSection pattern) ──────
  const latestRef = useRef(pending);
  latestRef.current = pending;
  const savingRef = useRef(false);
  const queuedRef = useRef(false);

  const writePatterns = local.write;
  const saveLatest = useCallback(async () => {
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }
    savingRef.current = true;
    try {
      do {
        queuedRef.current = false;
        const patterns = latestRef.current;
        if (patterns === null) break;
        try {
          // The ARRAY is written even when empty. `null` would delete the key
          // and hand the repo back to the built-in `.env*`, so "I unticked
          // everything" would come back as "copy my .env" — the opposite of
          // what was asked. Nothing here writes `null` any more: the "Reset to
          // default" link that did was removed, so going back to the inherited
          // default means deleting the key from `.zeros/settings.local.toml`.
          await writePatterns({ file_include_globs: patterns });
        } catch {
          toast.error("Couldn't save which files to copy");
          break;
        }
      } while (queuedRef.current);
    } finally {
      savingRef.current = false;
    }
  }, [writePatterns]);

  // Deliberately NOT gated on surfaceActive, unlike the scan. Switching tabs
  // within the debounce window would otherwise silently discard the edit that
  // was already made — and a hidden pane has no interaction, so this settles
  // once and then goes quiet (dirty is false after a successful write).
  useEffect(() => {
    if (local.loading || !dirty) return;
    const t = window.setTimeout(() => void saveLatest(), AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [pending, dirty, local.loading, saveLatest]);

  // ── rows ───────────────────────────────────────────────
  // Rows are built from the patterns the PREVIEW was computed from — the
  // engine decided which files those select, and guessing here would show a
  // selection that does not exist. The one exception is a box the user has
  // just clicked, which applyDraftOverlay re-points below.
  const previewedPatterns = useMemo(
    () => previewPatterns ?? savedGlobs ?? [],
    [previewPatterns, savedGlobs],
  );
  const rows = useMemo(
    () => (preview ? buildCandidateRows(preview, previewedPatterns) : []),
    [preview, previewedPatterns],
  );
  // The overlay needs the list the first edit will be composed FROM, which
  // with nothing saved is the materialized effective set — the same thing
  // `baseFor` hands `togglePattern`. Passing the empty list here (which is
  // right for `buildCandidateRows`, where it keeps default-selected rows
  // unlocked) made every row's "before" state false, so the first untick had
  // nothing to flip and the box stayed visibly ticked.
  const overlayBase = useMemo(
    () =>
      previewPatterns ??
      savedGlobs ??
      (preview ? materializePatterns(preview) : []),
    [previewPatterns, savedGlobs, preview],
  );
  // …then re-point the boxes the user has toggled since that preview, so a
  // click ticks NOW rather than when the next scan lands.
  const liveRows = useMemo(
    () => applyDraftOverlay(rows, overlayBase, effective),
    [rows, overlayBase, effective],
  );
  const tree = useMemo(() => buildCandidateTree(liveRows), [liveRows]);
  const treeRows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);
  const readOnly = preview?.source === "worktreeinclude";
  // Editing is refused, not silently wrong, when the scan we would build the
  // first edit from is not the whole truth: materializing from a cut-short or
  // truncated `files` writes a list that stops seeding things nobody unticked.
  const editable =
    !!preview && !readOnly && !local.loading && canMaterialize(preview);

  // The live list is read through a ref so this callback keeps its identity
  // across keystrokes — otherwise every row in the list re-renders on every
  // character typed in the pattern editor.
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;
  // Rows hand back a PATH, not a node: that keeps their props primitive, which
  // is what lets `memo` skip a row whose visible state did not change.
  const byPath = useMemo(() => {
    const map = new Map<string, CandidateTreeNode>();
    const walk = (nodes: readonly CandidateTreeNode[]): void => {
      for (const n of nodes) {
        map.set(n.path, n);
        walk(n.children);
      }
    };
    walk(tree);
    return map;
  }, [tree]);
  // Read through a ref for the same reason `effective` is: it keeps `onToggle`
  // identity-stable across tree rebuilds, so the memoized rows below don't all
  // invalidate on a prop that only the click handler ever reads.
  const byPathRef = useRef(byPath);
  byPathRef.current = byPath;

  const onToggle = useCallback(
    (path: string) => {
      const node = byPathRef.current.get(path);
      if (!node || !preview || !editable || nodeLocked(node)) return;
      const paths = toggleablePaths(node);
      if (paths.length === 0) return;
      // A folder that is only PARTLY ticked fills up rather than emptying —
      // the same direction every tri-state checkbox has ever taken.
      const on = nodeCheck(node) !== "on";
      // Composed on the LIVE list, so a second click inside the debounce
      // window builds on the first instead of discarding it. One line per file
      // even for a folder, which is what leaves every row underneath
      // independently untickable afterwards — writing `/lib` instead would
      // lock its own children behind an ancestor.
      setPending(
        toggleManyPatterns(baseFor(preview, effectiveRef.current), paths, on),
      );
    },
    [preview, editable],
  );

  const onExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  const openWorktreeInclude = useCallback(() => {
    if (preview?.sourcePath) void revealInFinder(preview.sourcePath);
  }, [preview?.sourcePath]);

  // Only a COMPLETE scan gets to state a total. "0 files" and "we couldn't
  // look" are different answers, and the pane must never print the first when
  // it means the second — so this is `null`, not `0`, when the scan fell short.
  const copyCount = preview?.complete ? preview.totalCount : null;
  // Scanning is only worth saying when there is nothing to look at yet. A
  // refresh behind existing rows stays silent — the rows are still true.
  const firstLoad = read.loading && !preview;
  // Nothing to render and nothing in flight: the bridge is down, or the read
  // failed. Distinct from "this project has no ignored files".
  const unavailable = !preview && !firstLoad;
  const confirmedEmpty = hasConfirmedEmptyCandidates(preview, liveRows.length);
  // Per-line counts explain only the lines currently visible in the box.
  // Exact comparison excludes inherited lists and a draft still inside its
  // debounce; comments are prose, so they never receive a red zero either.
  const patternStats = useMemo(
    () => patternStatsForBox(effective ?? [], preview),
    [effective, preview],
  );

  return (
    <SettingsSection
      title="Files to copy"
      description={`New workspaces only contain files Git tracks. Pick the ignored files to copy in from ${project.name} so a new workspace runs straight away.`}
    >
      {readOnly && (
        <div className="text-blue-fg bg-blue-bg flex items-center gap-2 rounded-md px-3 py-2 text-xs">
          <Info className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">
            <code className="font-mono">.worktreeinclude</code> is committed to
            the repo — it decides this list.
          </span>
          {preview?.sourcePath && (
            <button
              type="button"
              onClick={openWorktreeInclude}
              className="ml-auto shrink-0 font-medium underline underline-offset-2"
            >
              Open file
            </button>
          )}
        </div>
      )}

      {firstLoad ? (
        <div className="text-fg3 flex items-center gap-2 py-4 text-xs">
          <RotateCw className="size-3.5 animate-spin" aria-hidden />
          Scanning {project.name}…
        </div>
      ) : unavailable ? (
        // NOT "nothing needs copying". We never looked — saying the project is
        // already complete would be a claim we have no evidence for, and it is
        // the one message that makes a user stop investigating.
        <div className="border-border2 bg-bg1-highlight flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center">
          <div className="text-fg1 text-[14px] font-medium">
            Couldn&rsquo;t check this project
          </div>
          <div className="text-fg2 max-w-[44ch] text-xs">
            {read.error?.message ??
              (connected
                ? "The scan didn't finish."
                : "Not connected to the Zeros engine yet.")}{" "}
            Your saved list is untouched and still applies to new workspaces.
          </div>
          <Button variant="secondary" size="sm" onClick={read.refresh}>
            <RotateCw className="size-3" aria-hidden />
            Try again
          </Button>
        </div>
      ) : confirmedEmpty ? (
        <div className="border-border2 bg-bg1-highlight flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center">
          <div className="text-fg1 text-[14px] font-medium">
            Nothing needs copying
          </div>
          <div className="text-fg2 max-w-[44ch] text-xs">
            Zeros found no ignored files in this project. New workspaces will
            already be complete.
          </div>
        </div>
      ) : liveRows.length > 0 ? (
        <div className="border-border1 overflow-hidden rounded-lg border">
          <div className="border-border1 bg-bg1-highlight border-b px-3 py-2">
            <span className="text-fg1 text-xs font-medium">
              Git ignored files
            </span>
          </div>
          {treeRows.map((row) => (
            // Keyed by node path, which each row holds exactly once: a folder
            // is EITHER walked into (its children become rows) or closed (only
            // its selected descendants surface), never both.
            //
            // Spread as PRIMITIVES rather than passed as the row object. A
            // toggle rebuilds the tree, so every `CandidateTreeRow` is a fresh
            // object and a memo keyed on it would miss on all 300 rows for a
            // click that changed one — the identity `applyDraftOverlay` works
            // to preserve, thrown away one layer down.
            <TreeRowView
              key={row.node.path}
              path={row.node.path}
              label={row.label}
              depth={row.depth}
              folder={row.folder}
              branch={row.branch}
              expanded={row.expanded}
              checked={checkedOf(row)}
              locked={!editable || nodeLocked(row.node)}
              onToggle={onToggle}
              onExpand={onExpand}
            />
          ))}
        </div>
      ) : null}

      {/* No rule above or below: the sentence belongs to the list it is
          counting, and two hairlines made it read as a third region. */}
      {!!preview && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-fg2 text-xs">
            {copyCount !== null ? (
              <>
                <span className="text-fg1 font-medium">
                  {summaryLead(copyCount)}
                </span>{" "}
                will be copied from{" "}
                <span className="text-brown-primary text-2xxs font-mono">
                  {preview.rootPath}
                </span>
              </>
            ) : (
              // The one honest thing left to say when the scan came up short.
              // It replaces a count rather than sitting beside one, so an
              // incomplete scan can never be read as "nothing to copy".
              <span className="text-fg3">
                Couldn&rsquo;t work out what would be copied
              </span>
            )}
          </span>
          {/* Icon only. The label said "Rescan" beside an icon that already
              says it, in a row whose job is the sentence to its left. */}
          <Tooltip label="Rescan">
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              onClick={read.refresh}
              disabled={!connected || read.refreshing}
              aria-label="Rescan"
            >
              <RotateCw
                className={cn(
                  "size-3",
                  // In flight only. Spinning on "what's on screen is older than
                  // the box" instead never stopped once the bridge dropped — no
                  // key means no data forever, while the last result keeps
                  // painting — so a DISABLED button spun for the rest of the
                  // session, claiming a scan nobody could have started.
                  (read.refreshing || read.loading) && "animate-spin",
                )}
                aria-hidden
              />
            </Button>
          </Tooltip>
        </div>
      )}

      {/* Read-only patterns for the committed-file case. The list above is the
          answer either way; these are the lines that produced it. */}
      {readOnly && preview?.sourceText !== undefined && (
        <pre className="bg-bg1-highlight text-fg2 text-2xxs m-0 max-h-64 overflow-auto rounded-md px-3 py-2 font-mono leading-relaxed">
          {preview.sourceText}
        </pre>
      )}

      {/* The pattern editor, open. It used to sit behind an "Advanced —"
          disclosure, which hid the box that answers "why is this file being
          copied" from everyone who had not already guessed it was there.
          Gated on a landed preview, not merely on `!readOnly`: while the
          source is unknown the editor would accept typing that a committed
          `.worktreeinclude` then silently outranks. */}
      {!!preview && !readOnly && (
        <div className="flex flex-col gap-2">
          <CodeTextarea
            aria-label="Files to copy patterns"
            value={draft}
            onChange={setDraft}
            description="One pattern per line, .gitignore syntax. Use ! to take something back out."
          />
          {patternStats.length > 0 && (
            <div className="flex flex-col gap-1">
              {patternStats.map((p) => (
                <div
                  key={`${p.line}:${p.raw}`}
                  className="flex items-center gap-2 text-xs"
                >
                  <span
                    className={cn(
                      "text-xxs rounded-full px-1.5 py-px font-semibold tabular-nums",
                      p.matchCount === null
                        ? "bg-bg2 text-fg3"
                        : p.matchCount === 0
                          ? "bg-red-bg text-red-fg"
                          : p.negate
                            ? "bg-bg2 text-fg3"
                            : "bg-green-bg text-green-fg",
                    )}
                  >
                    {p.matchCount === null
                      ? "—"
                      : p.negate
                        ? `−${p.matchCount}`
                        : p.matchCount}
                  </span>
                  <span className="text-fg1 font-mono">{p.raw}</span>
                  {p.matchCount === 0 && !p.negate && (
                    <span className="text-fg3">matches nothing</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

/** Indent per tree depth, as classes rather than a computed `paddingLeft` —
 *  the spacing stays on the Tailwind scale and out of an inline style. Depth
 *  is clamped to the last entry; nothing legible happens past five levels. */
const DEPTH_INDENT = ["", "w-4", "w-8", "w-12", "w-16"] as const;

/** A row's box state, in the primitive shape `Checkbox` takes. */
function checkedOf(row: CandidateTreeRow): CheckedState {
  const state = nodeCheck(row.node);
  return state === "mixed" ? "indeterminate" : state === "on";
}

/** Memoized on PRIMITIVES only, so a click that changes one row re-renders one
 *  row. Every toggle rebuilds the tree — that is what keeps the counts on the
 *  spine honest — so any prop carrying a node or a row object would miss on
 *  every row in the list, which is the identity `applyDraftOverlay` exists to
 *  preserve being thrown away one layer down. It also makes typing in the
 *  always-open pattern editor free: the parent re-renders per keystroke and
 *  every row here compares equal. */
export const TreeRowView = memo(function TreeRowView({
  path,
  label,
  depth,
  folder,
  branch,
  expanded,
  checked,
  locked,
  onToggle,
  onExpand,
}: {
  /** Repo-relative path — the row's identity, and what the callbacks name. */
  path: string;
  /** What to print: the node's own name, or its path relative to the closed
   *  folder that surfaced it. */
  label: string;
  /** Indent level. */
  depth: number;
  /** Reads as a directory: folder icon and a trailing slash. */
  folder: boolean;
  /** A folder the user can open (as opposed to one git already collapsed). */
  branch: boolean;
  expanded: boolean;
  checked: CheckedState;
  /** Nothing this box could change: a glob holds it, or the whole pane is
   *  read-only. */
  locked: boolean;
  onToggle: (path: string) => void;
  onExpand: (path: string) => void;
}) {
  const toggle = useCallback(() => onToggle(path), [onToggle, path]);
  const expand = useCallback(() => onExpand(path), [onExpand, path]);
  const indent = DEPTH_INDENT[Math.min(depth, DEPTH_INDENT.length - 1)];
  const text = cn(
    "min-w-0 truncate font-mono text-2xxs",
    checked === false ? "text-fg3" : "text-fg1",
    locked && "opacity-55",
  );
  const box = (
    <Checkbox
      checked={checked}
      disabled={locked}
      aria-label={path}
      onChange={toggle}
    />
  );

  return (
    <div
      className={cn(
        "border-border1 flex items-center gap-2 border-b px-3 py-2 last:border-b-0",
        !locked && "hover:bg-bg1-hover",
      )}
    >
      {depth > 0 && <span aria-hidden className={cn("shrink-0", indent)} />}
      {branch ? (
        <>
          <label className={locked ? "cursor-default" : "cursor-pointer"}>
            {box}
          </label>
          {/* The name opens the folder rather than ticking it: with a whole
              subtree behind one row, "show me what is in here" is the far
              likelier intent, and the box is right there for the other one. */}
          <button
            type="button"
            onClick={expand}
            aria-expanded={expanded}
            className="focus-visible:ring-highlighted-bright flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:ring-1 focus-visible:outline-none"
          >
            <ChevronRight
              className={cn(
                "text-fg3 size-3 shrink-0 transition-transform",
                expanded && "rotate-90",
              )}
              aria-hidden
            />
            <Folder className="text-fg3 size-3 shrink-0" aria-hidden />
            <span className={text}>{label}/</span>
          </button>
        </>
      ) : (
        <label
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            locked ? "cursor-default" : "cursor-pointer",
          )}
        >
          {box}
          {/* Two reserved columns — the chevron and the icon a folder row puts
              there — so every name in the list starts at the same x whether or
              not the thing beside it can be opened. Without them, expanding a
              folder shuffled the column its own children line up in. */}
          <span aria-hidden className="w-3 shrink-0" />
          {folder ? (
            <Folder className="text-fg3 size-3 shrink-0" aria-hidden />
          ) : (
            <span aria-hidden className="w-3 shrink-0" />
          )}
          <span className={text}>
            {label}
            {folder && "/"}
          </span>
        </label>
      )}
    </div>
  );
});

/** Warm a repo's preview on pointer/focus intent, so opening the Files tab
 *  paints rows instead of a spinner. Mirrors prefetchSettingsForRepo. */
export function prefetchFilesToCopyForRepo(
  bridge: Parameters<typeof bridgeFilesToCopyPreview>[0] | null,
  repoRoot: string,
): void {
  // Status, not just presence — mirrors prefetchSettingsForRepo. Warming
  // through a reconnecting bridge burns a queue slot and seeds an error
  // snapshot the pane would then render on open.
  if (!bridge || bridge.status !== "connected" || !repoRoot) return;
  void filesToCopyPreviewCache
    .load(
      filesToCopyPreviewKey(repoRoot, null),
      () => bridgeFilesToCopyPreview(bridge, repoRoot),
      { maxAgeMs: PREVIEW_MAX_AGE_MS },
    )
    .catch(() => {
      // The snapshot carries the error; the pane renders it on open.
    });
}

export type { FilesToCopyPreviewWire };
