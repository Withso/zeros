// ──────────────────────────────────────────────────────────
// Files to copy — the repo page's per-project seeding pane
// ──────────────────────────────────────────────────────────
//
// A new workspace branches from the remote, so it holds TRACKED files only:
// `.env`, local config and certificates are all missing and the project won't
// run. This pane picks what rides along.
//
// It is deliberately a CHECKLIST first. The engine has already scanned the
// repo by the time this paints, so the pane can show the real ignored files —
// with sizes — instead of asking someone who has never written a `.gitignore`
// to type `.env*` into an empty box and hope. Patterns are still there, one
// disclosure down, and both editors write the same setting.
//
// Scope is per-repo, full stop. "Which files does this project need" has no
// sensible cross-project answer, so there is no global/per-project switch —
// saving always writes this repo's own `.zeros/settings.local.toml`.
//
// All pattern/row logic lives in files-to-copy-model.ts (pure, unit-tested);
// this file is the wiring and the markup.
// ──────────────────────────────────────────────────────────

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileText,
  Folder,
  Info,
  KeyRound,
  RotateCw,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";

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
import { Button, CodeTextarea } from "../ui/primitives";
import { cn } from "../ui/cn";
import {
  applyDraftOverlay,
  baseFor,
  buildCandidateRows,
  canMaterialize,
  formatBytes,
  formatPatternText,
  groupCandidates,
  materializePatterns,
  parsePatternText,
  sameList,
  summarize,
  summaryText,
  togglePattern,
  type CandidateRow,
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
  /** True while what's on screen predates the patterns now in the box. */
  const previewStale = !read.data && !!preview;

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
          // what was asked. Use the reset action to go back to the default.
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

  /** Drop this project's own list and inherit again (the built-in `.env*`, or
   *  a hand-edited global list). This is the ONLY thing that writes `null`. */
  const resetToDefault = useCallback(() => {
    setPending(null);
    void writePatterns({ file_include_globs: null }).catch(() => {
      toast.error("Couldn't reset which files to copy");
    });
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
    () => applyDraftOverlay(rows, overlayBase, effective ?? []),
    [rows, overlayBase, effective],
  );
  const groups = useMemo(() => groupCandidates(liveRows), [liveRows]);
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
  const onToggle = useCallback(
    (row: CandidateRow) => {
      if (!preview || !editable || row.locked) return;
      // Composed on the LIVE list, so a second click inside the debounce
      // window builds on the first instead of discarding it.
      const base = baseFor(preview, effectiveRef.current);
      setPending(togglePattern(base, row.path, !row.selected));
    },
    [preview, editable],
  );

  const openWorktreeInclude = useCallback(() => {
    if (preview?.sourcePath) void revealInFinder(preview.sourcePath);
  }, [preview?.sourcePath]);

  // Only a COMPLETE scan gets to state a total. "0 files" and "we couldn't
  // look" are different answers, and the pane must never print the first when
  // it means the second.
  const summary = preview?.complete ? summarize(preview) : null;
  // Scanning is only worth saying when there is nothing to look at yet. A
  // refresh behind existing rows stays silent — the rows are still true.
  const firstLoad = (read.loading || previewStale) && !preview;
  // Nothing to render and nothing in flight: the bridge is down, or the read
  // failed. Distinct from "this project has no ignored files".
  const unavailable = !preview && !firstLoad;

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
      ) : groups.length === 0 ? (
        <div className="border-border2 bg-bg1-highlight flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center">
          <div className="text-fg1 text-[14px] font-medium">
            Nothing needs copying
          </div>
          <div className="text-fg2 max-w-[44ch] text-xs">
            Zeros found no ignored files in this project. New workspaces will
            already be complete.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group) => (
            <div
              key={group.id}
              className="border-border1 overflow-hidden rounded-lg border"
            >
              <div className="border-border1 bg-bg1-highlight flex items-center gap-2 border-b px-3 py-2">
                <GroupIcon id={group.id} />
                <span className="text-fg1 text-xs font-medium">
                  {group.label}
                </span>
                {group.recommended && (
                  <span className="bg-green-bg text-green-fg rounded-full px-2 py-px text-[10px] font-semibold">
                    Recommended
                  </span>
                )}
                <span className="text-fg3 ml-auto text-[11px] tabular-nums">
                  {group.rows.length}{" "}
                  {group.rows.length === 1 ? "item" : "items"}
                </span>
              </div>
              {group.rows.map((row) => (
                <CandidateRowView
                  key={row.path}
                  row={row}
                  disabled={!editable}
                  onToggle={onToggle}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Matched but already tracked. Said out loud rather than dropped: a
          pattern whose matches silently vanish reads as broken, and "why isn't
          my file copied" has to have an answer. */}
      {preview && preview.trackedMatches.length > 0 && (
        <p className="text-fg3 m-0 text-xs">
          {preview.trackedMatches.length === 1
            ? "1 match is already tracked by Git"
            : `${preview.trackedMatches.length} matches are already tracked by Git`}
          , so every workspace has{" "}
          {preview.trackedMatches.length === 1 ? "it" : "them"} already:{" "}
          <span className="text-fg2 font-mono text-[11px]">
            {preview.trackedMatches.slice(0, 3).join(", ")}
            {preview.trackedMatches.length > 3 &&
              ` +${preview.trackedMatches.length - 3} more`}
          </span>
        </p>
      )}

      {/* Rescan is anchored to the pane, not to a successful scan: it used to
          render only alongside a summary, so the states that most need a retry
          were the ones that didn't offer one. */}
      {!!preview && (
        <div className="border-border1 flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-fg2 text-xs">
            {summary ? (
              <>
                <span className="text-fg1 font-medium">
                  {summaryText(summary)}
                </span>{" "}
                will be copied from{" "}
                <span className="text-brown-primary font-mono text-[11px]">
                  {preview.rootPath}
                </span>
              </>
            ) : (
              <span className="text-fg3">
                Couldn&rsquo;t work out what would be copied
              </span>
            )}
          </span>
          {savedGlobs !== null && !readOnly && (
            <button
              type="button"
              onClick={resetToDefault}
              className="text-fg3 hover:text-fg1 text-xs underline underline-offset-2"
            >
              Reset to default
            </button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={read.refresh}
            disabled={!connected || read.refreshing}
          >
            <RotateCw
              className={cn(
                "size-3",
                (read.refreshing || previewStale) && "animate-spin",
              )}
              aria-hidden
            />
            Rescan
          </Button>
        </div>
      )}

      {/* Read-only patterns for the committed-file case. The list above is the
          answer either way; the patterns that produced it stay one click down
          rather than being dimmed into illegibility behind an explanation. */}
      {readOnly && preview?.sourceText !== undefined && (
        <div className="border-border1 border-t pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-fg2 hover:text-fg1 flex items-center gap-1.5 text-xs"
            aria-expanded={advancedOpen}
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform",
                advancedOpen && "rotate-90",
              )}
              aria-hidden
            />
            Show patterns
          </button>
          {advancedOpen && (
            <pre className="bg-bg1-highlight text-fg2 mt-2 max-h-64 overflow-auto rounded-md px-3 py-2 font-mono text-[11px] leading-relaxed">
              {preview.sourceText}
            </pre>
          )}
        </div>
      )}

      {/* Gated on a landed preview, not merely on `!readOnly`: while the source
          is unknown the editor would accept typing that a committed
          `.worktreeinclude` then silently outranks. */}
      {!!preview && !readOnly && (
        <div className="border-border1 border-t pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="text-fg2 hover:text-fg1 flex items-center gap-1.5 text-xs"
            aria-expanded={advancedOpen}
          >
            <ChevronRight
              className={cn(
                "size-3 transition-transform",
                advancedOpen && "rotate-90",
              )}
              aria-hidden
            />
            Advanced — use file patterns instead
          </button>
          {advancedOpen && (
            <div className="mt-2 flex flex-col gap-2">
              <CodeTextarea
                aria-label="Files to copy patterns"
                value={draft}
                onChange={setDraft}
                description="One pattern per line, .gitignore syntax. Use ! to take something back out."
              />
              {preview && preview.patterns.length > 0 && (
                <div className="flex flex-col gap-1">
                  {preview.patterns.map((p) => (
                    <div
                      key={`${p.line}:${p.raw}`}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums",
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
        </div>
      )}

      {/* Bottom-anchored inline toasts. They sit UNDER the list they are
          talking about: at the top they would push the file rows — the thing
          the pane exists to show — down the screen every time one appears. */}
      {preview && !preview.complete && (
        <InlineToast
          icon={<AlertTriangle className="size-3.5 shrink-0" aria-hidden />}
          action={
            <button
              type="button"
              onClick={read.refresh}
              className="shrink-0 font-medium underline underline-offset-2"
            >
              Try again
            </button>
          }
        >
          <b className="font-semibold">Couldn&rsquo;t check this project.</b>{" "}
          <code className="font-mono">{preview.rootPath}</code> isn&rsquo;t
          readable right now, so this list may be out of date. Your selection is
          saved and will still be used.
        </InlineToast>
      )}
      {/* Suppressed while `complete` is false: the scan-failure warning is the
          same fact the toast above already states, in engine words. */}
      {preview?.complete &&
        preview.warnings.map((warning, i) => (
          <InlineToast
            key={`${i}:${warning}`}
            icon={<AlertTriangle className="size-3.5 shrink-0" aria-hidden />}
          >
            {warning.replace(/^files-to-copy:\s*/, "")}
          </InlineToast>
        ))}
    </SettingsSection>
  );
}

function InlineToast({
  icon,
  action,
  children,
}: {
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // Container pair, per the palette rule: text and icons on a `--*-bg`
    // surface use that family's `--*-fg`, never the vivid primary.
    <div className="text-yellow-fg bg-yellow-bg flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed">
      {icon}
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  );
}

function GroupIcon({ id }: { id: "env" | "config" | "other" }) {
  if (id === "env")
    return (
      <span className="bg-green-bg text-green-fg grid size-5 shrink-0 place-items-center rounded">
        <KeyRound className="size-3" aria-hidden />
      </span>
    );
  if (id === "config")
    return (
      <span className="bg-blue-bg text-blue-fg grid size-5 shrink-0 place-items-center rounded">
        <Settings2 className="size-3" aria-hidden />
      </span>
    );
  return (
    <span className="bg-bg2 text-fg3 grid size-5 shrink-0 place-items-center rounded">
      <FileText className="size-3" aria-hidden />
    </span>
  );
}

/** Memoized: applyDraftOverlay preserves the identity of rows the user did not
 *  touch, so a click re-renders one row rather than the whole list. */
const CandidateRowView = memo(function CandidateRowView({
  row,
  disabled,
  onToggle,
}: {
  row: CandidateRow;
  disabled: boolean;
  onToggle: (row: CandidateRow) => void;
}) {
  const locked = disabled || row.locked;
  return (
    <label
      className={cn(
        "border-border1 flex items-center gap-2.5 border-b px-3 py-2 last:border-b-0",
        locked ? "cursor-default" : "hover:bg-bg1-hover cursor-pointer",
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={row.selected}
        disabled={locked}
        onChange={() => onToggle(row)}
      />
      <span
        aria-hidden
        className={cn(
          "grid size-3.5 shrink-0 place-items-center rounded border",
          row.selected
            ? "bg-inverted-bg border-inverted-bg text-inverted-fg"
            : "border-border4",
          locked && "opacity-55",
        )}
      >
        {row.selected && <Check className="size-2.5" strokeWidth={3.5} />}
      </span>
      <span
        className={cn(
          "text-fg1 min-w-0 truncate font-mono text-[11px]",
          !row.selected && "text-fg3",
          locked && "opacity-55",
        )}
      >
        {row.path}
        {row.isDir && "/"}
      </span>
      {row.isDir && (
        <span className="text-fg3 shrink-0">
          <Folder className="size-3" aria-hidden />
        </span>
      )}
      {row.notIgnored && (
        <span className="bg-yellow-bg text-yellow-fg shrink-0 rounded-full px-2 py-px text-[10px] font-semibold">
          Git isn&rsquo;t ignoring this
        </span>
      )}
      {/* Named only when one line can be responsible. With several globs in
          play the pane used to print the first one regardless, sending people
          to edit a pattern that had nothing to do with this row. */}
      {row.locked && (
        <span className="bg-bg2 text-fg3 shrink-0 rounded-full px-2 py-px text-[10px] font-semibold">
          {row.lockedBy ? `from ${row.lockedBy}` : "from a pattern"}
        </span>
      )}
      <span className="text-fg3 ml-auto shrink-0 text-[10px] tabular-nums">
        {formatBytes(row.bytes)}
      </span>
    </label>
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
