// ──────────────────────────────────────────────────────────
// WorkingDirectoriesPopover — choose which folders exist in this workspace
// ──────────────────────────────────────────────────────────
//
// A searchable checklist of the repo's top-level TRACKED directories. Folders
// left unchecked are removed from the worktree via git sparse-checkout, so the
// agent, the terminal, the Files tab and the user's editor all stop seeing
// them at once. Nothing is destroyed — rechecking restores the folder from the
// object store.
//
// Why folders only, and why only tracked ones: cone-mode sparse-checkout can
// exclude directories but never top-level files (those are always present),
// and its patterns are matched against the index, so an untracked-only folder
// has nothing to exclude. Both constraints come from git, not from us — see
// `src/engine/git/sparse-checkout.ts`.
//
// The selection is a DRAFT until Save. Applying rewrites the working tree, so
// it must be one deliberate action rather than a write per checkbox.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderOpen } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/zeros/ui/primitives/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/zeros/ui/primitives/popover";
import { Button } from "@/zeros/ui/primitives/button";
import { Tooltip } from "@/zeros/ui/primitives/tooltip";
import { toast } from "@/zeros/ui/primitives/elements";
import {
  isWorkspaceOpStillRunning,
  listWorkingDirectories,
  setWorkingDirectories,
  WORKING_DIRECTORIES_UNSUPPORTED_COPY,
  type WorkingDirectoriesWire,
} from "@/native/git";
import { isNativeRuntime } from "@/native/runtime";
import { triggerGitRefresh, useGitRefreshKey } from "../use-git-refresh-key";

export interface WorkingDirectoriesPopoverProps {
  /** Worktree path — the engine resolves it to the workspace. Null/undefined
   *  while a blank File tab has no workspace yet; the control hides. */
  cwd: string | null | undefined;
  /** The same git target the host surface subscribes its refresh key with.
   *  Needed because the engine's own DB_CHANGED for this op is SCOPED to the
   *  workspace id — a cwd-only subscriber never hears it, which is exactly the
   *  signal a save whose reply was lost has to wait for. */
  workspaceId?: string | null;
}

/** Whether this surface can show the picker at all.
 *
 *  Both engine ops are local-only (off the remote allowlist), so on a paired
 *  web/phone client every click would dead-end in an empty list. Exported
 *  because a HOST has to know too: rendering `<WorkingDirectoriesPopover>` and
 *  letting it return null still hands the host a non-null React element, so a
 *  layout that reserves room for it (the Files tree's search row) would reserve
 *  that room for nothing. */
export function canPickWorkingDirectories(
  cwd: string | null | undefined,
): boolean {
  return !!cwd && isNativeRuntime();
}

/** Same set, ignoring order. */
function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((d) => seen.has(d));
}

export function WorkingDirectoriesPopover({
  cwd,
  workspaceId,
}: WorkingDirectoriesPopoverProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WorkingDirectoriesWire | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // Bumps when this worktree's files/git state may have moved. While the
  // popover is open that means the list on screen could be stale — most
  // importantly after a save whose RESPONSE was lost (below), where the
  // engine's own DB_CHANGED is the only thing that says the work landed.
  const gitRefresh = useGitRefreshKey(cwd, workspaceId);

  // Drop a snapshot belonging to a different worktree the moment cwd changes.
  // Without this, switching workspaces while the popover is closed leaves the
  // PREVIOUS repo's folder list in state; reopening paints it, and a Save
  // before the refetch lands would send the old repo's directory names to the
  // new worktree. Keyed state, cleared by its owner — not repaired later.
  const loadedFor = useRef<string | null>(null);
  // The selection the draft was last synced FROM. `null` means "no draft yet",
  // so the next read adopts wholesale; otherwise a draft that has diverged from
  // it is an unsaved user edit and must survive a background re-read.
  const draftBaseline = useRef<readonly string[] | null>(null);
  const draftRef = useRef<readonly string[]>(draft);
  draftRef.current = draft;
  if (loadedFor.current !== (cwd ?? null)) {
    loadedFor.current = cwd ?? null;
    draftBaseline.current = null;
    if (state !== null) {
      setState(null);
      setDraft([]);
    }
  }

  // Load on open, not on mount: this runs three git commands, and a File tab
  // is one of the most frequently mounted surfaces in the app.
  //
  // Re-runs on `gitRefresh` too, which is what makes a save whose reply was
  // lost self-heal: the engine finishes, broadcasts DB_CHANGED (this op is in
  // LONG_LIFECYCLE_OPS precisely so the originator hears it), and the list
  // repaints with what actually landed instead of sitting on a stale draft.
  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await listWorkingDirectories(cwd);
        if (cancelled) return;
        setState(next);
        // An agent edit or terminal command can bump `gitRefresh` at any
        // moment; adopting the engine's list unconditionally would wipe a
        // half-made selection under the user's cursor.
        const editing =
          draftBaseline.current !== null &&
          !sameSelection(draftRef.current, draftBaseline.current);
        if (!editing) {
          draftBaseline.current = next.included;
          setDraft(next.included);
        }
      } catch {
        // Leave the last confirmed snapshot in place rather than blanking it —
        // a transient bridge hiccup must not present as "no folders".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cwd, gitRefresh]);

  // Frozen while a save is in flight. The request carries the draft captured
  // when Save was clicked, and the response overwrites `draft` with what the
  // engine actually applied — so a toggle made mid-flight would be silently
  // discarded and then confirmed with a success toast.
  const toggle = useCallback(
    (dir: string) => {
      if (saving) return;
      setDraft((prev) =>
        prev.includes(dir) ? prev.filter((d) => d !== dir) : [...prev, dir],
      );
    },
    [saving],
  );

  const dirty = useMemo(
    () => (state ? !sameSelection(draft, state.included) : false),
    [draft, state],
  );

  const save = useCallback(async () => {
    if (!cwd || !state || saving) return;
    setSaving(true);
    try {
      const result = await setWorkingDirectories(cwd, draft);
      const hidden = result.all.length - result.included.length;
      // Surface refusals rather than letting the folder look excluded while
      // its files are still on disk — git leaves anything with local edits.
      if (result.leftBehind && result.leftBehind.length > 0) {
        toast.warning(
          `${result.leftBehind.length} file(s) kept — uncommitted changes in ${result.leftBehind
            .slice(0, 2)
            .join(", ")}`,
        );
      } else {
        toast.success(
          hidden === 0
            ? "All folders visible"
            : `${hidden} folder${hidden === 1 ? "" : "s"} hidden`,
        );
      }
      setState(result);
      draftBaseline.current = result.included;
      setDraft(result.included);
      // Coarse refresh (no cwd argument) on purpose. A cwd-scoped bump only
      // wakes subscribers keyed on that exact path, but a chat rooted in a
      // worktree SUBDIRECTORY has a different cwd from `workspace.path` — so
      // the Changes badge, line counts and Review tab would keep serving
      // pre-rewrite numbers. A whole-worktree rewrite warrants invalidating
      // everything.
      triggerGitRefresh();
      setOpen(false);
    } catch (err) {
      // "Request timeout: WORKSPACE_REQUEST" / "…: engine disconnected" mean
      // only the REPLY was lost — the engine is still applying the cone (or
      // already has). Reporting that as a failure is what made a working save
      // look broken. Say what's true, keep the popover open, and let the
      // engine's DB_CHANGED bump `gitRefresh` and re-read the real state.
      if (isWorkspaceOpStillRunning(err)) {
        toast.warning("Still applying the folder change…");
      } else {
        toast.error(
          err instanceof Error
            ? err.message
            : "Couldn't update working folders",
        );
      }
    } finally {
      setSaving(false);
    }
  }, [cwd, state, draft, saving]);

  if (!canPickWorkingDirectories(cwd)) return null;

  const dirs = state?.all ?? [];
  // Only advertise the control once we know it can work here. An unsupported
  // checkout (no commits yet) would otherwise offer an empty, unsaveable list.
  const unsupported = state !== null && !state.supported;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label="Working folders">
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            // Always --fg2 at rest — no brightening while the worktree is
            // sparse. The state it would encode isn't knowable here anyway
            // (the list is fetched on OPEN, not on mount, because a File tab is
            // one of the most frequently mounted surfaces and this costs three
            // git invocations), so a conditional tint would only ever appear
            // AFTER the first open. The checkmarks in the list are where the
            // selection lives.
            className="text-fg2 hover:text-fg1 size-6 shrink-0"
            aria-label="Choose working folders"
          >
            <FolderOpen className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      {/* Opens RIGHTWARD from the trigger (align start), and only slides back
          left when the window edge would clip it — Radix's collision shift,
          which is on by default. `align="end"` was correct while the trigger
          lived at the right end of the expanded tree's filter row (flush with
          the seam), but the collapsed header puts it at the LEFT of a
          full-width viewer row, where an end-aligned panel hangs off the
          trigger and spills over the chat column. collisionPadding keeps a
          gutter so the flipped position never kisses the window edge. */}
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-[300px] p-0"
      >
        <Command>
          <CommandInput placeholder="Search folders to include or exclude…" />
          <CommandList className="max-h-[280px]">
            {unsupported ? (
              <CommandEmpty>
                {
                  WORKING_DIRECTORIES_UNSUPPORTED_COPY[
                    state.unsupportedReason ?? "no-commits"
                  ]
                }
              </CommandEmpty>
            ) : (
              <>
                <CommandEmpty>No folders found.</CommandEmpty>
                {/* No group heading: the input above already says these are
                    folders to include or exclude, and the popover has exactly
                    one group — a "Working folders" label only repeated the
                    trigger's tooltip and cost a row of vertical space. */}
                <CommandGroup>
                  {dirs.map((dir) => {
                    const on = draft.includes(dir);
                    return (
                      <CommandItem
                        key={dir}
                        value={dir}
                        onSelect={() => toggle(dir)}
                      >
                        {on ? (
                          <Check className="text-fg1 size-3.5 shrink-0" />
                        ) : (
                          <span className="size-3.5 shrink-0" />
                        )}
                        <span className="truncate">{dir}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
        {!unsupported && dirs.length > 0 && (
          <div className="border-border2 flex items-center gap-3 border-t px-3 py-2">
            {/* Frozen while a save is in flight, for the same reason `toggle`
                is: the response overwrites `draft`, so a click here would be
                silently discarded and then confirmed with a success toast. */}
            <button
              type="button"
              className="text-fg2 hover:text-fg1 text-xs disabled:opacity-40"
              disabled={saving || draft.length === dirs.length}
              onClick={() => setDraft(dirs)}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-fg2 hover:text-fg1 text-xs disabled:opacity-40"
              disabled={saving || draft.length === 0}
              onClick={() => setDraft([])}
            >
              Deselect all
            </button>
            <div className="flex-1" />
            <Button
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
